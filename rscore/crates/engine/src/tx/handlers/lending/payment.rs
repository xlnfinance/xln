use num_bigint::BigInt;

use crate::tx::apply_types::MutationDecision;
use crate::tx::handlers::balance::{DirectPayment, direct_payment};
use crate::tx::handlers::lending::validation::consume_intent;
use crate::{AccountReplica, DeliveryMode, LendingIntentKind, Side, TokenId, TransitionError};

#[allow(clippy::too_many_arguments)]
pub(super) fn payment(
    replica: &mut AccountReplica,
    proposer: Side,
    token_id: TokenId,
    amount: &BigInt,
    payer: &str,
    recipient: &str,
    tx_type: &str,
) -> Result<MutationDecision, TransitionError> {
    let route = vec![recipient.to_owned()];
    let description = format!("xln:{tx_type}");
    direct_payment(
        replica,
        DirectPayment {
            token_id,
            amount,
            route: &route,
            description: Some(&description),
            from_entity_id: payer,
            to_entity_id: recipient,
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
        proposer,
    )
}

pub(super) fn consume_if_applied(
    replica: &mut AccountReplica,
    result: MutationDecision,
    key: String,
    kind: LendingIntentKind,
) -> Result<MutationDecision, TransitionError> {
    if matches!(result, MutationDecision::Applied { .. }) {
        consume_intent(replica, key, kind)?;
    }
    Ok(result)
}
