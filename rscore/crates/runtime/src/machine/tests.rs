use std::collections::BTreeMap;
use std::sync::Arc;

use xln_rscore_batch::{AccountId, AccountSeed, EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState,
    BoardDelays, DepositoryAddress, EntityId, SigningIdentity, SwapMarketPolicy, WatchSeed,
    derive_signer_key,
};
use xln_rscore_entity_kernel::{
    ConsensusMode, CrontabState, DeterministicContext, EntityConsensusConfig, EntityConsensusState,
    EntityFrameAuthority, EntityHtlcNoteIndex, EntityLeaderState, EntitySingleSigner,
    EntityStateSlice, EntityTxKind, ResidentEntityConsensusReplica, ScheduledHook,
};
use xln_rscore_protocol::CanonicalValue;

use super::{
    RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, RuntimeLimits, RuntimeMachineError,
    RuntimeMempool, RuntimeReplica, RuntimeState, RuntimeTx, ScheduledWakeIndex, apply_runtime,
    materialization_due, select_runtime_frame,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
pub(super) const SIGNER: &str = "h1-hub";

#[test]
fn materialization_cadence_is_relative_to_the_restored_checkpoint() {
    assert!(materialization_due(1, 0, 100));
    assert!(!materialization_due(100, 5, 100));
    assert!(materialization_due(105, 5, 100));
    assert!(!materialization_due(106, 105, 100));
}

fn fixture<T, E: std::fmt::Debug>(result: Result<T, E>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("fixture failed: {error:?}"),
    }
}

pub(crate) fn owner_bytes() -> [u8; 32] {
    let identity = fixture(SigningIdentity::lazy_from_seed(
        SEED,
        SIGNER,
        1,
        1,
        BoardDelays::default(),
    ));
    *identity.entity_id()
}

fn hex32(bytes: [u8; 32]) -> String {
    let mut value = String::from("0x");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

pub(crate) fn replica(limits: RuntimeLimits) -> Result<RuntimeReplica, RuntimeMachineError> {
    replica_with_deltas(limits, Vec::new())
}

pub(crate) fn replica_with_deltas(
    limits: RuntimeLimits,
    deltas: Vec<xln_rscore_engine::Delta>,
) -> Result<RuntimeReplica, RuntimeMachineError> {
    let owner = owner_bytes();
    let owner_id = fixture(EntityId::parse(&hex32(owner)));
    // The derived hub begins with 0x60; choose a lexicographically greater
    // counterparty so AccountIdentity receives canonical left/right parties.
    let peer_id = fixture(EntityId::parse(&format!("0x{}", "ff".repeat(32))));
    let account_id = AccountId::from_bytes(*peer_id.as_bytes());
    let account_state = fixture(AccountState::new(
        fixture(AccountIdentity::new(
            fixture(AccountDomain::new(
                31_337,
                fixture(DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))),
            )),
            owner_id.clone(),
            peer_id,
            fixture(WatchSeed::parse(&format!("0x{}", "99".repeat(32)))),
        )),
        fixture(AccountDisputeConfig::new(10, 10)),
        deltas,
    ));
    let seed = AccountSeed {
        account_id,
        replica: fixture(AccountReplica::new(owner_id, account_state)),
        consensus: None,
    };
    let accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x22; 8]),
        1,
        0,
        fixture(derive_signer_key(SEED, SIGNER)),
        SIGNER.to_string(),
        Arc::new(SwapMarketPolicy::default()),
        vec![seed],
    )
    .map_err(|error| {
        RuntimeMachineError::Entity(xln_rscore_entity_kernel::ResidentEntityError::Account(
            error,
        ))
    })?;
    let accounts_root = accounts.accounts_root();
    let mut entity = EntityStateSlice::empty(hex32(owner), 100);
    entity.known_accounts.insert(hex32(*account_id.as_bytes()));
    let authority = EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![SIGNER.to_string()],
            shares: BTreeMap::from([(SIGNER.to_string(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: SIGNER.to_string(),
            view: 0,
            changed_at_height: 0,
        },
    };
    let entity_consensus = ResidentEntityConsensusReplica {
        state: EntityConsensusState {
            sections: Vec::new(),
            authority,
        },
        certified_frame_head: None,
        htlc_notes: EntityHtlcNoteIndex::default(),
    };
    let entity_signer = fixture(EntitySingleSigner::from_seed(
        SEED,
        SIGNER,
        &entity.entity_id,
        1,
        1,
        BoardDelays::default(),
    ));
    RuntimeReplica::new(
        RuntimeState {
            height: 0,
            timestamp: 100,
            finalized_j_height: 0,
            accounts_root,
            entity,
        },
        crate::processor::RuntimeDurableEnvelope::fixture(),
        owner,
        SIGNER.to_string(),
        accounts,
        entity_consensus,
        entity_signer,
        limits,
    )
}

fn entity_input(wire_bytes: usize) -> RuntimeEntityInput {
    entity_input_marked(wire_bytes, wire_bytes)
}

fn entity_input_marked(wire_bytes: usize, marker: usize) -> RuntimeEntityInput {
    RuntimeEntityInput::fixture(serde_json::json!({ "marker": marker }), wire_bytes)
}

fn frame(timestamp: u64, entity_inputs: Vec<RuntimeEntityInput>) -> RuntimeInput {
    frame_at(timestamp, 0, entity_inputs)
}

fn frame_at(
    timestamp: u64,
    finalized_j_height: u64,
    entity_inputs: Vec<RuntimeEntityInput>,
) -> RuntimeInput {
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs,
        frame: RuntimeFrameContext {
            timestamp,
            finalized_j_height,
            hub_rebalance_has_pending_work: false,
            entity_context: DeterministicContext::hlt_default(),
            canonical_entity_context: CanonicalValue::Object(Vec::new()),
        },
    }
}

