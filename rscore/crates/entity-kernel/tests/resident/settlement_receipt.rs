use super::*;
use xln_rscore_engine::{AccountStateSeed, HankoBatchProcessedEvent};
use xln_rscore_entity_kernel::{
    EntityCanonicalCollection, JBatch, JBatchState, JBatchStatus, SentJBatch,
};

fn canonical(value: &serde_json::Value) -> CanonicalValue {
    match value {
        serde_json::Value::Null => CanonicalValue::Null,
        serde_json::Value::Bool(v) => CanonicalValue::Bool(*v),
        serde_json::Value::String(v) => CanonicalValue::String(v.clone()),
        serde_json::Value::Number(v) => {
            CanonicalValue::Number(CanonicalNumber::try_from_u64(v.as_u64().unwrap()).unwrap())
        }
        serde_json::Value::Array(v) => CanonicalValue::Array(v.iter().map(canonical).collect()),
        serde_json::Value::Object(v)
            if v.get("__xlnType").and_then(|v| v.as_str()) == Some("BigInt") =>
        {
            CanonicalValue::BigInt(v["value"].as_str().unwrap().parse().unwrap())
        }
        serde_json::Value::Object(v) => {
            CanonicalValue::Object(v.iter().map(|(k, v)| (k.clone(), canonical(v))).collect())
        }
    }
}

