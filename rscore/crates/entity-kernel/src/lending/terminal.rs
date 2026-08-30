use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, LendingAction, TokenId};

use crate::EntityKernelError;
use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;

use super::followups::projected_credit;
use super::{LendingLoanStatus, LendingPoolStatus, LendingState};

#[expect(
    clippy::too_many_arguments,
    reason = "the pure lending transition keeps financial authority and output sinks explicit"
)]
pub(super) fn apply_repay(
    lending: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    counterparty: &str,
    hub: &str,
    now: u64,
    view: &LocalAccountFinancialView,
    queued: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingRepay {
        loan_id,
        borrower_entity_id,
        token_id,
        amount,
        ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != borrower_entity_id || proposer != counterparty {
        return Err(EntityKernelError::lending("REPAY_PROPOSER_MISMATCH"));
    }
    let mut loan = lending
        .loan(loan_id)
        .cloned()
        .filter(|loan| loan.status == LendingLoanStatus::Active)
        .ok_or_else(|| EntityKernelError::lending("REPAY_LOAN_NOT_ACTIVE"))?;
    let remaining = &loan.repayment_amount - &loan.repaid_amount;
    if loan.borrower_entity_id != proposer
        || loan.token_id != token_id.get()
        || amount != &remaining
    {
        return Err(EntityKernelError::lending("REPAYMENT_MISMATCH"));
    }
    loan.status = LendingLoanStatus::Closing;
    loan.updated_at = now;
    lending.put_loan(loan.clone())?;
    let current = projected_credit(view, counterparty, *token_id, queued);
    let credit_limit = if current > loan.principal_amount {
        current - &loan.principal_amount
    } else {
        BigInt::from(0)
    };
    queued.push((
        proposer.to_string(),
        AccountTx::LendingCredit {
            action: LendingAction::Revoke,
            loan_id: loan.loan_id,
            hub_entity_id: hub.to_string(),
            borrower_entity_id: proposer.to_string(),
            token_id: *token_id,
            credit_limit,
        },
    ));
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "the pure lending transition keeps financial authority and output sinks explicit"
)]
pub(super) fn apply_close_request(
    lending: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    counterparty: &str,
    hub: &str,
    now: u64,
    view: &LocalAccountFinancialView,
    queued: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingCloseRequest {
        position_id,
        lender_entity_id,
        ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != lender_entity_id || proposer != counterparty {
        return Err(EntityKernelError::lending("CLOSE_PROPOSER_MISMATCH"));
    }
    let mut pool = lending
        .pool(position_id)
        .cloned()
        .filter(|pool| pool.status == LendingPoolStatus::Open && pool.lender_entity_id == proposer)
        .ok_or_else(|| EntityKernelError::lending("CLOSE_POSITION_NOT_OPEN"))?;
    if pool.borrowed_amount != BigInt::from(0) {
        return Err(EntityKernelError::lending("CLOSE_ACTIVE_LOANS"));
    }
    if pool.available_amount == BigInt::from(0) {
        pool.status = LendingPoolStatus::Closed;
        pool.updated_at = now;
        return lending.put_pool(pool);
    }
    let token = TokenId::new(u32::from(pool.token_id))
        .map_err(|_| EntityKernelError::lending("TOKEN_ID"))?;
    let capacity = view
        .owner_out_capacity
        .get(&token)
        .cloned()
        .unwrap_or_else(|| BigInt::from(0));
    if capacity < pool.available_amount {
        return Err(EntityKernelError::lending("CLOSE_PAYOUT_CAPACITY"));
    }
    pool.status = LendingPoolStatus::Closing;
    pool.updated_at = now;
    lending.put_pool(pool.clone())?;
    queued.push((
        proposer.to_string(),
        AccountTx::LendingClosePayout {
            position_id: pool.position_id,
            hub_entity_id: hub.to_string(),
            lender_entity_id: proposer.to_string(),
            token_id: token,
            amount: pool.available_amount,
        },
    ));
    Ok(())
}

pub(super) fn apply_close_payout(
    lending: &mut LendingState,
    tx: &AccountTx,
    proposer: &str,
    hub: &str,
    now: u64,
) -> Result<(), EntityKernelError> {
    let AccountTx::LendingClosePayout {
        position_id,
        lender_entity_id,
        token_id,
        amount,
        ..
    } = tx
    else {
        unreachable!()
    };
    if proposer != hub {
        return Err(EntityKernelError::lending("PAYOUT_PROPOSER_MISMATCH"));
    }
    let mut pool = lending
        .pool(position_id)
        .cloned()
        .filter(|pool| pool.status == LendingPoolStatus::Closing)
        .ok_or_else(|| EntityKernelError::lending("PAYOUT_POSITION_NOT_CLOSING"))?;
    if pool.lender_entity_id.as_str() != lender_entity_id
        || pool.token_id != token_id.get()
        || &pool.available_amount != amount
    {
        return Err(EntityKernelError::lending("PAYOUT_MISMATCH"));
    }
    pool.available_amount = BigInt::from(0);
    pool.status = LendingPoolStatus::Closed;
    pool.updated_at = now;
    lending.put_pool(pool)
}
