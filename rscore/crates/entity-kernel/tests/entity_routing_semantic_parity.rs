mod support;

use std::collections::{BTreeMap, BTreeSet};

use ethabi::ethereum_types::U256;
use num_bigint::BigInt;
use support::{HUB, digest_bytes, entity_state};
use xln_rscore_engine::{EntityId, JEventMetadata, JurisdictionEvent, ReserveUpdatedEvent};
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, ConsensusMode, CrossJurisdictionRuntimeOutput, EntityConsensusConfig,
    EntityConsensusSection, EntityFrameAuthority, EntityFrameEvent, EntityLeaderState,
    EntityStateSlice, EntityTxKind, FinalizedJEventBatch, JReserveUpdate, LocalEntityControlTx,
    apply_finalized_j_event_batches, apply_local_entity_control_tx, authorize_runtime_output,
    compute_entity_consensus_root, compute_entity_owned_sections, decode_local_entity_control_tx,
    project_entity_consensus_sections,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

const PEER: [u8; 32] = [0x22; 32];
const EXTERNAL: [u8; 32] = [0x33; 32];

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/entity-routing-semantics/parity-v1.json"
    )))
    .expect("TypeScript Entity routing semantic fixture")
}

fn case<'a>(fixture: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    fixture["cases"]
        .as_array()
        .expect("fixture cases")
        .iter()
        .find(|row| row["name"].as_str() == Some(name))
        .unwrap_or_else(|| panic!("missing fixture case {name}"))
}

fn authority() -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![HUB.into()],
            shares: BTreeMap::from([(HUB.into(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: HUB.into(),
            view: 0,
            changed_at_height: 0,
        },
    }
}

fn carried_sections() -> Vec<EntityConsensusSection> {
    vec![EntityConsensusSection {
        field: "nonces".into(),
        digest: "0x76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71".into(),
    }]
}

fn assert_case(name: &str, tx: LocalEntityControlTx) {
    let fixture = fixture();
    let expected = case(&fixture, name);
    let mut state = entity_state(2_000);
    state.reserves.insert(1, BigInt::from(100));
    let mut events = Vec::new();
    let result = apply_local_entity_control_tx(&mut state, tx, &mut events, &authority(), 0)
        .expect("production local Entity reducer");

    let accounts_root = digest_bytes(expected["accountsRoot"].as_str().expect("accounts root"));
    let sections = compute_entity_owned_sections(&state, accounts_root, 0).expect("owned sections");
    let sections = project_entity_consensus_sections(&carried_sections(), sections, &authority())
        .expect("complete sections");
    assert_eq!(
        compute_entity_consensus_root(&sections).expect("Entity root"),
        expected["stateRoot"].as_str().expect("state root"),
    );
    let expected_events = expected["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|row| EntityFrameEvent::Status {
            message: row["message"].as_str().expect("status message").into(),
        })
        .collect::<Vec<_>>();
    assert_eq!(events, expected_events);
    assert!(result.j_outputs.is_empty());
    assert!(result.hashes_to_sign.is_empty());
    assert!(result.approved_entity_txs.is_empty());
    assert_eq!(expected["effects"].as_array().expect("effects").len(), 0);
    assert_eq!(
        expected["outbox"]["outputs"]
            .as_array()
            .expect("outputs")
            .len(),
        0
    );
}

fn e2r_tx() -> LocalEntityControlTx {
    let tx = CanonicalEntityTx::from_frame_projection(
        xln_rscore_entity_kernel::EntityTxKind::E2r,
        CanonicalValue::Object(vec![
            (
                "contractAddress".into(),
                CanonicalValue::String(format!("0x{}", "44".repeat(20))),
            ),
            (
                "tokenType".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(1)),
            ),
            (
                "externalTokenId".into(),
                CanonicalValue::BigInt(BigInt::from(7)),
            ),
            (
                "internalTokenId".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(1)),
            ),
            ("amount".into(), CanonicalValue::BigInt(BigInt::from(9))),
        ]),
    )
    .expect("canonical e2r");
    decode_local_entity_control_tx(&tx)
        .expect("decode e2r")
        .expect("control e2r")
}

