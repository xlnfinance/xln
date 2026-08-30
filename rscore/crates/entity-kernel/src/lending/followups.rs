use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{AccountTx, LendingAction, LendingTermId, TokenId};

use crate::EntityKernelError;
use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;

use super::{LendingLoan, LendingLoanStatus, LendingPoolPosition, LendingPoolStatus, LendingState};

const BPS_DENOMINATOR: u32 = 10_000;

fn term_ms(term: LendingTermId) -> u64 {
    match term {
        LendingTermId::OneHour => 3_600_000,
        LendingTermId::OneDay => 86_400_000,
        LendingTermId::OneMonth => 2_592_000_000,
    }
}

fn interest(principal: &BigInt, interest_bps: u16) -> BigInt {
    if principal <= &BigInt::from(0) || interest_bps == 0 {
        return BigInt::from(0);
    }
    let raw = principal * BigInt::from(interest_bps) / BigInt::from(BPS_DENOMINATOR);
    if raw == BigInt::from(0) {
        BigInt::from(1)
    } else {
        raw
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    output
}

fn loan_id(
    hub: &str,
    borrower: &str,
    token_id: u64,
    amount: &BigInt,
    term: LendingTermId,
    opened_at: u64,
    request_id: &str,
) -> String {
    let preimage = format!(
        "loan|{hub}|{borrower}|{token_id}|{amount}|{}|{opened_at}|{request_id}",
        term.wire_name()
    );
    format!(
        "loan-{}",
        &hex(&Keccak256::digest(preimage.as_bytes()))[..16]
    )
}

pub(super) fn require_empty_outputs(
    transition: &crate::CommittedAccountTransition,
) -> Result<(), EntityKernelError> {
    if transition.outputs.is_empty() {
        Ok(())
    } else {
        Err(EntityKernelError::output("LENDING_TX_OUTPUTS"))
    }
}

pub(super) fn projected_credit(
    view: &LocalAccountFinancialView,
    account_id: &str,
    token_id: TokenId,
    queued: &[TargetedAccountTx],
) -> BigInt {
    let mut value = view
        .owner_peer_credit_limit
        .get(&token_id)
        .cloned()
        .unwrap_or_else(|| BigInt::from(0));
    for (_, tx) in queued.iter().filter(|(target, _)| target == account_id) {
        match tx {
            AccountTx::SetCreditLimit {
                token_id: tx_token,
                amount,
            } if tx_token == &token_id => value = amount.clone(),
            AccountTx::LendingCredit {
                token_id: tx_token,
                credit_limit,
                ..
            } if tx_token == &token_id => value = credit_limit.clone(),
            _ => {}
        }
    }
    value
}

fn best_pool(
    lending: &LendingState,
    token_id: u64,
    amount: &BigInt,
    term: LendingTermId,
    max_interest_bps: i64,
) -> Option<LendingPoolPosition> {
    lending
        .pools()
        .filter(|pool| {
            u64::from(pool.token_id) == token_id
                && pool.status == LendingPoolStatus::Open
                && pool.term_id == term
                && &pool.available_amount >= amount
                && i64::from(pool.interest_bps) <= max_interest_bps
        })
        .min_by(|left, right| {
            left.interest_bps
                .cmp(&right.interest_bps)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.position_id.cmp(&right.position_id))
        })
        .cloned()
}

