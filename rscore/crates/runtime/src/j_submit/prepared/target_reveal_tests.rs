use super::*;
use crate::j_submit::{
    GovernanceResultData, GovernanceResultOutcome, apply_governance_result,
    register_governance_attempt,
};
use crate::{RuntimeLimits, canonical_value_from_tagged_json};
use xln_rscore_entity_kernel::EntityCanonicalCollection;

#[test]
fn only_matching_finalized_registry_projection_retires_target_witness() {
    let mut replica = crate::machine::tests::replica(RuntimeLimits::default()).unwrap();
    let key = replica.state.e_replicas.keys().next().unwrap().clone();
    let config = json!({"name":"Target", "chainId":2, "depositoryAddress":hex(&[0x11;20])});
    replica
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity_consensus
        .state
        .authority
        .config
        .jurisdiction = Some(canonical_value_from_tagged_json(&config).unwrap());
    let registration = HashLadderRegistration {
        counterparty_entity: [0x33; 32],
        target_role: true,
        full_hash: [0x22; 32],
        partial_root: [0; 32],
        witness: HashLadderWitness {
            fill_ratio: 65535,
            full_secret: [0x44; 32],
            reveals: [[0; 32]; 4],
        },
    };
    let hash = xln_rscore_entity_kernel::j_batch::hash_target_reveal(
        2,
        [0x11; 20],
        key.entity_id,
        &registration,
    );
    let attempt = prepare_target_reveal(
        "Target".into(),
        key.entity_id,
        registration.clone(),
        hash,
        key.signer_id.clone(),
        1_173_000,
        vec![0x12],
    )
    .unwrap();
    register_governance_attempt(&mut replica, &attempt).unwrap();
    assert!(!finalized_target_reveal(&replica, &attempt).unwrap());
    let route = json!({"target":{"jurisdiction":format!("stack:2:{}",hex(&[0x11;20])),
        "entityId":hex(&registration.counterparty_entity),"counterpartyEntityId":hex(&key.entity_id)},
        "targetPull":{"fullHash":hex(&registration.full_hash),"partialRoot":hex(&registration.partial_root)},
        "targetRegistryFillRatio":65535,"targetRegistryRecord":{"fillRatio":65535,"revealedAt":1174}});
    let mut routes = EntityCanonicalCollection::empty();
    routes
        .insert(
            "route".into(),
            canonical_value_from_tagged_json(&route).unwrap(),
        )
        .unwrap();
    replica
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .cross_jurisdiction_swaps = Some(routes);
    assert!(finalized_target_reveal(&replica, &attempt).unwrap());
    for (path, value) in [
        ("/target/jurisdiction", json!("stack:3:wrong")),
        ("/target/entityId", json!(hex(&[0x99; 32]))),
        ("/targetPull/fullHash", json!(hex(&[0x88; 32]))),
        ("/targetRegistryFillRatio", json!(1)),
        ("/targetRegistryRecord/fillRatio", json!(1)),
    ] {
        let mut wrong = route.clone();
        *wrong.pointer_mut(path).unwrap() = value;
        let mut routes = EntityCanonicalCollection::empty();
        routes
            .insert(
                "route".into(),
                canonical_value_from_tagged_json(&wrong).unwrap(),
            )
            .unwrap();
        replica
            .state
            .e_replicas
            .get_mut(&key)
            .unwrap()
            .entity
            .cross_jurisdiction_swaps = Some(routes);
        assert!(
            !finalized_target_reveal(&replica, &attempt).unwrap(),
            "{path}"
        );
    }
    let mut routes = EntityCanonicalCollection::empty();
    routes
        .insert(
            "route".into(),
            canonical_value_from_tagged_json(&route).unwrap(),
        )
        .unwrap();
    replica
        .state
        .e_replicas
        .get_mut(&key)
        .unwrap()
        .entity
        .cross_jurisdiction_swaps = Some(routes);
    let result = GovernanceResultData {
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        entity_id: hex(&attempt.shareholder_entity_id),
        signer_id: hex(&attempt.signer_id),
        proposal_hash: hex(&attempt.proposal_hash),
        payload_hash: hex(&attempt.payload_hash),
        attempt_id: attempt.attempt_id.clone(),
        attempt_number: 1,
        attempted_at: attempt.attempted_at,
        outcome: GovernanceResultOutcome::Reconciled,
        message: None,
        adapter_failure: None,
        transaction_hash: None,
    };
    apply_governance_result(&mut replica, &result, 1_175_000).unwrap();
    assert!(
        super::super::decode_pending_governance_attempts(replica.durable.infrastructure())
            .unwrap()
            .is_empty()
    );
}
