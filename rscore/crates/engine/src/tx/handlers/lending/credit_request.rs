//! Mirrors `core/account/tx/handlers/balance/credit-request.ts`.
//!
//! Signer/authority: only the frame proposer may name itself as requester.
//! Nonce: `credit:<requestId>` in the shared Account intent ledger, so one
//! signed request can trigger at most one counterparty answer. State: only the
//! intent entry is added; the credit line moves when the counterparty later
//! proposes its own `SetCreditLimit`.

use num_bigint::BigInt;

use super::validation::{consume_intent, positive_amount};
use crate::tx::apply_types::MutationDecision;
use crate::{AccountReplica, LendingIntentKind, Side, TokenId, TransitionError};

fn valid_request_id(value: &str) -> bool {
    value.strip_prefix("credit-").is_some_and(|suffix| {
        suffix.len() == 16
            && suffix
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

pub(super) fn apply(
    replica: &mut AccountReplica,
    proposer: Side,
    request_id: &str,
    requester_entity_id: &str,
    token_id: TokenId,
    amount: &BigInt,
) -> Result<MutationDecision, TransitionError> {
    if !valid_request_id(request_id) {
        return Err(TransitionError::CreditRequestIdInvalid(request_id.into()));
    }
    let expected = replica.state().identity().entity(proposer).to_string();
    if requester_entity_id != expected {
        return Err(TransitionError::CreditRequestRequesterNotProposer {
            claimed: requester_entity_id.into(),
            proposer: expected,
        });
    }
    positive_amount(amount, "CREDIT_REQUEST")?;
    if replica.state().delta(token_id).is_none() {
        return Err(TransitionError::CreditRequestTokenNotEnabled(token_id));
    }
    consume_intent(
        replica,
        format!("credit:{request_id}"),
        LendingIntentKind::CreditRequest,
    )?;
    Ok(MutationDecision::applied(vec![format!(
        "Credit request {request_id} committed"
    )]))
}