fn account_ack_entity_input() -> serde_json::Value {
    let owner = hex32(owner_bytes());
    serde_json::json!({
        "entityId": owner,
        "signerId": SIGNER,
        "entityTxs": [{
            "type": "accountInput",
            "data": {
                "fromEntityId": format!("0x{}", "ff".repeat(32)),
                "toEntityId": hex32(owner_bytes()),
                "domain": {
                    "chainId": 31_337,
                    "depositoryAddress": format!("0x{}", "88".repeat(20))
                },
                "disputeConfig": {
                    "leftResponseSeconds": 10,
                    "rightResponseSeconds": 10
                },
                "watchSeed": format!("0x{}", "99".repeat(32)),
                "kind": "ack",
                "ack": {
                    "height": 1,
                    "frameHash": format!("0x{}", "77".repeat(32)),
                    "frameHanko": "0x0304"
                }
            }
        }]
    })
}

#[test]
fn entity_input_is_decoded_into_one_consistent_owned_projection() -> Result<(), RuntimeMachineError>
{
    let canonical = account_ack_entity_input();
    let input = RuntimeEntityInput::decode(canonical.clone())?;
    assert_eq!(input.entity_id(), &owner_bytes());
    assert_eq!(input.signer_id(), SIGNER);
    assert_eq!(input.account_input_count(), 1);
    assert!(input.canonical_wire_bytes() > 0);
    let (retained, projected, rows, local_financial_txs) = input.into_parts();
    assert_eq!(retained, canonical);
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].kind, EntityTxKind::AccountInput);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].operation_index, 0);
    assert!(local_financial_txs.is_empty());
    Ok(())
}

#[test]
fn entity_input_cannot_smuggle_an_independent_projection() {
    let mut canonical = account_ack_entity_input();
    if let Some(object) = canonical.as_object_mut() {
        object.insert("canonicalEntityTxs".into(), serde_json::json!([]));
    }
    let error = RuntimeEntityInput::decode(canonical);
    assert!(matches!(
        error,
        Err(RuntimeMachineError::EntityInputFieldUnsupported(field))
            if field == "canonicalEntityTxs"
    ));
}

