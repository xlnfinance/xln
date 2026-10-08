use super::*;
use xln_rscore_engine::{
    AccountConsensus, AccountExecutionContext, AccountTx, SequentialAccountEngine, Side,
};

pub(crate) fn pending_replica() -> RuntimeReplica {
    let mut runtime = replica_with_account_setup(RuntimeLimits::hlt(), Vec::new(), |seed| {
        let base = seed.replica;
        let data = crate::canonical_value_from_tagged_json(&serde_json::json!({
            "kind": "upsert", "revision": 1, "executorIsLeft": true,
            "ops": [{"type": "forgive", "tokenId": 1}]
        }))
        .expect("canonical upsert");
        let account = SequentialAccountEngine::apply_with_context(
            &base,
            Side::Left,
            &AccountTx::SettleTransition { data },
            &AccountExecutionContext::new(100, 100, 0, 0, 0),
        )
        .expect("workspace transition")
        .committed()
        .expect("workspace applied");
        let CanonicalValue::Object(workspace) =
            account.state().settlement_workspace().expect("workspace")
        else {
            panic!("workspace object")
        };
        let hash = workspace
            .iter()
            .find(|(key, _)| key == "workspaceHash")
            .expect("hash")
            .1
            .clone();
        let mut next = crate::canonical_value_from_tagged_json(&serde_json::json!({
            "kind":"upsert","revision":2,"executorIsLeft":true,
            "ops":[{"type":"forgive","tokenId":1}]
        }))
        .expect("next upsert");
        let CanonicalValue::Object(fields) = &mut next else {
            panic!("upsert object")
        };
        fields.push(("previousWorkspaceHash".into(), hash));
        let mut consensus = AccountConsensus::new(account);
        consensus
            .admit_txs(
                vec![AccountTx::SettleTransition { data: next }],
                "settlement-regression",
            )
            .expect("admit pending transition");
        let identity = SigningIdentity::lazy_from_seed(SEED, SIGNER, 1, 1, BoardDelays::default())
            .expect("signer");
        xln_rscore_engine::propose_account_frame(
            &mut consensus,
            &identity,
            100,
            0,
            &Arc::new(SwapMarketPolicy::default()),
        )
        .expect("signed pending proposal");
        AccountSeed {
            account_id: seed.account_id,
            replica: consensus.replica().clone(),
            consensus: Some(consensus.consensus_snapshot()),
        }
    })
    .expect("runtime");
    let status = runtime
        .e_replicas
        .get_mut(&entity_key())
        .expect("replica")
        .accounts
        .account_status(AccountId::from_bytes([0xff; 32]), Vec::new())
        .expect("status")
        .expect("account");
    assert!(status.settlement_workspace_hash.is_some());
    assert!(status.pending_frame_height.is_some());
    runtime
}

pub(crate) fn input(txs: serde_json::Value) -> RuntimeEntityInput {
    RuntimeEntityInput::decode(serde_json::json!({
        "entityId": hex32(owner_bytes()), "signerId": entity_signer_id(), "entityTxs": txs,
    }))
    .expect("input")
}

#[test]
fn rejected_settlement_outer_command_preserves_healthy_command_and_nonce() {
    let owner = hex32(owner_bytes());
    let bad = input(serde_json::json!([
        {"type": "profile-update", "data": {"profile": {"entityId":owner,"name":"must-rollback"}}},
        {"type": "settle_execute", "data": {"counterpartyEntityId":format!("0x{}", "ff".repeat(32))}}
    ]));
    let healthy = input(serde_json::json!([
        {"type":"chat","data":{"from":entity_signer_id(),"message":"healthy"}}
    ]));
    let run = |inputs| {
        apply_runtime_live(
            pending_replica(),
            RuntimeLiveInput {
                runtime_txs: Vec::new(),
                entity_inputs: inputs,
                timestamp: 200,
                finalized_j_height: 0,
            },
            &mut CanonicalEntityInfraMaterializer::new(),
        )
    };
    let baseline = run(vec![healthy.clone()]).expect("healthy baseline");
    let result = run(vec![bad, healthy]).expect("reject whole outer command without halting");
    let key = entity_key();
    assert_eq!(
        result.replica.state.e_replicas[&key].entity,
        baseline.replica.state.e_replicas[&key].entity
    );
    assert_eq!(
        result.replica.state.e_replicas[&key].accounts_root,
        baseline.replica.state.e_replicas[&key].accounts_root
    );
    assert_eq!(
        result.outputs.entities.len(),
        baseline.outputs.entities.len()
    );
    assert_eq!(
        result.outputs.entities[0].entity_frame_hash,
        baseline.outputs.entities[0].entity_frame_hash
    );
    assert_eq!(
        result.outputs.entities[0].entity_frame_events,
        baseline.outputs.entities[0].entity_frame_events
    );
}