pub(super) fn apply_fund(
    state: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    counterparty: &str,
    hub: &str,
    now: u64,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingFund {
        position_id,
        lender_entity_id,
        token_id,
        amount,
        term_id,
        interest_bps,
        ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != lender_entity_id || proposer != counterparty {
        return Err(EntityKernelError::lending("FUND_PROPOSER_MISMATCH"));
    }
    if state.pool(position_id).is_some() {
        return Err(EntityKernelError::lending("POSITION_ALREADY_EXISTS"));
    }
    let interest_bps =
        u16::try_from(*interest_bps).map_err(|_| EntityKernelError::lending("INTEREST_BPS"))?;
    state.put_pool(LendingPoolPosition {
        position_id: position_id.clone(),
        hub_entity_id: hub.to_string(),
        lender_entity_id: proposer.to_string(),
        token_id: token_id.get(),
        principal_amount: amount.clone(),
        available_amount: amount.clone(),
        borrowed_amount: BigInt::from(0),
        interest_bps,
        term_id: *term_id,
        term_ms: term_ms(*term_id),
        created_at: now,
        updated_at: now,
        status: LendingPoolStatus::Open,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "the pure lending transition keeps financial authority and output sinks explicit"
)]
pub(super) fn apply_borrow(
    state: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    counterparty: &str,
    hub: &str,
    now: u64,
    account_id: &str,
    view: &LocalAccountFinancialView,
    queued: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingBorrowRequest {
        request_id,
        borrower_entity_id,
        token_id,
        amount,
        term_id,
        max_interest_bps,
        ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != borrower_entity_id || proposer != counterparty {
        return Err(EntityKernelError::lending("BORROW_PROPOSER_MISMATCH"));
    }
    let mut pool = best_pool(state, *token_id, amount, *term_id, *max_interest_bps)
        .ok_or_else(|| EntityKernelError::lending("LIQUIDITY_UNAVAILABLE"))?;
    let loan_id = loan_id(hub, proposer, *token_id, amount, *term_id, now, request_id);
    if state.loan(&loan_id).is_some() {
        return Err(EntityKernelError::lending("LOAN_ALREADY_EXISTS"));
    }
    let token =
        TokenId::new(u32::try_from(*token_id).map_err(|_| EntityKernelError::lending("TOKEN_ID"))?)
            .map_err(|_| EntityKernelError::lending("TOKEN_ID"))?;
    let interest_amount = interest(amount, pool.interest_bps);
    let repayment_amount = amount + &interest_amount;
    pool.available_amount -= amount;
    pool.borrowed_amount += amount;
    pool.updated_at = now;
    state.put_pool(pool.clone())?;
    state.put_loan(LendingLoan {
        request_id: request_id.clone(),
        loan_id: loan_id.clone(),
        hub_entity_id: hub.to_string(),
        borrower_entity_id: proposer.to_string(),
        lender_entity_id: pool.lender_entity_id,
        position_id: pool.position_id,
        token_id: token.get(),
        principal_amount: amount.clone(),
        interest_amount,
        repayment_amount,
        repaid_amount: BigInt::from(0),
        interest_bps: pool.interest_bps,
        term_id: pool.term_id,
        term_ms: pool.term_ms,
        opened_at: now,
        due_at: now
            .checked_add(pool.term_ms)
            .ok_or_else(|| EntityKernelError::lending("DUE_AT_OVERFLOW"))?,
        updated_at: now,
        status: LendingLoanStatus::Opening,
    })?;
    let credit_limit = projected_credit(view, account_id, token, queued) + amount;
    queued.push((
        proposer.to_string(),
        AccountTx::LendingCredit {
            action: LendingAction::Grant,
            loan_id,
            hub_entity_id: hub.to_string(),
            borrower_entity_id: proposer.to_string(),
            token_id: token,
            credit_limit,
        },
    ));
    Ok(())
}

pub(super) fn apply_credit(
    state: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    hub: &str,
    now: u64,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingCredit {
        action, loan_id, ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != hub {
        return Err(EntityKernelError::lending("CREDIT_PROPOSER_MISMATCH"));
    }
    let mut loan = state
        .loan(loan_id)
        .cloned()
        .ok_or_else(|| EntityKernelError::lending("CREDIT_LOAN_MISSING"))?;
    match action {
        LendingAction::Grant if loan.status == LendingLoanStatus::Opening => {
            loan.status = LendingLoanStatus::Active;
            loan.updated_at = now;
            state.put_loan(loan)
        }
        LendingAction::Revoke if loan.status == LendingLoanStatus::Closing => {
            let mut pool = state
                .pool(&loan.position_id)
                .cloned()
                .ok_or_else(|| EntityKernelError::lending("POOL_MISSING_FOR_LOAN"))?;
            if pool.borrowed_amount < loan.principal_amount {
                return Err(EntityKernelError::lending("POOL_BORROWED_UNDERFLOW"));
            }
            loan.repaid_amount = loan.repayment_amount.clone();
            loan.status = LendingLoanStatus::Repaid;
            loan.updated_at = now;
            pool.borrowed_amount -= &loan.principal_amount;
            pool.available_amount += &loan.repayment_amount;
            pool.updated_at = now;
            state.put_loan(loan)?;
            state.put_pool(pool)
        }
        LendingAction::Grant => Err(EntityKernelError::lending("GRANT_STATUS_INVALID")),
        LendingAction::Revoke => Err(EntityKernelError::lending("REVOKE_STATUS_INVALID")),
    }
}
