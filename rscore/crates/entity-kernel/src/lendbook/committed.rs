use super::state::*;
use crate::local_financial::LocalAccountFinancialView;
use crate::{
    CommittedAccountTransition, EntityFrameEvent, EntityKernelError as E, EntityStateSlice,
    OrderedAccountCommit,
};
use sha3::{Digest, Keccak256};
use xln_rscore_engine::{
    AccountTx,
    lending::{interest, term_ms},
};
use xln_rscore_protocol::CanonicalValue as V;
fn update(v: &mut V, status: &str, time: u64) {
    set(v, "status", s(status));
    set(v, "updatedAt", n(time));
}
pub(crate) fn apply_committed_lending_followup(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    transition: &CommittedAccountTransition,
    view: Option<&LocalAccountFinancialView>,
    out: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<bool, E> {
    let tx = &transition.tx;
    let hub = match tx {
        AccountTx::LendingFund { hub_entity_id, .. }
        | AccountTx::LendingRate { hub_entity_id, .. }
        | AccountTx::LendingBorrowRequest { hub_entity_id, .. }
        | AccountTx::LendingDisburse { hub_entity_id, .. }
        | AccountTx::LendingRepay { hub_entity_id, .. }
        | AccountTx::LendingCloseRequest { hub_entity_id, .. }
        | AccountTx::LendingClosePayout { hub_entity_id, .. } => hub_entity_id,
        _ => return Ok(false),
    };
    if !state.profile.is_hub || hub != &state.entity_id {
        return Ok(true);
    }
    let view = view.ok_or_else(|| err(format!("LENDING_ACCOUNT_MISSING:{}", commit.account_id)))?;
    let now = state.timestamp.max(commit.frame_timestamp);
    let time = commit.frame_timestamp;
    let book = state.lending.get_or_insert_with(Default::default);
    match tx {
        AccountTx::LendingFund {
            position_id,
            lender_entity_id,
            token_id,
            amount,
            term_id,
            interest_bps,
            ..
        } => {
            if lender_entity_id != &commit.account_id {
                return Err(err(format!("LENDING_FUND_PROPOSER_MISMATCH:{position_id}")));
            }
            if find(&book.savings, position_id).is_some() {
                return Err(err(format!(
                    "LENDING_POSITION_ALREADY_EXISTS:{position_id}"
                )));
            }
            put(
                &mut book.savings,
                position_id.clone(),
                obj(vec![
                    ("positionId", s(position_id)),
                    ("hubEntityId", s(hub)),
                    ("lenderEntityId", s(lender_entity_id)),
                    ("tokenId", n(token_id.get().into())),
                    ("principalAmount", V::BigInt(amount.clone())),
                    ("interestBps", n(*interest_bps as u64)),
                    ("termId", s(term_id.wire_name())),
                    ("termMs", n(term_ms(*term_id))),
                    ("createdAt", n(time)),
                    ("updatedAt", n(now)),
                    ("status", s("open")),
                ]),
            );
        }
        AccountTx::LendingBorrowRequest {
            request_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
            ..
        } => {
            if borrower_entity_id != &commit.account_id {
                return Err(err(format!(
                    "LENDING_BORROW_PROPOSER_MISMATCH:{request_id}"
                )));
            }
            let approved = super::policy::approved_draw(book, view, tx, now)?;
            let (approval, bps, late) = match approved {
                Ok(v) => v,
                Err(reason) => {
                    events.push(EntityFrameEvent::Status {
                        message: format!("Lending request {request_id} declined: {reason}"),
                    });
                    return Ok(true);
                }
            };
            let draw_token = account_token(*token_id)
                .ok_or_else(|| err(format!("ACCOUNT_DELTA_TOKEN_INVALID:{token_id}")))?;
            let hash = hex::encode(Keccak256::digest(
                format!(
                    "loan|{}|{}|{token_id}|{amount}|{}|{now}|{request_id}",
                    hub.to_lowercase(),
                    borrower_entity_id.to_lowercase(),
                    term_id.wire_name()
                )
                .as_bytes(),
            ));
            let id = format!("loan-{}", &hash[..16]);
            if find(&book.loans, &id).is_some() {
                return Err(err(format!("LENDING_LOAN_ALREADY_EXISTS:{id}")));
            }
            put(
                &mut book.loans,
                id.clone(),
                obj(vec![
                    ("requestId", s(request_id)),
                    ("loanId", s(&id)),
                    ("hubEntityId", s(hub)),
                    ("borrowerEntityId", s(borrower_entity_id)),
                    ("tokenId", n(*token_id)),
                    ("principalAmount", V::BigInt(amount.clone())),
                    ("accruedAt", n(now)),
                    ("accruedInterest", V::BigInt(0.into())),
                    ("interestRemainder", V::BigInt(0.into())),
                    (
                        "repaymentAmount",
                        V::BigInt(amount + interest(amount, bps as i64)),
                    ),
                    ("repaidAmount", V::BigInt(0.into())),
                    ("interestBps", n(bps)),
                    ("termId", s(term_id.wire_name())),
                    ("termMs", n(term_ms(*term_id))),
                    ("openedAt", n(now)),
                    ("lateMs", n(late)),
                    ("dueAt", n(now + term_ms(*term_id))),
                    ("updatedAt", n(now)),
                    ("status", s("opening")),
                    ("approval", approval),
                ]),
            );
            out.push((
                borrower_entity_id.clone(),
                AccountTx::LendingDisburse {
                    loan_id: id,
                    hub_entity_id: hub.clone(),
                    borrower_entity_id: borrower_entity_id.clone(),
                    token_id: draw_token,
                    amount: amount.clone(),
                    term_id: *term_id,
                    interest_bps: bps as i64,
                    request_id: request_id.clone(),
                    max_interest_bps: *max_interest_bps,
                    expires_at: *expires_at,
                    max_late_ms: *max_late_ms,
                    late_ms: late,
                },
            ));
        }
        AccountTx::LendingDisburse {
            loan_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            interest_bps,
            late_ms,
            ..
        } => {
            let v = find_mut(&mut book.loans, loan_id)
                .filter(|v| text(v, "status") == Ok("opening"))
                .ok_or_else(|| err(format!("LENDING_DISBURSE_LOAN_NOT_OPENING:{loan_id}")))?;
            if text(v, "borrowerEntityId")? != borrower_entity_id
                || number(v, "tokenId")? != u64::from(token_id.get())
                || big(v, "principalAmount")? != *amount
                || text(v, "termId")? != term_id.wire_name()
                || number(v, "interestBps")? != *interest_bps as u64
                || number(v, "lateMs")? != *late_ms
            {
                return Err(err(format!("LENDING_DISBURSE_MISMATCH:{loan_id}")));
            }
            update(v, "active", now);
            set(v, "openedAt", n(time));
            set(v, "accruedAt", n(time));
            set(v, "dueAt", n(time + term_ms(*term_id)));
        }
        AccountTx::LendingRepay {
            loan_id,
            borrower_entity_id,
            token_id,
            amount,
            ..
        } => {
            let v = find_mut(&mut book.loans, loan_id)
                .ok_or_else(|| err(format!("LENDING_REPAY_LOAN_NOT_REPAYABLE:{loan_id}")))?;
            if !matches!(text(v, "status")?, "active" | "defaulted") {
                return Err(err(format!("LENDING_REPAY_LOAN_NOT_REPAYABLE:{loan_id}")));
            }
            if borrower_entity_id != &commit.account_id
                || text(v, "borrowerEntityId")? != borrower_entity_id
                || number(v, "tokenId")? != u64::from(token_id.get())
            {
                return Err(err(format!("LENDING_REPAYMENT_MISMATCH:{loan_id}")));
            }
            let (paid, c) = loan_clock(v)?.settle(amount, time);
            let total = big(v, "repaidAmount")? + paid;
            set(v, "principalAmount", V::BigInt(c.principal.clone()));
            set(v, "accruedAt", n(c.accrued_at));
            set(v, "accruedInterest", V::BigInt(c.accrued_interest.clone()));
            set(
                v,
                "interestRemainder",
                V::BigInt(c.interest_remainder.clone()),
            );
            set(v, "repaidAmount", V::BigInt(total.clone()));
            set(v, "repaymentAmount", V::BigInt(total + c.exit(time)));
            set(v, "updatedAt", n(now));
            if c.principal == 0.into() {
                set(v, "status", s("repaid"));
            }
        }
        AccountTx::LendingCloseRequest {
            position_id,
            lender_entity_id,
            ..
        } => {
            let order = book
                .savings
                .iter()
                .map(|(_, v)| {
                    optional(v, "closeOrder")
                        .map(|_| number(v, "closeOrder"))
                        .transpose()
                        .map(|n| n.unwrap_or(0))
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .max()
                .unwrap_or(0)
                + 1;
            if order > xln_rscore_engine::lending::MAX_CLOCK {
                return Err(err("LENDING_WITHDRAWAL_ORDER_OVERFLOW"));
            }
            let v = find_mut(&mut book.savings, position_id)
                .ok_or_else(|| err(format!("LENDING_CLOSE_POSITION_NOT_OPEN:{position_id}")))?;
            if lender_entity_id != &commit.account_id
                || text(v, "lenderEntityId")? != lender_entity_id
            {
                return Err(err(format!(
                    "LENDING_CLOSE_PROPOSER_MISMATCH:{position_id}"
                )));
            }
            if text(v, "status")? == "queued" {
                return Ok(true);
            }
            if text(v, "status")? != "open" {
                return Err(err(format!(
                    "LENDING_CLOSE_POSITION_NOT_OPEN:{position_id}"
                )));
            }
            update(v, "queued", time);
            set(v, "closeOrder", n(order));
        }
        AccountTx::LendingClosePayout {
            position_id,
            lender_entity_id,
            token_id,
            amount,
            ..
        } => {
            let v = find_mut(&mut book.savings, position_id)
                .ok_or_else(|| err(format!("LENDING_PAYOUT_POSITION_NOT_QUEUED:{position_id}")))?;
            if text(v, "status")? != "queued" {
                return Err(err(format!(
                    "LENDING_PAYOUT_POSITION_NOT_QUEUED:{position_id}"
                )));
            }
            if text(v, "lenderEntityId")? != lender_entity_id
                || number(v, "tokenId")? != u64::from(token_id.get())
                || (text(v, "termId")? != "demand" && close_amount(v, now, None)? != *amount)
            {
                return Err(err(format!("LENDING_PAYOUT_MISMATCH:{position_id}")));
            }
            update(v, "closed", now);
        }
        AccountTx::LendingRate {
            position_id,
            lender_entity_id,
            token_id,
            interest_bps,
            ..
        } => {
            let v = find_mut(&mut book.savings, position_id)
                .ok_or_else(|| err("LENDING_RATE_BOOK_BINDING"))?;
            if text(v, "status")? != "open"
                || text(v, "termId")? != "demand"
                || text(v, "lenderEntityId")? != lender_entity_id
                || number(v, "tokenId")? != u64::from(token_id.get())
            {
                return Err(err("LENDING_RATE_BOOK_BINDING"));
            }
            set(v, "interestBps", n(*interest_bps as u64));
            set(v, "updatedAt", n(time));
        }
        _ => unreachable!(),
    };
    Ok(true)
}