#[test]
fn matching_batch_receipt_executes_ready_signed_continuation_in_same_entity_frame() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/entity-settlement/settlement-v1.json"
    ))
    .unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "settle_execute")
        .unwrap();
    let setup = &case["setup"];
    let owner = EntityId::parse(setup["entityId"].as_str().unwrap()).unwrap();
    let peer = EntityId::parse(setup["counterpartyEntityId"].as_str().unwrap()).unwrap();
    let identity = AccountIdentity::new(
        domain(),
        peer.clone(),
        owner.clone(),
        WatchSeed::parse(setup["watchSeed"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let deltas = setup["offdeltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            Delta::new(
                TokenId::new(row["tokenId"].as_u64().unwrap() as u32).unwrap(),
                row["collateral"]["value"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
                0.into(),
                row["offdelta"]["value"].as_str().unwrap().parse().unwrap(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
            )
            .unwrap()
        })
        .collect();
    let state = AccountState::restore_full(AccountStateSeed {
        identity,
        dispute_config: AccountDisputeConfig::new(86400, 3600).unwrap(),
        deltas,
        locks: vec![],
        j_nonce: 0,
        last_finalized_j_height: 0,
        carried: Default::default(),
        rebalance_fee_policies: vec![],
        swap_offers: vec![],
        lending_intents: vec![],
        pulls: vec![],
        settlement_workspace: Some(canonical(&case["accountView"]["settlementWorkspace"])),
    })
    .unwrap();
    let mut replica = AccountReplica::new(owner.clone(), state).unwrap();
    replica.set_delta_transformer([0x77; 20]);
    xln_rscore_engine::prepare_settlement_execution(&replica).expect("actual signed TS workspace");
    let signing = SigningIdentity::lazy_from_seed(
        "entity-settlement-semantic-fixture",
        "local",
        1,
        1,
        BoardDelays::default(),
    )
    .unwrap();
    let signer = signing.signer_id().to_string();
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([1; 8]),
        1,
        0,
        derive_signer_key("entity-settlement-semantic-fixture", "local").unwrap(),
        signer.clone(),
        support::market(),
        vec![AccountSeed {
            account_id: AccountId::from_bytes(*peer.as_bytes()),
            replica,
            consensus: None,
        }],
    )
    .unwrap();
    let mut state = EntityStateSlice::empty(owner.to_string(), 2000);
    state.known_accounts.insert(peer.to_string());
    let continuation = CanonicalValue::Object(vec![
        (
            "workspaceHash".into(),
            canonical(&case["accountView"]["settlementWorkspace"]["workspaceHash"]),
        ),
        ("actions".into(), CanonicalValue::Array(vec![])),
        ("broadcast".into(), CanonicalValue::Bool(false)),
    ]);
    state.settlement_continuations =
        Some(EntityCanonicalCollection::from_entries([(peer.to_string(), continuation)]).unwrap());
    state.j_batch_state = Some(JBatchState {
        sent_batch: Some(SentJBatch {
            batch: JBatch::default(),
            batch_hash: [0x44; 32],
            encoded_batch: vec![],
            entity_nonce: 1,
            first_submitted_at: 1,
            last_submitted_at: 1,
            submit_attempts: 1,
            fee_overrides: None,
            transaction_hash: None,
            last_failure: None,
            terminal_failure: None,
        }),
        status: JBatchStatus::Sent,
        ..Default::default()
    });
    let mut authority = single_signer_authority(&signer);
    authority.config.jurisdiction = Some(CanonicalValue::Object(vec![
        (
            "chainId".into(),
            CanonicalValue::Number(CanonicalNumber::try_from_u64(31337).unwrap()),
        ),
        (
            "depositoryAddress".into(),
            CanonicalValue::String("0x8888888888888888888888888888888888888888".into()),
        ),
        (
            "entityProviderAddress".into(),
            CanonicalValue::String("0x9999999999999999999999999999999999999999".into()),
        ),
    ]));
    let events = vec![JurisdictionEvent::HankoBatchProcessed(
        HankoBatchProcessedEvent {
            metadata: JEventMetadata {
                block_number: Some(1),
                block_hash: Some([0x11; 32]),
                transaction_hash: Some([0x55; 32]),
                log_index: Some(0),
                event_index: None,
            },
            entity_id: owner.clone(),
            batch_hash: [0x44; 32],
            nonce: 1,
        },
    )];
    let root = accounts.accounts_root();
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *owner.as_bytes(),
                owning_entity_is_hub: false,
                expected_accounts_root: root,
                clock: ReceiverClock {
                    entity_timestamp: 2000,
                    finalized_j_height: 0,
                },
                rows: vec![],
                post_accounts: false,
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: 2000,
            outbound_j_height: 1,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: Some("entity-settlement-semantic-fixture".into()),
            scheduled_wake: None,
            propose_accounts_now: vec![],
            expected_proposer_signer_id: signer.clone(),
            finalized_j_events: Some(ResidentJEventProjection {
                scanned_through: 1,
                runtime_seed: "entity-settlement-semantic-fixture".into(),
                proposer_signer_id: signer,
                proposer_signature: "0x".into(),
                claim: xln_rscore_entity_kernel::JPrefixRangeClaim {
                    jurisdiction_ref: "fixture".into(),
                    base_height: 0,
                    scanned_through_height: 1,
                    tip_block_hash: format!("0x{}", "11".repeat(32)),
                    event_history_root: format!("0x{}", "22".repeat(32)),
                    range_hash: format!("0x{}", "33".repeat(32)),
                    headers: vec![],
                    blocks: vec![],
                },
                batches: vec![FinalizedJEventBatch {
                    j_height: 1,
                    j_block_hash: [0x11; 32],
                    events,
                    reserve_updates: vec![],
                    account_claims: vec![],
                    dispute_finalization_evidence: vec![],
                }],
            }),
            entity_authority: Some(authority),
            local_account_genesis_policy: None,
            cross_j_opening_sibling_views: vec![],
            operations: vec![],
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("one receipt Entity frame");
    assert!(
        result
            .state
            .settlement_continuations
            .as_ref()
            .unwrap()
            .is_empty(),
        "matching J receipt must execute the already signed continuation in this frame"
    );
    assert_eq!(
        result
            .state
            .j_batch_state
            .as_ref()
            .unwrap()
            .batch
            .settlements
            .len(),
        1
    );
}
