use num_bigint::BigInt;
use xln_rscore_engine::{AccountOutput, JEventClaimTx, JurisdictionEvent};

use crate::{EntityKernelError, EntityKernelOutput};

pub(crate) fn apply_committed_j_event_claim(
    entity_id: &str,
    account_id: &str,
    claim: &JEventClaimTx,
    account_outputs: &[AccountOutput],
    outputs: &mut Vec<EntityKernelOutput>,
) -> Result<(), EntityKernelError> {
    if account_outputs.is_empty() {
        return Ok(());
    }
    let [
        AccountOutput::AccountSettledFinalized {
            token_id,
            j_height,
            collateral,
            ondelta,
        },
    ] = account_outputs
    else {
        return Err(EntityKernelError::output("J_EVENT_CLAIM_OUTPUTS"));
    };
    let first_token = claim.events.iter().find_map(|event| match event {
        JurisdictionEvent::AccountSettled(event) => Some(event.token_id),
        _ => None,
    });
    if first_token != Some(*token_id)
        || claim.j_height != *j_height
        || collateral < &BigInt::from(0)
    {
        return Err(EntityKernelError::output("J_EVENT_CLAIM_FINALITY_BINDING"));
    }
    outputs.push(EntityKernelOutput::AccountSettledFinalizedBilateral {
        entity_id: entity_id.to_string(),
        account_id: account_id.to_string(),
        token_id: token_id.get(),
        j_height: *j_height,
        collateral: collateral.clone(),
        ondelta: ondelta.clone(),
    });
    Ok(())
}
