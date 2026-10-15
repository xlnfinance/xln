use serde_json::json;
use sha3::{Digest, Keccak256};

use super::validation::{
    consume_intent, normalize, positive_amount, require_counterparty, require_intent_id,
    require_role, validate_interest_bps,
};
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountRejection, AccountReplica, AccountTx, LendingIntentKind, LendingTermId, Side,
    TransitionError, ValidationRejection,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn term_ms(term: LendingTermId) -> u64 {
    match term {
        LendingTermId::OneHour => 3_600_000,
        LendingTermId::OneDay => 86_400_000,
        LendingTermId::OneMonth => 2_592_000_000,
        LendingTermId::Demand => 31_536_000_000,
    }
}

fn reject(message: &str) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(
        ValidationRejection::AccountTx {
            message: message.into(),
        },
    ))
}

pub(super) fn borrow_request(
    replica: &mut AccountReplica,
    tx: &AccountTx,
    proposer: Side,
    timestamp: u64,
) -> Result<MutationDecision, TransitionError> {
    let AccountTx::LendingBorrowRequest {
        request_id,
        hub_entity_id,
        borrower_entity_id,
        token_id,
        amount,
        term_id,
        max_interest_bps,
        expires_at,
        max_late_ms,
    } = tx
    else {
        return Err(TransitionError::LendingRouteMismatch);
    };
    require_intent_id(request_id, "borrow")?;
    require_role(replica, proposer, "BORROWER", borrower_entity_id)?;
    require_counterparty(replica, borrower_entity_id, hub_entity_id)?;
    positive_amount(amount, "LENDING_BORROW")?;
    validate_interest_bps(*max_interest_bps)?;
    if expires_at
        .checked_add(term_ms(*term_id))
        .and_then(|end| end.checked_add(*max_late_ms))
        .is_none_or(|end| end > MAX_SAFE_INTEGER)
    {
        return Ok(reject("LENDING_BORROW_CLOCK_OVERFLOW"));
    }
    if request_id != &normalize(request_id) || timestamp >= *expires_at {
        return Ok(reject("LENDING_BORROW_AUTHORIZATION_EXPIRED_OR_INVALID"));
    }
    let domain = replica.state().identity().domain();
    // The borrower's certified frame authorizes exactly these terms in this
    // Account domain and J epoch. A different amount, late window or deployment
    // must never reuse its permission. The disbursement consumes this key.
    let preimage = json!(["xln:borrow", domain.chain_id(), domain.depository_address().as_hex(),
        replica.state().j_nonce(), request_id, hub_entity_id, borrower_entity_id, token_id,
        {"__xlnType":"BigInt", "value":amount.to_string()}, term_id.wire_name(),
        max_interest_bps, max_late_ms, expires_at])
    .to_string();
    let authorization = format!(
        "authorize:0x{}",
        hex::encode(Keccak256::digest(preimage.as_bytes()))
    );
    consume_intent(
        replica,
        format!("borrow:{}", normalize(request_id)),
        LendingIntentKind::Borrow,
    )?;
    consume_intent(replica, authorization, LendingIntentKind::Borrow)?;
    Ok(MutationDecision::applied(vec![format!(
        "Lending borrow request {request_id} committed"
    )]))
}