#[test]
fn direct_payment_is_decoded_into_the_typed_local_financial_lane() -> Result<(), RuntimeMachineError>
{
    let owner = hex32(owner_bytes());
    let peer = format!("0x{}", "ff".repeat(32));
    let canonical = serde_json::json!({
        "entityId": owner,
        "signerId": SIGNER,
        "entityTxs": [{
            "type":"directPayment",
            "data":{
                "targetEntityId":peer,
                "tokenId":1,
                "amount":{"__xlnType":"BigInt","value":"7"},
                "route":[owner, peer],
                "description":"exact local payment",
                "deliveryMode":"direct"
            }
        }]
    });
    let input = RuntimeEntityInput::decode(canonical)?;
    let (_, projected, account_rows, execution_steps) = input.into_parts();
    // Local financial requests are not themselves Entity-frame transactions;
    // the Runtime signs their canonical entityCommand wrapper during apply.
    assert!(projected.is_empty());
    assert!(account_rows.is_empty());
    assert!(matches!(
        execution_steps.as_slice(),
        [super::types::EntityExecutionStep::LocalBatch { native, .. }]
            if matches!(native.as_slice(), [
                xln_rscore_entity_kernel::LocalEntityFinancialTx::DirectPayment(tx)
            ]
            if tx.amount == 7.into()
                && tx.description.as_deref() == Some("exact local payment"))
    ));
    Ok(())
}

#[test]
fn recognized_but_unconnected_local_entity_tx_is_loud() {
    let canonical = serde_json::json!({
        "entityId": hex32(owner_bytes()),
        "signerId": SIGNER,
        "entityTxs": [{"type":"extendCredit","data":{}}]
    });
    assert!(matches!(
        RuntimeEntityInput::decode(canonical),
        Err(RuntimeMachineError::EntityTxExecutionUnsupported(
            "extendCredit"
        ))
    ));
}

#[test]
fn runtime_tx_only_selection_retains_its_context() -> Result<(), RuntimeMachineError> {
    let selected_context = frame_at(321, 7, Vec::new()).frame;
    let mut mempool = RuntimeMempool::empty();
    mempool.runtime_txs.push_back(RuntimeTx::Unsupported {
        kind: "fixture-only".to_string(),
    });
    mempool.queued_at = Some(selected_context.timestamp);
    let selected =
        select_runtime_frame(&mut mempool, RuntimeLimits::hlt(), selected_context.clone())?
            .ok_or(RuntimeMachineError::InputCountOverflow)?;
    assert_eq!(selected.runtime_txs.len(), 1);
    assert!(selected.entity_inputs.is_empty());
    assert_eq!(selected.frame, selected_context);
    assert!(mempool.is_empty());
    Ok(())
}

#[test]
fn no_work_does_not_advance_runtime() -> Result<(), RuntimeMachineError> {
    let result = apply_runtime(replica(RuntimeLimits::hlt())?, frame(100, Vec::new()))?;
    assert_eq!(result.replica.state.height, 0);
    assert!(result.applied_input.is_none());
    assert!(result.applied_frame.is_none());
    assert!(result.outputs.local_entity_outputs.is_empty());
    Ok(())
}