#[test]
fn rejected_settlement_only_command_has_no_entity_frame_and_replays_context() {
    let bad = input(serde_json::json!([
        {"type":"settle_execute","data":{"counterpartyEntityId":format!("0x{}", "ff".repeat(32))}}
    ]));
    let before = pending_replica();
    let key = entity_key();
    let before_entity = before.state.e_replicas[&key].entity.clone();
    let before_root = before.state.e_replicas[&key].accounts_root;
    let mut result = apply_runtime_live(
        before,
        RuntimeLiveInput {
            runtime_txs: Vec::new(),
            entity_inputs: vec![bad],
            timestamp: 200,
            finalized_j_height: 0,
        },
        &mut CanonicalEntityInfraMaterializer::new(),
    )
    .expect("evict only command");
    assert!(result.outputs.entities.is_empty());
    assert!(result.account_commits.is_empty());
    assert_eq!(result.replica.state.e_replicas[&key].entity, before_entity);
    assert_eq!(
        result.replica.state.e_replicas[&key].accounts_root,
        before_root
    );
    assert_eq!(result.replica.state.height, 1);
    let applied = result
        .applied_frame
        .take()
        .expect("Runtime input remains journalled");
    assert_eq!(applied.entity_inputs.len(), 1);
    assert_eq!(applied.entity_frame_count, 0);
    assert_eq!(applied.frame.entity_contexts[&key].len(), 1);
    let replay = apply_runtime(
        pending_replica(),
        RuntimeInput {
            runtime_txs: applied.runtime_txs,
            entity_inputs: applied
                .entity_inputs
                .into_iter()
                .map(RuntimeEntityInput::decode)
                .collect::<Result<_, _>>()
                .expect("recorded inputs"),
            frame: applied.frame,
        },
    )
    .expect("same WAL input and rejected-attempt context replay");
    assert!(replay.outputs.entities.is_empty());
    assert_eq!(replay.replica.state.e_replicas[&key].entity, before_entity);
    assert_eq!(
        replay.replica.state.e_replicas[&key].accounts_root,
        before_root
    );
}

pub(crate) fn separated_attempts(reject_last: bool) -> (RuntimeReplica, Vec<RuntimeEntityInput>) {
    let mut runtime = pending_replica();
    let mut other =
        replica_with_named_signer(RuntimeLimits::hlt(), Vec::new(), "segment-b", |account| {
            account
        })
        .expect("second sovereign entity");
    let other_key = other
        .state
        .e_replicas
        .keys()
        .next()
        .expect("second entity")
        .clone();
    let (state, replica) = other
        .take_entity_slot(&other_key.entity_id, &other_key.signer_id)
        .expect("second slot");
    runtime
        .install_entity_slot(other_key.clone(), state, replica)
        .expect("install second entity");
    // Establish both sovereign Entity heads through real signed frames before
    // testing a Runtime frame that intentionally leaves one height unchanged.
    let warmup = runtime.state.e_replicas.keys().map(|key| RuntimeEntityInput::decode(serde_json::json!({
        "entityId":hex32(key.entity_id),"signerId":key.signer_id,"entityTxs":[{"type":"chat","data":{"from":key.signer_id,"message":"establish head"}}]
    })).expect("warmup command")).collect();
    runtime = apply_runtime_live(
        runtime,
        RuntimeLiveInput {
            runtime_txs: Vec::new(),
            entity_inputs: warmup,
            timestamp: 150,
            finalized_j_height: 0,
        },
        &mut CanonicalEntityInfraMaterializer::new(),
    )
    .expect("signed Entity heads")
    .replica;
    let bad = input(
        serde_json::json!([{"type":"settle_execute","data":{"counterpartyEntityId":format!("0x{}", "ff".repeat(32))}}]),
    );
    let mut last = if reject_last {
        bad.canonical().clone()
    } else {
        input(serde_json::json!([{"type":"chat","data":{"from":entity_signer_id(),"message":"after rejected segment"}}])).canonical().clone()
    };
    let marker = serde_json::json!({"phase":"ack","pairKey":"settlement-segment-regression"});
    last["atomicCrossJurisdictionPair"] = marker.clone();
    let other_input = RuntimeEntityInput::decode(serde_json::json!({
        "entityId":hex32(other_key.entity_id),"signerId":other_key.signer_id,"entityTxs":[{"type":"chat","data":{"from":other_key.signer_id,"message":"healthy sibling segment"}}],"atomicCrossJurisdictionPair":marker
    })).expect("atomic sibling input");
    (
        runtime,
        vec![
            bad,
            other_input,
            RuntimeEntityInput::decode(last).expect("last segment"),
        ],
    )
}

#[test]
fn negative_settlement_proposal_rejects_without_losing_healthy_inputs() {
    let owner = hex32(owner_bytes());
    let before = serde_json::json!({"type":"profile-update","data":{"profile":{"entityId":owner,"name":"healthy-before-reject"}}});
    let bad = serde_json::json!({"type":"settle_propose","data":{"counterpartyEntityId":format!("0x{}", "ff".repeat(32)),"ops":[{"type":"r2r","tokenId":1,"amount":{"__xlnType":"BigInt","value":"-1"}}]}});
    let after = serde_json::json!({"type":"profile-update","data":{"profile":{"entityId":owner,"bio":"healthy-after-reject"}}});
    let run = |inputs| {
        apply_runtime_live(
            replica_with_account_setup(RuntimeLimits::hlt(), Vec::new(), |seed| seed).unwrap(),
            RuntimeLiveInput {
                runtime_txs: Vec::new(),
                entity_inputs: inputs,
                timestamp: 200,
                finalized_j_height: 0,
            },
            &mut CanonicalEntityInfraMaterializer::new(),
        )
    };
    let expected = run(vec![
        input(serde_json::json!([before])),
        input(serde_json::json!([after])),
    ])
    .unwrap();
    let poison = serde_json::json!({"type":"profile-update","data":{"profile":{"entityId":owner,"name":"must-rollback"}}});
    let actual = run(vec![
        input(serde_json::json!([before])),
        input(serde_json::json!([poison, bad])),
        input(serde_json::json!([after])),
    ])
    .expect("invalid user amount cannot halt runtime");
    assert_eq!(
        actual.replica.state.e_replicas[&entity_key()].entity,
        expected.replica.state.e_replicas[&entity_key()].entity
    );
    assert_eq!(
        actual.replica.state.e_replicas[&entity_key()].accounts_root,
        expected.replica.state.e_replicas[&entity_key()].accounts_root
    );
}
