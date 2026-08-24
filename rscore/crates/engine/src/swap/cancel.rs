//! swap_cancel_request: the maker asks, the counterparty decides.
//!
//! Parity target: `core/account/tx/handlers/swap/lifecycle/cancel.ts`. No hold
//! is released and no offer row is touched here — the final transition happens
//! only in swap_resolve — so this transition writes no account state and its
//! whole effect is the emitted request event.

use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountOutput, AccountRejection, AccountReplica, Side, TransitionError, ValidationRejection,
};

pub(crate) fn apply_cancel_request(
    replica: &AccountReplica,
    offer_id: &str,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    let Some(offer) = replica.state().swap_offer(offer_id) else {
        return Ok(rejected(ValidationRejection::SwapOfferNotFound {
            offer_id: offer_id.to_owned(),
        }));
    };
    // byLeft is the frame proposer, i.e. the caller.
    if (proposer == Side::Left) != offer.maker_is_left() {
        return Ok(rejected(ValidationRejection::SwapCancelNotMaker));
    }
    Ok(MutationDecision::with_outputs(
        vec![format!(
            "📨 Swap cancel requested: {}...",
            crate::state::identity::js_prefix(offer_id, 8)
        )],
        vec![AccountOutput::SwapCancelRequest {
            offer_id: offer_id.to_owned(),
        }],
    ))
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}
