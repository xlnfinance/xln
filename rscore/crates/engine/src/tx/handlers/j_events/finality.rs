use num_bigint::BigInt;

use crate::tx::apply_types::AccountConsensusEffect;
use crate::{AccountOutput, AccountReplica, AccountSettledEvent, JurisdictionEvent, StateError};

pub(crate) struct FinalizedAccountEvents {
    pub output: AccountOutput,
    pub consensus_effects: Vec<AccountConsensusEffect>,
}

pub(crate) fn apply_finalized_events(
    replica: &mut AccountReplica,
    events: &[JurisdictionEvent],
    j_height: u64,
) -> Result<FinalizedAccountEvents, StateError> {
    let mut previous_nonce = replica.state().j_nonce();
    let mut first_token = None;
    for event in events {
        let JurisdictionEvent::AccountSettled(settled) = event else {
            continue;
        };
        validate_settled(replica, settled, previous_nonce)?;
        apply_settled(replica, settled)?;
        previous_nonce = previous_nonce.max(settled.nonce);
        first_token.get_or_insert(settled.token_id);
    }
    let token_id = first_token
        .ok_or_else(|| StateError::JClaim("ACCOUNT_J_CLAIM_ACCOUNT_SETTLED_REQUIRED".into()))?;
    replica.state_mut().set_j_nonce(previous_nonce);
    replica.state_mut().set_last_finalized_j_height(j_height);
    let consensus_effects = crate::tx::handlers::settlement::apply_finalized_account_settlement(
        replica,
        previous_nonce,
    )
    .map_err(StateError::JClaim)?
    .into_iter()
    .collect();
    let delta = replica
        .state()
        .delta(token_id)
        .ok_or_else(|| StateError::JClaim("ACCOUNT_SETTLED_DELTA_MISSING".into()))?;
    Ok(FinalizedAccountEvents {
        output: AccountOutput::AccountSettledFinalized {
            token_id,
            j_height,
            collateral: delta.collateral().clone(),
            ondelta: delta.ondelta().clone(),
        },
        consensus_effects,
    })
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
    let increase = (&event.collateral - &previous_collateral).max(BigInt::from(0));
    replica.state_mut().put_delta(delta)?;
    let requested = replica
        .state()
        .requested_rebalance(event.token_id)
        .cloned()
        .unwrap_or_default();
    if requested > BigInt::from(0) && increase > BigInt::from(0) {
        let remaining = (requested - increase).max(BigInt::from(0));
        if remaining > BigInt::from(0) {
            replica
                .state_mut()
                .put_requested_rebalance(event.token_id, remaining)?;
        } else {
            replica
                .state_mut()
                .remove_requested_rebalance(event.token_id)?;
        }
        replica.clear_rebalance_shadow_submitted(event.token_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::RebalanceRequestFeeState;
    use crate::{
        AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity, AccountState, Delta,
        DepositoryAddress, EntityId, JEventMetadata, Side, TokenId, WatchSeed,
    };
    use xln_rscore_protocol::CanonicalValue;

    fn entity(byte: u8) -> EntityId {
        EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
    }

    fn replica() -> AccountReplica {
        let identity = AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            entity(0x11),
            entity(0x22),
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("seed"),
        )
        .expect("identity");
        let delta = Delta::new(
            TokenId::new(1).expect("token"),
            10.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
        )
        .expect("delta");
        AccountReplica::new(
            entity(0x11),
            AccountState::new(
                identity,
                AccountDisputeConfig::new(10, 10).expect("config"),
                vec![delta],
            )
            .expect("state"),
        )
        .expect("replica")
    }

    fn settled(collateral: i64, nonce: u64) -> JurisdictionEvent {
        JurisdictionEvent::AccountSettled(AccountSettledEvent {
            metadata: JEventMetadata::default(),
            left_entity: entity(0x11),
            right_entity: entity(0x22),
            token_id: TokenId::new(1).expect("token"),
            left_reserve: 0.into(),
            right_reserve: 0.into(),
            collateral: collateral.into(),
            ondelta: 0.into(),
            nonce,
        })
    }

    #[test]
    fn account_settled_reduces_native_rebalance_and_allows_dispute_shell() {
        let mut account = replica();
        let token = TokenId::new(1).expect("token");
        account
            .state_mut()
            .put_requested_rebalance(token, 7.into())
            .expect("request");
        account
            .state_mut()
            .put_requested_rebalance_fee_state(
                token,
                RebalanceRequestFeeState {
                    request_id: "request-1".into(),
                    fee_token_id: token,
                    fee_paid_upfront: 1.into(),
                    requested_amount: 7.into(),
                    policy_version: 1,
                    requested_at: 1,
                    requested_by_left: true,
                    refund: None,
                },
            )
            .expect("fee state");
        account.set_envelope(
            AccountEnvelope::new(
                vec![(
                    "activeDispute".into(),
                    CanonicalValue::Object(vec![(
                        "observedOnChain".into(),
                        CanonicalValue::Bool(true),
                    )]),
                )],
                Vec::new(),
            )
            .expect("envelope"),
        );
        let applied =
            apply_finalized_events(&mut account, &[settled(14, 2)], 44).expect("finality");
        assert!(applied.consensus_effects.is_empty());
        assert_eq!(
            account.state().requested_rebalance(token),
            Some(&BigInt::from(3))
        );
        assert_eq!(account.state().j_nonce(), 2);
        assert_eq!(account.state().last_finalized_j_height(), 44);
        assert!(account.envelope().has_field("activeDispute"));
        assert_eq!(account.owner_side(), Side::Left);
    }

    #[test]
    fn account_settled_clears_completed_rebalance_and_fee_state() {
        let mut account = replica();
        let token = TokenId::new(1).expect("token");
        account
            .state_mut()
            .put_requested_rebalance(token, 4.into())
            .expect("request");
        account
            .state_mut()
            .put_requested_rebalance_fee_state(
                token,
                RebalanceRequestFeeState {
                    request_id: "request-1".into(),
                    fee_token_id: token,
                    fee_paid_upfront: 1.into(),
                    requested_amount: 4.into(),
                    policy_version: 1,
                    requested_at: 1,
                    requested_by_left: true,
                    refund: None,
                },
            )
            .expect("fee state");
        apply_finalized_events(&mut account, &[settled(20, 2)], 44).expect("finality");
        assert!(account.state().requested_rebalance(token).is_none());
        assert!(
            account
                .state()
                .requested_rebalance_fee_state(token)
                .is_none()
        );
    }
}
