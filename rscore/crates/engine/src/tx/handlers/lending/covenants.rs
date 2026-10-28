use super::validation::{consume_intent, positive_amount, require_unused_intent};
use crate::lending::{LendingCovenant, MAX_CLOCK, term_ms};
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountReplica, AccountTx, LendingIntentKind as Intent, LendingTermId, Side, TransitionError,
};
use num_bigint::BigInt;
#[path = "covenants/funding.rs"]
mod funding;
#[path = "covenants/support.rs"]
mod support;
use support::*;

pub(super) fn apply(
    a: &mut AccountReplica,
    tx: &AccountTx,
    side: Side,
    time: u64,
) -> Result<MutationDecision, TransitionError> {
    match tx {
        AccountTx::LendingFund { .. } | AccountTx::LendingDisburse { .. } => {
            funding::fund(a, tx, side, time)
        }
        AccountTx::LendingBorrowRequest {
            request_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
            term_id,
            max_interest_bps,
            max_late_ms,
            expires_at,
        } => {
            if *term_id == LendingTermId::Demand {
                return Ok(reject("LENDING_LOAN_TERM_REQUIRED"));
            }
            intent(request_id, "borrow")?;
            parties(a, side, "BORROWER", borrower_entity_id, hub_entity_id)?;
            if *token_id == 0 || *token_id > MAX_CLOCK {
                return Err(TransitionError::LendingTokenInvalid(*token_id));
            }
            positive_amount(amount, "LENDING_BORROW")?;
            rate(*max_interest_bps)?;
            if *max_late_ms > MAX_CLOCK {
                return Ok(reject_fault(format!(
                    "LENDING_MAX_LATE_WINDOW_INVALID:{max_late_ms}"
                )));
            }
            if expires_at
                .checked_add(term_ms(*term_id))
                .and_then(|v| v.checked_add(*max_late_ms))
                .is_none_or(|v| v > MAX_CLOCK)
            {
                return Ok(reject_fault(format!(
                    "LENDING_BORROW_CLOCK_OVERFLOW:{:.0}",
                    *expires_at as f64 + term_ms(*term_id) as f64 + *max_late_ms as f64
                )));
            }
            if *request_id != normalized(request_id) || time >= *expires_at {
                return Ok(reject("LENDING_BORROW_AUTHORIZATION_EXPIRED_OR_INVALID"));
            }
            let key = format!("borrow:{}", normalized(request_id));
            if a.state().has_intent(&key)? {
                return Ok(reject(format!("LENDING_INTENT_REPLAY:{key}")));
            }
            let authorization = auth(a, tx);
            consume_intent(a, key, Intent::Borrow)?;
            consume_intent(a, authorization, Intent::Borrow)?;
            Ok(MutationDecision::applied(vec![format!(
                "Lending borrow request {request_id} committed"
            )]))
        }
        AccountTx::LendingRate {
            position_id,
            hub_entity_id,
            lender_entity_id,
            token_id,
            claim_hash,
            interest_bps,
        } => {
            intent(position_id, "lend")?;
            parties(a, side, "HUB", hub_entity_id, lender_entity_id)?;
            let Some(c) = a.state().lending_claim(position_id) else {
                return Ok(reject("LENDING_RATE_COVENANT_MISMATCH"));
            };
            if c.kind != "demand"
                || c.creditor_is_left == (side == Side::Left)
                || c.token_id != u32::from(token_id.get())
                || a.state().has_intent(&format!("close:{position_id}"))?
            {
                return Ok(reject("LENDING_RATE_COVENANT_MISMATCH"));
            }
            if *claim_hash != c.hash() {
                return Ok(reject("LENDING_RATE_COVENANT_CHANGED"));
            }
            let c = match c.renew(*interest_bps as u64, time) {
                Ok(c) => c,
                Err(e) => return Ok(reject(e)),
            };
            a.state_mut().put_lending_claim(position_id.clone(), c)?;
            Ok(MutationDecision::applied(vec![
                "Demand savings rate renewed".into(),
            ]))
        }
        AccountTx::LendingRepay {
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
            claim_hash,
        } => {
            intent(loan_id, "loan")?;
            parties(a, side, "BORROWER", borrower_entity_id, hub_entity_id)?;
            positive_amount(amount, "LENDING_REPAY")?;
            let key = format!("repay:{}", normalized(loan_id));
            require_unused_intent(a, &key)?;
            let Some(c) = a.state().lending_claim(loan_id) else {
                return Ok(reject("LENDING_REPAY_COVENANT_MISMATCH"));
            };
            if c.kind != "loan"
                || c.creditor_is_left == (side == Side::Left)
                || c.token_id != u32::from(token_id.get())
            {
                return Ok(reject("LENDING_REPAY_COVENANT_MISMATCH"));
            }
            if *claim_hash != c.hash() {
                return Ok(reject("LENDING_REPAY_COVENANT_CHANGED"));
            }
            let (paid, c) = c.settle(amount, time);
            let result = payment(a, tx, side, *token_id, &paid)?;
            if applied(&result) {
                if c.principal == 0.into() {
                    consume_intent(a, key, Intent::Repay)?;
                    a.state_mut().remove_lending_claim(loan_id)?;
                } else {
                    a.state_mut().put_lending_claim(loan_id.clone(), c)?;
                }
            }
            Ok(result)
        }
        AccountTx::LendingCloseRequest {
            position_id,
            hub_entity_id,
            lender_entity_id,
        } => {
            intent(position_id, "lend")?;
            parties(a, side, "LENDER", lender_entity_id, hub_entity_id)?;
            let Some(c) = a.state().lending_claim(position_id) else {
                return Ok(reject("LENDING_CLOSE_COVENANT_MISMATCH"));
            };
            if c.kind == "loan" || c.creditor_is_left != (side == Side::Left) {
                return Ok(reject("LENDING_CLOSE_COVENANT_MISMATCH"));
            }
            let key = format!("close:{}", normalized(position_id));
            let prior = a.state().lending_intent(&key);
            let demand = c.kind == "demand";
            let kind = if demand {
                Intent::CloseRequest
            } else if time < c.opened_at + c.term_ms {
                Intent::CloseEarly
            } else {
                Intent::CloseMature
            };
            if let Some(prior) = prior {
                if !(if demand {
                    prior == Intent::CloseRequest
                } else {
                    matches!(prior, Intent::CloseEarly | Intent::CloseMature)
                }) {
                    return Err(crate::StateError::AccountStateRoot(format!(
                        "LENDING_CLOSE_INTENT_INVALID:{key}"
                    ))
                    .into());
                }
            } else {
                consume_intent(a, key, kind)?;
            }
            Ok(MutationDecision::applied(vec![format!(
                "Lending close request {position_id} committed"
            )]))
        }
        AccountTx::LendingClosePayout {
            position_id,
            hub_entity_id,
            lender_entity_id,
            token_id,
            amount,
        } => {
            intent(position_id, "lend")?;
            parties(a, side, "HUB", hub_entity_id, lender_entity_id)?;
            positive_amount(amount, "LENDING_CLOSE_PAYOUT")?;
            let key = format!("payout:{}", normalized(position_id));
            require_unused_intent(a, &key)?;
            let Some(c) = a.state().lending_claim(position_id) else {
                return Ok(reject("LENDING_PAYOUT_COVENANT_MISMATCH"));
            };
            if c.kind == "loan"
                || c.creditor_is_left == (side == Side::Left)
                || c.token_id != u32::from(token_id.get())
                || *amount < c.principal
                || *amount > c.maximum()
            {
                return Ok(reject("LENDING_PAYOUT_COVENANT_MISMATCH"));
            }
            let close = a.state().lending_intent(&format!("close:{position_id}"));
            if c.kind == "savings"
                && !matches!(close, Some(Intent::CloseEarly | Intent::CloseMature))
            {
                return Ok(reject("LENDING_SAVINGS_CLOSE_AUTHORIZATION_REQUIRED"));
            }
            let paid = if c.kind == "demand" {
                c.exit(time)
            } else if close == Some(Intent::CloseEarly) {
                c.principal.clone()
            } else {
                c.maximum()
            };
            if c.kind == "savings" && *amount != paid {
                return Ok(reject("LENDING_SAVINGS_PAYOUT_AMOUNT_MISMATCH"));
            }
            if c.kind == "demand" && (*amount < paid || close != Some(Intent::CloseRequest)) {
                return Ok(reject("LENDING_DEMAND_PAYOUT_INCOMPLETE"));
            }
            let result = payment(a, tx, side, *token_id, &paid)?;
            if applied(&result) {
                consume_intent(a, key, Intent::ClosePayout)?;
                a.state_mut().remove_lending_claim(position_id)?;
            }
            Ok(result)
        }
        _ => Err(TransitionError::LendingRouteMismatch),
    }
}