#[test]
fn applied_frame_is_exact_selected_prefix_and_deferred_body_stays_queued()
-> Result<(), RuntimeMachineError> {
    let limits = RuntimeLimits {
        max_entity_inputs_per_frame: 1,
        checkpoint_period_frames: 0,
        ..RuntimeLimits::hlt()
    };
    let first = apply_runtime(
        replica(limits)?,
        frame(
            200,
            vec![entity_input_marked(7, 11), entity_input_marked(9, 22)],
        ),
    )?;
    let first_body = match first.applied_frame.as_ref() {
        Some(body) => body,
        None => panic!("selected Runtime frame body missing"),
    };
    assert_eq!(
        first_body.entity_inputs,
        vec![serde_json::json!({ "marker": 11 })]
    );
    assert!(first_body.runtime_txs.is_empty());
    assert_eq!(first_body.frame.timestamp, 200);
    assert_eq!(first.replica.mempool.entity_input_count(), 1);

    let second = apply_runtime(first.replica, frame(900, Vec::new()))?;
    let second_body = match second.applied_frame.as_ref() {
        Some(body) => body,
        None => panic!("deferred Runtime frame body missing"),
    };
    assert_eq!(
        second_body.entity_inputs,
        vec![serde_json::json!({ "marker": 22 })]
    );
    assert_eq!(second_body.frame.timestamp, 900);
    assert_eq!(second.replica.mempool.entity_input_count(), 0);
    Ok(())
}

#[test]
fn entity_fifo_defers_only_whole_inputs() -> Result<(), RuntimeMachineError> {
    let limits = RuntimeLimits {
        max_entity_inputs_per_frame: 1,
        checkpoint_period_frames: 0,
        ..RuntimeLimits::hlt()
    };
    let first = apply_runtime(
        replica(limits)?,
        frame(200, vec![entity_input(7), entity_input(9)]),
    )?;
    assert_eq!(first.replica.state.height, 1);
    assert_eq!(first.replica.mempool.entity_input_count(), 1);
    assert_eq!(
        first
            .applied_input
            .as_ref()
            .map(|value| value.canonical_wire_bytes),
        Some(7)
    );

    let second = apply_runtime(first.replica, frame(300, Vec::new()))?;
    assert_eq!(second.replica.state.height, 2);
    // Runtime owns one flat FIFO and one current frame context, matching the
    // TypeScript machine: deferred rows execute under the latest queued time.
    assert_eq!(second.replica.state.timestamp, 300);
    assert_eq!(second.replica.mempool.entity_input_count(), 0);
    assert_eq!(
        second
            .applied_input
            .as_ref()
            .map(|value| value.canonical_wire_bytes),
        Some(9)
    );
    Ok(())
}

#[test]
fn deferred_rows_share_the_latest_runtime_context() -> Result<(), RuntimeMachineError> {
    let limits = RuntimeLimits {
        max_entity_inputs_per_frame: 1,
        checkpoint_period_frames: 0,
        ..RuntimeLimits::hlt()
    };
    let first = apply_runtime(
        replica(limits)?,
        frame(200, vec![entity_input(7), entity_input(9)]),
    )?;
    let second = apply_runtime(first.replica, frame_at(900, 9, vec![entity_input(11)]))?;
    assert_eq!(second.replica.state.timestamp, 900);
    assert_eq!(second.replica.state.finalized_j_height, 9);
    assert_eq!(second.replica.mempool.entity_input_count(), 1);
    let pending = second
        .replica
        .mempool
        .pending_entity_inputs()
        .map(|value| value.get("marker").and_then(serde_json::Value::as_u64))
        .collect::<Vec<_>>();
    assert_eq!(pending, vec![Some(11)]);
    assert_eq!(
        second
            .applied_input
            .as_ref()
            .map(|input| input.canonical_wire_bytes),
        Some(9)
    );
    let third = apply_runtime(second.replica, frame_at(1_000, 9, Vec::new()))?;
    assert_eq!(third.replica.state.timestamp, 1_000);
    assert_eq!(third.replica.state.finalized_j_height, 9);
    assert_eq!(
        third
            .applied_input
            .as_ref()
            .map(|input| input.canonical_wire_bytes),
        Some(11)
    );
    Ok(())
}

#[test]
fn oversized_head_fails_instead_of_splitting() -> Result<(), RuntimeMachineError> {
    let limits = RuntimeLimits {
        max_entity_wire_bytes_per_frame: 8,
        ..RuntimeLimits::hlt()
    };
    let error = match apply_runtime(replica(limits)?, frame(200, vec![entity_input(9)])) {
        Ok(_) => panic!("oversized head unexpectedly applied"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        RuntimeMachineError::HeadWireUnfittable {
            actual: 9,
            limit: 8
        }
    ));
    Ok(())
}