#[test]
fn reserve_and_j_batch_control_reducers_match_typescript_roots_events_effects_and_outbox() {
    assert_case("e2r-queues-external-token-deposit", e2r_tx());
    assert_case(
        "r2e-queues-external-withdrawal",
        LocalEntityControlTx::R2e {
            receiving_entity: EXTERNAL,
            token_id: 1,
            amount: U256::from(8),
        },
    );
    assert_case(
        "r2r-queues-reserve-transfer",
        LocalEntityControlTx::R2r {
            receiving_entity: PEER,
            token_id: 1,
            amount: U256::from(7),
        },
    );
    assert_case(
        "r2c-queues-remote-collateral",
        LocalEntityControlTx::R2c {
            receiving_entity: Some(PEER),
            counterparty: EXTERNAL,
            token_id: 1,
            amount: U256::from(6),
        },
    );
    assert_case(
        "j-rebroadcast-without-sent-batch-is-a-signed-warning",
        LocalEntityControlTx::JRebroadcast {
            gas_bump_bps: Some(1_250),
        },
    );
    assert_case(
        "j-abort-without-sent-batch-is-a-signed-warning",
        LocalEntityControlTx::JAbortSentBatch {
            reason: Some("fixture".into()),
            requeue_to_current: true,
        },
    );
    assert_case(
        "j-clear-without-batch-is-a-signed-warning",
        LocalEntityControlTx::JClearBatch {
            reason: Some("fixture".into()),
        },
    );
}

#[test]
fn runtime_output_authorizes_then_reenters_the_same_typescript_matched_reducer() {
    let fixture = fixture();
    let expected = case(&fixture, "runtime-output-reenters-the-canonical-reducer");
    let mut state = entity_state(2_000);
    state.reserves.insert(1, BigInt::from(100));
    let nested = CanonicalEntityTx::from_frame_projection(
        EntityTxKind::JAbortSentBatch,
        CanonicalValue::Object(vec![
            (
                "reason".into(),
                CanonicalValue::String("runtime-output".into()),
            ),
            ("requeueToCurrent".into(), CanonicalValue::Bool(true)),
        ]),
    )
    .expect("nested abort");
    authorize_runtime_output(
        &state,
        &CrossJurisdictionRuntimeOutput {
            source_entity_id: HUB.into(),
            source_signer_id: HUB.into(),
            target_entity_id: HUB.into(),
            entity_txs: vec![nested.clone()],
        },
        &authority(),
    )
    .expect("self Runtime output authority");
    let decoded = decode_local_entity_control_tx(&nested)
        .expect("decode nested tx")
        .expect("nested control tx");
    let mut events = Vec::new();
    let result = apply_local_entity_control_tx(&mut state, decoded, &mut events, &authority(), 0)
        .expect("canonical nested reducer");
    assert_eq!(
        events,
        vec![EntityFrameEvent::Status {
            message: expected["events"][0]["message"]
                .as_str()
                .expect("event")
                .into(),
        }]
    );
    let sections = compute_entity_owned_sections(&state, [0; 32], 0).expect("sections");
    let sections = project_entity_consensus_sections(&carried_sections(), sections, &authority())
        .expect("complete sections");
    assert_eq!(
        compute_entity_consensus_root(&sections).expect("root"),
        expected["stateRoot"].as_str().expect("state root")
    );
    assert!(result.j_outputs.is_empty());
    assert!(result.hashes_to_sign.is_empty());
}

#[test]
fn authenticated_j_event_matches_typescript_event_effect_and_empty_outbox_projection() {
    let fixture = fixture();
    let expected = case(&fixture, "j-event-applies-authenticated-reserve-finality");
    let owner = EntityId::parse(HUB).expect("owner");
    let event = JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
        metadata: JEventMetadata {
            block_number: Some(43),
            block_hash: Some([0xaa; 32]),
            transaction_hash: Some([0xbb; 32]),
            log_index: Some(0),
            event_index: Some(0),
        },
        entity: owner.as_hex(),
        token_id: 1,
        new_balance: BigInt::from(91),
    });
    let mut state = EntityStateSlice::empty(HUB, 1_000);
    let result = apply_finalized_j_event_batches(
        &mut state,
        43,
        &[FinalizedJEventBatch {
            j_height: 43,
            j_block_hash: [0xaa; 32],
            events: vec![event],
            dispute_finalization_evidence: vec![],
            reserve_updates: vec![JReserveUpdate {
                token_id: 1,
                own_reserve: BigInt::from(91),
            }],
            account_claims: vec![],
        }],
        "entity-routing-j-event",
        None,
        &BTreeSet::new(),
        &BTreeMap::new(),
    )
    .expect("production J watcher reducer");

    assert_eq!(state.last_finalized_j_height, 43);
    assert_eq!(state.reserves.get(&1), Some(&BigInt::from(91)));
    assert_eq!(
        result.frame_events,
        vec![EntityFrameEvent::Status {
            message: expected["events"][0]["message"]
                .as_str()
                .expect("event")
                .into(),
        }]
    );
    assert!(result.proposal_work.is_empty());
    assert!(result.routed_entity_outputs.is_empty());
    let effect = &expected["effects"][0];
    assert_eq!(effect["eventName"], "JEventReceived");
    assert_eq!(effect["data"]["tokenId"], 1);
    assert_eq!(effect["data"]["newBalance"], "91");
    assert!(
        expected["outbox"]["accountTxs"]
            .as_array()
            .expect("outbox")
            .is_empty()
    );
}
