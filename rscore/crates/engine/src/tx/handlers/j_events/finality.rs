use crate::{AccountOutput, AccountReplica, AccountSettledEvent, JurisdictionEvent, StateError};

pub(crate) fn apply_finalized_events(
    replica: &mut AccountReplica,
    events: &[JurisdictionEvent],
    j_height: u64,
) -> Result<AccountOutput, StateError> {
    assert_supported_shell(replica)?;
    let mut previous_nonce = replica.state().j_nonce();
    let mut first_token = None;
    for event in events {
        let JurisdictionEvent::AccountSettled(settled) = event;
        validate_settled(replica, settled, previous_nonce)?;
        apply_settled(replica, settled)?;
        previous_nonce = previous_nonce.max(settled.nonce);
        first_token.get_or_insert(settled.token_id);
    }
    let token_id = first_token
        .ok_or_else(|| StateError::JClaim("ACCOUNT_J_CLAIM_ACCOUNT_SETTLED_REQUIRED".into()))?;
    replica.state_mut().set_j_nonce(previous_nonce);
    replica.state_mut().set_last_finalized_j_height(j_height);
    let delta = replica
        .state()
        .delta(token_id)
        .ok_or_else(|| StateError::JClaim("ACCOUNT_SETTLED_DELTA_MISSING".into()))?;
    Ok(AccountOutput::AccountSettledFinalized {
        token_id,
        j_height,
        collateral: delta.collateral().clone(),
        ondelta: delta.ondelta().clone(),
    })
}

fn assert_supported_shell(replica: &AccountReplica) -> Result<(), StateError> {
    if replica.settlement_workspace_present() {
        return Err(StateError::JClaim(
            "ACCOUNT_J_CLAIM_SETTLEMENT_WORKSPACE_UNSUPPORTED".into(),
        ));
    }
    if replica.envelope().has_field("activeDispute")
        || replica.envelope().has_field("disputePrepare")
    {
        return Err(StateError::JClaim(
            "ACCOUNT_J_CLAIM_DISPUTE_ACTIVATION_UNSUPPORTED".into(),
        ));
    }
    Ok(())
}

fn validate_settled(
    replica: &AccountReplica,
    event: &AccountSettledEvent,
    previous_nonce: u64,
) -> Result<(), StateError> {
    let identity = replica.state().identity();
    if &event.left_entity != identity.left() || &event.right_entity != identity.right() {
        return Err(StateError::JClaim(format!(
            "ACCOUNT_SETTLED_PAIR_MISMATCH:{}:{}:{}:{}",
            event.left_entity,
            event.right_entity,
            identity.left(),
            identity.right()
        )));
    }
    if event.nonce < previous_nonce {
        return Err(StateError::JClaim(format!(
            "ACCOUNT_SETTLED_NONCE_REGRESSION:{previous_nonce}:{}",
            event.nonce
        )));
    }
    Ok(())
}

fn apply_settled(
    replica: &mut AccountReplica,
    event: &AccountSettledEvent,
) -> Result<(), StateError> {
    let mut delta = replica.state().delta_or_zero(event.token_id)?;
    let previous_collateral = delta.collateral().clone();
    delta.apply_j_settlement(&event.collateral, &event.ondelta)?;
    if event.collateral > previous_collateral
        && replica.state().carried().requested_rebalance_root
            != xln_rscore_protocol::EMPTY_RADIX_ROOT
    {
        return Err(StateError::JClaim(
            "ACCOUNT_J_CLAIM_REQUESTED_REBALANCE_UNSUPPORTED".into(),
        ));
    }
    replica.state_mut().put_delta(delta)
}
