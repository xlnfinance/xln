use crate::j_claims::JClaimStatus;
use crate::tx::apply_types::MutationDecision;
use crate::{AccountReplica, JEventClaimTx, Side, TransitionError};

use super::finality::apply_finalized_events;

pub(crate) fn apply_j_event_claim(
    replica: &mut AccountReplica,
    tx: &JEventClaimTx,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    let identity = replica.state().identity().clone();
    let left = replica.state().carried().left_pending_j_claims.clone();
    let right = replica.state().carried().right_pending_j_claims.clone();
    let finalized_height = replica.state().last_finalized_j_height();
    let transition = crate::apply_claim_transition(
        &identity,
        &left,
        &right,
        finalized_height,
        tx,
        proposer == Side::Left,
        replica.state_mut().j_claim_store_mut(),
    )?;
    replica
        .state_mut()
        .set_j_claim_accumulators(transition.left, transition.right);
    let (message, outputs) = match transition.status {
        JClaimStatus::Pending => ("📥 J-event claim authenticated and retained", Vec::new()),
        JClaimStatus::Idempotent => ("ℹ️ j_event_claim idempotent", Vec::new()),
        JClaimStatus::Stale => ("ℹ️ j_event_claim stale", Vec::new()),
        JClaimStatus::Finalized => (
            "✅ J-event claim finalized bilaterally",
            vec![apply_finalized_events(
                replica,
                &transition.events,
                tx.j_height,
            )?],
        ),
    };
    Ok(MutationDecision::with_outputs(
        vec![message.into()],
        outputs,
    ))
}