#[test]
fn excluded_runtime_tx_is_loud_before_state_mutation() -> Result<(), RuntimeMachineError> {
    let mut input = frame(200, vec![entity_input(7)]);
    input.runtime_txs.push(RuntimeTx::Unsupported {
        kind: "importReplica".to_string(),
    });
    let error = match apply_runtime(replica(RuntimeLimits::hlt())?, input) {
        Ok(_) => panic!("excluded RuntimeTx unexpectedly applied"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        RuntimeMachineError::UnsupportedRuntimeTx { ref kind } if kind == "importReplica"
    ));
    Ok(())
}

#[test]
fn scheduled_wakes_are_deadline_then_id_ordered() -> Result<(), RuntimeMachineError> {
    let mut state = EntityStateSlice::empty(hex32(owner_bytes()), 100);
    state.crontab = Some(CrontabState {
        tasks: BTreeMap::new(),
        hooks: BTreeMap::from([
            (
                "later".to_string(),
                ScheduledHook::htlc_timeout("a".to_string(), "later".to_string(), 300),
            ),
            (
                "b".to_string(),
                ScheduledHook::htlc_timeout("a".to_string(), "b".to_string(), 200),
            ),
            (
                "a".to_string(),
                ScheduledHook::htlc_timeout("a".to_string(), "a".to_string(), 200),
            ),
        ]),
    });
    let index = ScheduledWakeIndex::from_entity_state(&state)?;
    assert_eq!(index.next_timestamp(), Some(200));
    let ids = index
        .due(200)
        .into_iter()
        .map(|hook| hook.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["htlc-timeout:a", "htlc-timeout:b"]);
    Ok(())
}

#[test]
fn due_hook_runs_an_entity_round_without_external_ingress() -> Result<(), RuntimeMachineError> {
    let mut runtime = replica(RuntimeLimits {
        checkpoint_period_frames: 0,
        ..RuntimeLimits::hlt()
    })?;
    runtime.state.entity.crontab = Some(CrontabState {
        tasks: BTreeMap::new(),
        hooks: BTreeMap::from([(
            "htlc-timeout:due".to_string(),
            ScheduledHook::htlc_timeout("peer".to_string(), "due".to_string(), 150),
        )]),
    });
    runtime.scheduled_wakes = ScheduledWakeIndex::from_entity_state(&runtime.state.entity)?;
    let result = apply_runtime(runtime, frame(200, Vec::new()))?;
    assert_eq!(result.replica.state.height, 1);
    let wake = result
        .applied_input
        .as_ref()
        .and_then(|input| input.wake.as_ref())
        .and_then(|wake| wake.scheduled.as_ref());
    assert_eq!(wake.map(|wake| wake.due_at), Some(150));
    assert_eq!(wake.map(|wake| wake.jobs.len()), Some(1));
    assert_eq!(
        result
            .applied_input
            .as_ref()
            .map(|input| input.entity_inputs),
        Some(1),
    );
    assert_eq!(
        result
            .applied_frame
            .as_ref()
            .and_then(|frame| frame.entity_inputs.first())
            .and_then(|input| input.get("entityTxs"))
            .and_then(serde_json::Value::as_array)
            .and_then(|txs| txs.first())
            .and_then(|tx| tx.get("type"))
            .and_then(serde_json::Value::as_str),
        Some("scheduledWake"),
    );
    assert_eq!(
        result
            .certified_entity_frame()
            .and_then(|frame| frame.txs.first())
            .map(|tx| tx.kind),
        Some(EntityTxKind::ScheduledWake),
    );
    assert_eq!(
        result
            .replica
            .state
            .entity
            .crontab
            .as_ref()
            .map(|crontab| crontab.hooks.len()),
        Some(0),
    );
    Ok(())
}
