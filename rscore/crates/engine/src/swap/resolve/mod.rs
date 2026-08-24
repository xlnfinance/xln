//! Same-jurisdiction swap settlement pipeline.
//!
//! Parity target: `core/account/tx/handlers/swap/resolve/index.ts`. Immutable
//! maker terms are validated first, both token legs and the hold move
//! atomically, then the remaining order is requantized or closed.

mod remainder;
mod settlement;
pub(crate) mod types;
mod validation;

use crate::error::{AccountRejection, ValidationRejection};
use crate::mutation::MutationDecision;
use crate::swap::market::SwapMarketPolicy;
use crate::{AccountReplica, Side, TransitionError};

pub(crate) use types::SwapResolveTx;

pub(crate) fn apply_resolve(
    replica: &mut AccountReplica,
    policy: &SwapMarketPolicy,
    tx: SwapResolveTx<'_>,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    if policy.is_empty() {
        return Err(TransitionError::SwapMarketPolicyMissing);
    }
    let validated = match validation::validate_swap_resolve(replica.state(), &tx, proposer) {
        Ok(validated) => validated,
        Err(rejection) => return Ok(rejected(rejection)),
    };
    let settled = match settlement::apply_swap_resolve_financials(replica, validated)? {
        Ok(settled) => settled,
        Err(rejection) => return Ok(rejected(rejection)),
    };
    match remainder::apply_swap_resolve_remainder(replica, policy, settled)? {
        Ok(outcome) => Ok(MutationDecision::with_outputs(
            outcome.events,
            outcome.outputs,
        )),
        Err(rejection) => Ok(rejected(rejection)),
    }
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}
