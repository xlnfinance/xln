use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use num_bigint::BigInt;
use serde_json::{Value, json};
use xln_rscore_batch::{AccountId, AccountSeed, EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState,
    BoardDelays, Delta, DepositoryAddress, EntityId, SigningIdentity, SwapMarketPolicy, TokenId,
    WatchSeed, derive_signer_address, derive_signer_key,
};
use xln_rscore_entity_kernel::{
    ConsensusMode, DeterministicContext, EntityConsensusConfig, EntityConsensusState,
    EntityFrameAuthority, EntityHtlcNoteIndex, EntityLeaderState, EntitySingleSigner,
    EntityStateSlice, ResidentEntityConsensusReplica,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::{
    DurableRuntimeProcessor, DurableRuntimeProcessorError, EntityRoute, EntityRouteTable,
    ResidentRuntimeService, RuntimeDurableEnvelope, RuntimeSignerLabel,
};
use crate::machine::{
    RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, RuntimeLimits, RuntimeLiveInput,
    RuntimeReplica, RuntimeState,
};
use crate::storage::native::{
    CanonicalRuntimeFrameDraft, NativeRuntimeStore, NativeStorageConfig, build_runtime_frame_commit,
};
use crate::transport::{
    DirectOutboxPublisher, DirectOutboxPublisherConfig, DirectRoute, DirectRouteTable,
    DirectRuntimeIngress, DirectRuntimeIngressConfig, DirectSession, InboundEntityInputs,
    OutboundEnvelope, SessionConfig, encryption_identity,
};
use crate::{
    CanonicalEntityInfraMaterializer, canonical_value_from_tagged_json,
    transport::derive_local_runtime_id,
};

#[path = "test_ws.rs"]
mod test_ws;
use test_ws::CanonicalWsServer;

const ENTITY_SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const ENTITY_KEY_LABEL: &str = "h1-hub";
const SOURCE_SEED: &str = "rrs-durable-processor";
const SOURCE_SIGNER: &str = "1";
static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::from("0x"), |mut value, byte| {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
        value
    })
}

fn processor_replica() -> RuntimeReplica {
    let private_key = derive_signer_key(ENTITY_SEED, ENTITY_KEY_LABEL).expect("entity key");
    let signer_id =
        hex(&derive_signer_address(ENTITY_SEED, ENTITY_KEY_LABEL).expect("entity signer address"));
    let identity =
        SigningIdentity::lazy_from_key(private_key, &signer_id, 1, 1, BoardDelays::default())
            .expect("lazy entity");
    let owner = *identity.entity_id();
    let owner_id = EntityId::parse(&hex(&owner)).expect("owner");
    let peer_id = EntityId::parse(&format!("0x{}", "ff".repeat(32))).expect("peer");
    let account_id = AccountId::from_bytes(*peer_id.as_bytes());
    let account_state = AccountState::new(
        AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            owner_id.clone(),
            peer_id,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("account identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![
            Delta::new(
                TokenId::new(1).expect("token"),
                BigInt::from(1_000_000_000_u64),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(500_000_000_u64),
                BigInt::from(500_000_000_u64),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
            )
            .expect("funded delta"),
        ],
    )
    .expect("account state");
    let accounts = ResidentConsensusEngine::import_existing(
        EngineGeneration::from_bytes([0x22; 8]),
        1,
        private_key,
        signer_id.clone(),
        Arc::new(SwapMarketPolicy::default()),
        vec![AccountSeed {
            account_id,
            replica: AccountReplica::new(owner_id, account_state).expect("account replica"),
            consensus: None,
        }],
    )
    .expect("account engine");
    let accounts_root = accounts.accounts_root();
    let owner_text = hex(&owner);
    let mut entity = EntityStateSlice::empty(owner_text.clone(), 100);
    entity
        .known_accounts
        .insert(format!("0x{}", "ff".repeat(32)));
    let authority = EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer_id.clone()],
            shares: BTreeMap::from([(signer_id.clone(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer_id.clone(),
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
    let entity_signer = EntitySingleSigner::from_key(
        private_key,
        &signer_id,
        &owner_text,
        1,
        1,
        BoardDelays::default(),
    )
    .expect("entity signer");
    let runtime_id = derive_local_runtime_id(SOURCE_SEED, SOURCE_SIGNER).expect("runtime id");
    RuntimeReplica::new(
        RuntimeState {
            height: 0,
            timestamp: 100,
            finalized_j_height: 0,
            accounts_root,
            entity,
        },
        RuntimeDurableEnvelope::fixture_for_runtime(&runtime_id, [0; 32]),
        owner,
        signer_id,
        accounts,
        entity_consensus,
        entity_signer,
        [0x44; 32],
        RuntimeLimits {
            checkpoint_period_frames: 100,
            ..RuntimeLimits::hlt()
        },
    )
    .expect("runtime replica")
}

fn empty_entity_input(replica: &RuntimeReplica) -> RuntimeInput {
    empty_entity_input_at(replica, 1, 200)
}

fn empty_entity_input_at(replica: &RuntimeReplica, height: u64, timestamp: u64) -> RuntimeInput {
    let entity_id = replica.state.entity.entity_id.clone();
    let signer_id = replica.signer_id.clone();
    let entity_input = RuntimeEntityInput::decode(json!({
        "entityId": entity_id,
        "signerId": signer_id,
        "entityTxs": [],
    }))
    .expect("empty exact entity input");
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs: vec![entity_input],
        frame: frame_context(replica, height, timestamp),
    }
}

fn frame_context(replica: &RuntimeReplica, height: u64, timestamp: u64) -> RuntimeFrameContext {
    let context = json!({
        "version": 1,
        "proposerReplicaId": format!("{}:{}", replica.state.entity.entity_id, replica.signer_id),
        "entityId": replica.state.entity.entity_id,
        "proposerSignerId": replica.signer_id,
        "parentFrameHash": format!("0x{}", "00".repeat(32)),
        "height": height,
        "gossipProfiles": [],
        "peerAssertions": [],
        "htlc": {"version": 1, "entries": [], "originated": []},
    });
    RuntimeFrameContext {
        timestamp,
        finalized_j_height: 0,
        hub_rebalance_has_pending_work: false,
        entity_context: DeterministicContext::hlt_default(),
        canonical_entity_context: canonical_value_from_tagged_json(&context)
            .expect("canonical entity context"),
    }
}

fn direct_payment_input(replica: &RuntimeReplica) -> RuntimeInput {
    let owner = replica.state.entity.entity_id.clone();
    let peer = format!("0x{}", "ff".repeat(32));
    let entity_input = RuntimeEntityInput::decode(json!({
        "entityId": owner,
        "signerId": replica.signer_id,
        "entityTxs": [{
            "type":"directPayment",
            "data":{
                "targetEntityId":peer,
                "tokenId":1,
                "amount":{"__xlnType":"BigInt","value":"7"},
                "route":[owner, peer],
                "description":"durable processor payment",
                "deliveryMode":"direct"
            }
        }]
    }))
    .expect("direct payment input");
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs: vec![entity_input],
        frame: frame_context(replica, 1, 200),
    }
}

fn no_external_input(replica: &RuntimeReplica, height: u64, timestamp: u64) -> RuntimeInput {
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs: Vec::new(),
        frame: frame_context(replica, height, timestamp),
    }
}

fn path() -> std::path::PathBuf {
    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "xln-rscore-durable-processor-{}-{serial}",
        std::process::id()
    ))
}

fn canonical_number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture number"))
}

fn live_socket_output(
    target_runtime_id: &str,
    target_entity_id: &str,
    target_signer_id: &str,
) -> Vec<u8> {
    live_socket_output_at(
        target_runtime_id,
        target_entity_id,
        target_signer_id,
        1,
        150,
    )
}

fn live_socket_output_at(
    target_runtime_id: &str,
    target_entity_id: &str,
    target_signer_id: &str,
    height: u64,
    timestamp: u64,
) -> Vec<u8> {
    crate::encode_storage_payload(&CanonicalValue::Object(vec![
        (
            "runtimeId".into(),
            CanonicalValue::String(target_runtime_id.into()),
        ),
        (
            "entityId".into(),
            CanonicalValue::String(target_entity_id.into()),
        ),
        (
            "signerId".into(),
            CanonicalValue::String(target_signer_id.into()),
        ),
        ("entityTxs".into(), CanonicalValue::Array(Vec::new())),
        (
            "sourceRuntimeFrame".into(),
            CanonicalValue::Object(vec![
                ("height".into(), canonical_number(height)),
                ("timestamp".into(), canonical_number(timestamp)),
            ]),
        ),
    ]))
    .expect("canonical transport output")
}

#[test]
fn one_runtime_input_is_applied_fsynced_and_recovered_once() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let input = empty_entity_input(&replica);
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("native store");
    let routes = EntityRouteTable::new([]).expect("empty route table");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("durable processor");
    let report = processor.process(input).expect("durable frame");
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(report.outputs_published, 0);
    let commitments = report.commitments.expect("post-fsync commitments");
    assert_eq!(commitments.height, 1);
    assert_eq!(commitments.runtime_output_count, 0);
    assert_eq!(commitments.entity_event_count, 0);
    assert_eq!(commitments.entity_effect_count, 0);
    assert_ne!(commitments.runtime_frame_hash, [0; 32]);
    assert_ne!(commitments.post_state_hash, [0; 32]);
    assert_ne!(commitments.certified_entity_frame_hash, [0; 32]);
    assert_ne!(commitments.events_parity_digest, [0; 32]);
    assert_ne!(commitments.entity_effects_parity_digest, [0; 32]);
    assert_eq!(
        commitments.accounts_root,
        processor
            .replica()
            .expect("live replica")
            .state
            .accounts_root
    );
    assert_eq!(processor.replica().expect("live replica").state.height, 1);
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("reopen after process crash");
    let recovery = reopened.recover().expect("recover durable WAL");
    assert_eq!(recovery.checkpoint.as_ref().map(|row| row.height), Some(1));
    assert!(recovery.wal_frames.is_empty());
    assert_eq!(recovery.pending_outbox.len(), 1);
    assert!(recovery.pending_outbox[0].outputs.is_empty());
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn authenticated_ingress_batch_moves_once_into_the_durable_runtime_writer() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let local_runtime_id = replica.durable.runtime_id().to_owned();
    let remote_runtime_id =
        derive_local_runtime_id("rrs-ingress-remote", "1").expect("remote runtime id");
    let entity_input = RuntimeEntityInput::decode(json!({
        "runtimeId": local_runtime_id,
        "entityId": replica.state.entity.entity_id,
        "signerId": replica.signer_id,
        "entityTxs": [],
        "from": remote_runtime_id,
        "sourceRuntimeFrame": {"height": 7, "timestamp": 150},
    }))
    .expect("authenticated transport projection");
    let inbound = InboundEntityInputs {
        peer_runtime_id: remote_runtime_id,
        message_id: "rrs_7_1".into(),
        source_runtime_height: 7,
        source_runtime_timestamp: 150,
        ingress_timestamp: Some(151),
        entity_tx_count: 0,
        entity_inputs: vec![entity_input],
    };
    let input = RuntimeLiveInput {
        runtime_txs: Vec::new(),
        entity_inputs: inbound.entity_inputs,
        timestamp: 200,
        finalized_j_height: 0,
        hub_rebalance_has_pending_work: false,
    };
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("native store");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        EntityRouteTable::new([]).expect("empty routes"),
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("durable processor");
    let mut materializer = CanonicalEntityInfraMaterializer::new(json!({
        "minimumTradeSize": {"__xlnType":"BigInt", "value":"0"},
        "swapTakerFeeBps": 0,
        "jurisdictionId": null,
        "pairPolicies": []
    }));
    let report = processor
        .process_live(input, &mut materializer)
        .expect("selected context then fsynced Runtime frame");
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(report.outputs_published, 0);
    let recovered = processor
        .read_durable_frame(1)
        .expect("frame exists only after fsync");
    assert_eq!(recovered.height, 1);
    drop(processor);
    std::fs::remove_dir_all(path).expect("remove fixture");
}

#[test]
fn two_authenticated_socket_messages_coalesce_into_one_durable_runtime_frame() {
    let target_path = path();
    let source_path = target_path.with_extension("source");
    let _ = std::fs::remove_dir_all(&target_path);
    let _ = std::fs::remove_dir_all(&source_path);

    let replica = processor_replica();
    let target_runtime_id = replica.durable.runtime_id().to_owned();
    let target_entity_id = replica.state.entity.entity_id.clone();
    let target_signer_id = replica.signer_id.clone();
    let target_store = NativeRuntimeStore::open(&target_path, NativeStorageConfig::default())
        .expect("target store");
    let target_processor = DurableRuntimeProcessor::new(
        replica,
        target_store,
        EntityRouteTable::new([]).expect("empty target routes"),
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("target signer"),
    )
    .expect("target processor");
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .expect("target ingress");
    let mut service = ResidentRuntimeService::new(
        target_processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new(json!({
            "minimumTradeSize": {"__xlnType":"BigInt", "value":"0"},
            "swapTakerFeeBps": 0,
            "jurisdictionId": null,
            "pairPolicies": []
        }))),
    )
    .expect("single live service");
    assert_eq!(service.runtime_id(), target_runtime_id);

    let source_seed = "rrs-live-source";
    let source_signer = "source";
    let mut source_store = NativeRuntimeStore::open(&source_path, NativeStorageConfig::default())
        .expect("source store");
    let first_encoded = build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height: 1,
            timestamp: 150,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: Vec::new(),
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: Vec::new(),
            touched_entities: Vec::new(),
            touched_accounts: Vec::new(),
            touched_book_entities: Vec::new(),
        },
        crate::storage::native::EntityContextPayloadRows::empty(),
        vec![live_socket_output(
            &target_runtime_id,
            &target_entity_id,
            &target_signer_id,
        )],
        None,
    )
    .expect("source frame");
    let first_hash = first_encoded.frame_hash;
    let first = source_store
        .append_frame(first_encoded.commit)
        .expect("source first fsync");
    let second = source_store
        .append_frame(
            build_runtime_frame_commit(
                CanonicalRuntimeFrameDraft {
                    height: 2,
                    timestamp: 151,
                    prev_frame_hash: first_hash,
                    replica_meta_digest: [0x11; 32],
                    runtime_component_digests: Vec::new(),
                    materialized_state: false,
                    canonical_state: None,
                    runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
                    runtime_machine_root: None,
                    account_authority_checkpoints: Vec::new(),
                    touched_entities: Vec::new(),
                    touched_accounts: Vec::new(),
                    touched_book_entities: Vec::new(),
                },
                crate::storage::native::EntityContextPayloadRows::empty(),
                vec![live_socket_output_at(
                    &target_runtime_id,
                    &target_entity_id,
                    &target_signer_id,
                    2,
                    151,
                )],
                None,
            )
            .expect("second source frame")
            .commit,
        )
        .expect("source second fsync");
    let routes = DirectRouteTable::new([DirectRoute {
        target_runtime_id: target_runtime_id.clone(),
        url: format!("ws://{}/ws", service.local_address()),
    }])
    .expect("source route");
    let mut publisher = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        source_seed,
        source_signer,
        routes,
    ))
    .expect("source publisher");
    publisher
        .publish_durable(&mut source_store, &first)
        .expect("first authenticated socket publish");
    publisher
        .publish_durable(&mut source_store, &second)
        .expect("second authenticated socket publish");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while service.ingress_metrics().accepted_batches < 2 && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(service.ingress_metrics().accepted_batches, 2);

    let report = service
        .process_next(std::time::Duration::from_secs(3))
        .expect("socket to durable reducer")
        .expect("one durable Runtime frame");
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(
        service
            .processor()
            .replica()
            .expect("live replica")
            .state
            .height,
        1
    );
    assert!(
        service
            .process_next(std::time::Duration::from_millis(20))
            .expect("socket queue remains healthy")
            .is_none(),
        "the second socket message must not create a second Runtime frame",
    );
    publisher.close();
    service.shutdown().expect("target shutdown");
    drop(service);
    drop(source_store);

    let mut reopened = NativeRuntimeStore::open(&target_path, NativeStorageConfig::default())
        .expect("restart target store");
    let recovery = reopened.recover().expect("recover target frame");
    assert_eq!(recovery.checkpoint.as_ref().map(|row| row.height), Some(1));
    drop(reopened);
    std::fs::remove_dir_all(target_path).expect("remove target fixture");
    std::fs::remove_dir_all(source_path).expect("remove source fixture");
}

#[test]
fn live_service_resends_the_durable_outbox_before_accepting_input() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let server = CanonicalWsServer::start("startup-resend");
    let target_entity_id = format!("0x{}", "ab".repeat(32));
    let target_signer_id = format!("0x{}", "cd".repeat(20));
    let encoded = build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height: 1,
            timestamp: 150,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: Vec::new(),
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: Vec::new(),
            touched_entities: Vec::new(),
            touched_accounts: Vec::new(),
            touched_book_entities: Vec::new(),
        },
        crate::storage::native::EntityContextPayloadRows::empty(),
        vec![live_socket_output(
            &server.runtime_id,
            &target_entity_id,
            &target_signer_id,
        )],
        None,
    )
    .expect("startup resend frame");
    let frame_hash = encoded.frame_hash;
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("startup resend store");
    store
        .append_frame(encoded.commit)
        .expect("startup resend fsync");
    let mut replica = processor_replica();
    replica.state.height = 1;
    replica
        .durable
        .advance_frame_hash([0; 32], frame_hash)
        .expect("startup resend lineage");
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id,
        target_runtime_id: server.runtime_id.clone(),
        target_signer_id,
        websocket_url: Some(format!("ws://127.0.0.1:{}/ws", server.port)),
    }])
    .expect("startup resend route");
    let processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("startup signer"),
    )
    .expect("startup processor");
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .expect("startup ingress");
    let mut service = ResidentRuntimeService::new(
        processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new(json!({
            "minimumTradeSize": {"__xlnType":"BigInt", "value":"0"},
            "swapTakerFeeBps": 0,
            "jurisdictionId": null,
            "pairPolicies": []
        }))),
    )
    .expect("startup resend before ready");
    server.wait_for_rows(1);
    assert_eq!(server.rows().expect("startup rows")[0]["height"], 1);
    service.shutdown().expect("startup service shutdown");
    drop(service);
    std::fs::remove_dir_all(path).expect("remove startup resend fixture");
}

#[test]
fn restart_stages_inbound_only_outbox_without_blocking_new_input() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let user_seed = "rrs-inbound-only-user";
    let user_signer = "user";
    let user_runtime_id = derive_local_runtime_id(user_seed, user_signer).expect("user runtime id");
    let target_entity_id = format!("0x{}", "ab".repeat(32));
    let target_signer_id = format!("0x{}", "cd".repeat(20));
    let encoded = build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height: 1,
            timestamp: 150,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: Vec::new(),
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: Vec::new(),
            touched_entities: Vec::new(),
            touched_accounts: Vec::new(),
            touched_book_entities: Vec::new(),
        },
        crate::storage::native::EntityContextPayloadRows::empty(),
        vec![live_socket_output(
            &user_runtime_id,
            &target_entity_id,
            &target_signer_id,
        )],
        None,
    )
    .expect("inbound-only pending frame");
    let frame_hash = encoded.frame_hash;
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("inbound-only store");
    store
        .append_frame(encoded.commit)
        .expect("inbound-only fsync");
    let mut replica = processor_replica();
    replica.state.height = 1;
    replica
        .durable
        .advance_frame_hash([0; 32], frame_hash)
        .expect("inbound-only lineage");
    let hub_entity_id = replica.state.entity.entity_id.clone();
    let hub_signer_id = replica.signer_id.clone();
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id,
        target_runtime_id: user_runtime_id.clone(),
        target_signer_id,
        websocket_url: None,
    }])
    .expect("inbound-only route");
    let processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("inbound-only signer"),
    )
    .expect("inbound-only processor");
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .expect("inbound-only ingress");
    let mut service = ResidentRuntimeService::new(
        processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new(json!({
            "minimumTradeSize": {"__xlnType":"BigInt", "value":"0"},
            "swapTakerFeeBps": 0,
            "jurisdictionId": null,
            "pairPolicies": []
        }))),
    )
    .expect("restart without dialing the user");
    assert!(!service.processor().has_pending_publication());
    assert!(
        service
            .process_next(std::time::Duration::from_millis(50))
            .expect("idle while peer is disconnected")
            .is_none()
    );
    assert!(!service.processor().has_pending_publication());
    let hub_runtime_id = service.runtime_id().to_owned();
    let mut user = DirectSession::connect(SessionConfig {
        url: &format!("ws://{}/ws", service.local_address()),
        target_runtime_id: &hub_runtime_id,
        source_runtime_id: &user_runtime_id,
        source_seed: user_seed,
        source_signer_id: user_signer,
        identity: &encryption_identity(user_seed),
        io_timeout: std::time::Duration::from_secs(3),
        max_message_bytes: 32 * 1024 * 1024,
    })
    .expect("user reconnects");
    user.send_envelope(&OutboundEnvelope {
        target_runtime_id: hub_runtime_id.clone(),
        source_height: 1,
        source_timestamp: 123,
        entity_id: Some(hub_entity_id.clone()),
        transaction_count: 0,
        value: json!({
            "sourceRuntimeId": user_runtime_id,
            "sourceRuntimeHeight": 1,
            "sourceRuntimeTimestamp": 123,
            "entityInputs": [{
                "runtimeId": hub_runtime_id,
                "entityId": hub_entity_id,
                "signerId": hub_signer_id,
                "entityTxs": [],
            }],
        }),
        row_count: 1,
        durable_bytes: 1,
    })
    .expect("user inbound batch");
    let report = service.process_next(std::time::Duration::from_secs(3));
    assert!(!service.processor().has_pending_publication());
    report.expect("held batch processed or idle after publish");
    let reply = user.recv_envelope().expect("hub reply after reconnect");
    assert_eq!(reply["sourceRuntimeHeight"], 1);
    user.close();
    service.shutdown().expect("inbound-only shutdown");
    drop(service);
    std::fs::remove_dir_all(path).expect("remove inbound-only fixture");
}

#[test]
fn canonical_hash_cadence_does_not_materialize_path_nodes() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let mut replica = processor_replica();
    replica.limits.canonical_hash_period_frames = 1;
    let input = empty_entity_input(&replica);
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("native store");
    let routes = EntityRouteTable::new([]).expect("empty route table");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    processor
        .process(input)
        .expect("materialized genesis frame");
    let second_input = empty_entity_input_at(processor.replica().expect("live replica"), 2, 300);
    processor
        .process(second_input)
        .expect("durable canonical-only frame");
    let durable = processor.read_durable_frame(2).expect("durable frame");
    let frame = crate::decode_storage_payload(&durable.frame_bytes).expect("decode frame");
    assert_eq!(frame.get("materializedState"), Some(&Value::Bool(false)));
    assert!(frame.get("canonicalStateHash").is_some());
    assert!(frame.get("canonicalEntityHashes").is_some());
    assert!(frame.get("runtimeMachineRoot").is_some());
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("reopen");
    let recovery = reopened.recover().expect("recover");
    assert_eq!(recovery.checkpoint.as_ref().map(|row| row.height), Some(1));
    assert_eq!(recovery.wal_frames.len(), 1);
    assert_eq!(recovery.wal_frames[0].height, 2);
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn cadence_100_is_measured_from_the_first_materialized_runtime_frame() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("native store");
    let routes = EntityRouteTable::new([]).expect("empty route table");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    for height in 1..=101 {
        let input = empty_entity_input_at(
            processor.replica().expect("live replica"),
            height,
            100_u64.checked_add(height).expect("timestamp"),
        );
        let report = processor.process(input).expect("durable frame");
        assert_eq!(report.durable_height, Some(height));
    }
    assert_eq!(processor.replica().expect("live replica").state.height, 101);
    let expected_accounts_root = processor
        .replica()
        .expect("live replica")
        .state
        .accounts_root;
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
        },
    )
    .expect("reopen");
    let recovery = reopened.recover().expect("recover");
    let checkpoint = recovery.checkpoint.expect("checkpoint at cadence");
    assert_eq!(checkpoint.height, 101);
    assert!(!checkpoint.runtime_machine_leaves.is_empty());
    assert!(
        checkpoint
            .path_nodes
            .keys()
            .any(|key| key.first() == Some(&0x17))
    );
    assert!(
        checkpoint
            .path_nodes
            .keys()
            .any(|key| key.first() == Some(&0x18))
    );
    assert!(
        checkpoint
            .path_nodes
            .keys()
            .any(|key| key.first() == Some(&0x19))
    );
    assert!(
        checkpoint
            .path_nodes
            .keys()
            .any(|key| key.first() == Some(&0x21))
    );
    assert!(
        checkpoint
            .path_nodes
            .keys()
            .any(|key| key.first() == Some(&0x26))
    );
    let account_meta = checkpoint
        .path_nodes
        .iter()
        .find(|(key, _)| key.first() == Some(&0x17))
        .map(|(_, value)| crate::decode_storage_payload(value).expect("account meta decode"))
        .expect("account meta");
    let account_root = account_meta
        .get("accountsRoot")
        .and_then(Value::as_str)
        .expect("account root");
    assert_eq!(account_root, hex(&expected_accounts_root));
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn an_uncertain_fsync_poison_stops_the_processor_before_publication() {
    let path = path();
    let displaced = path.with_extension("displaced");
    let _ = std::fs::remove_dir_all(&path);
    let _ = std::fs::remove_dir_all(&displaced);
    let replica = processor_replica();
    let input = empty_entity_input(&replica);
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let routes = EntityRouteTable::new([]).expect("empty route table");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");

    // Keep LevelDB's open file handles alive but remove the directory at the
    // exact boundary that must be fsynced after its synchronous write. The
    // write outcome is now uncertain, so neither the replica nor any output
    // may be exposed and the process must be reopened from durable storage.
    std::fs::rename(&path, &displaced).expect("displace live database directory");
    assert!(matches!(
        processor.process(input),
        Err(DurableRuntimeProcessorError::Storage(_))
    ));
    assert!(matches!(
        processor.replica(),
        Err(DurableRuntimeProcessorError::Poisoned)
    ));
    drop(processor);
    std::fs::remove_dir_all(displaced).expect("remove displaced store");
}

#[test]
fn failed_socket_after_fsync_does_not_block_the_next_runtime_input() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let input = direct_payment_input(&replica);
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id: format!("0x{}", "ff".repeat(32)),
        target_runtime_id: format!("0x{}", "55".repeat(20)),
        target_signer_id: format!("0x{}", "66".repeat(20)),
        websocket_url: Some("ws://127.0.0.1:1/ws".into()),
    }])
    .expect("remote route");
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let first = processor
        .process(input)
        .expect("durable frame stages despite unavailable peer");
    assert_eq!(first.outputs_published, 0);
    assert_eq!(
        processor.replica().expect("durable replica").state.height,
        1
    );
    let next = no_external_input(processor.replica().expect("replica"), 2, 300);
    processor
        .process(next)
        .expect("unavailable peer does not block the next Runtime input");
    assert_eq!(
        processor.replica().expect("advanced replica").state.height,
        2
    );
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("reopen durable frame");
    let recovered = reopened.recover().expect("recover");
    assert_eq!(recovered.checkpoint.as_ref().map(|row| row.height), Some(1));
    assert_eq!(recovered.wal_frames.len(), 1);
    assert_eq!(recovered.wal_frames[0].height, 2);
    assert_eq!(recovered.pending_outbox.len(), 2);
    assert_eq!(recovered.pending_outbox[0].outputs.len(), 1);
    assert!(recovered.pending_outbox[1].outputs.is_empty());
    let decoded = recovered.pending_outbox[0]
        .outputs
        .iter()
        .map(|row| crate::decode_storage_payload(row).expect("output row"))
        .collect::<Vec<_>>();
    assert_eq!(
        decoded
            .iter()
            .filter(|row| row.get("runtimeId").is_none())
            .count(),
        0
    );
    assert_eq!(
        decoded
            .iter()
            .filter(|row| row.get("runtimeId").is_some())
            .count(),
        1
    );
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn replay_validate_only_uses_the_same_durable_route_and_outbox_path() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let input = direct_payment_input(&replica);
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id: format!("0x{}", "ff".repeat(32)),
        target_runtime_id: format!("0x{}", "55".repeat(20)),
        target_signer_id: format!("0x{}", "66".repeat(20)),
        // The explicit replay target validates this as a production route but
        // never opens it. `new()` with the same route is covered above and
        // fails after fsync when the real socket is unavailable.
        websocket_url: Some("ws://127.0.0.1:1/ws".into()),
    }])
    .expect("remote route");
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let mut processor = DurableRuntimeProcessor::new_replay_validate_only(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("replay processor");
    let report = processor.process(input).expect("durable replay frame");
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(report.outputs_published, 1);
    assert_eq!(report.envelopes_published, 1);
    assert_eq!(
        report
            .commitments
            .expect("post-fsync commitments")
            .runtime_output_count,
        1
    );
    drop(processor);
    std::fs::remove_dir_all(path).expect("remove replay fixture");
}

#[test]
fn fsync_precedes_real_websocket_and_local_continuation_uses_the_next_context() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let server = CanonicalWsServer::start("success");
    let replica = processor_replica();
    let input = direct_payment_input(&replica);
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id: format!("0x{}", "ff".repeat(32)),
        target_runtime_id: server.runtime_id.clone(),
        target_signer_id: format!("0x{}", "66".repeat(20)),
        websocket_url: Some(format!("ws://127.0.0.1:{}/ws", server.port)),
    }])
    .expect("remote route");
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let first = processor.process(input).expect("fsync then websocket");
    assert_eq!(first.durable_height, Some(1));
    assert_eq!(first.outputs_published, 1);
    assert_eq!(
        first
            .commitments
            .as_ref()
            .expect("post-fsync commitments")
            .runtime_output_count,
        1
    );
    server.wait_for_rows(1);
    assert_eq!(server.rows().expect("received rows")[0]["height"], 1);

    let next_input = no_external_input(processor.replica().expect("replica"), 2, 300);
    let second = processor
        .process(next_input)
        .expect("local continuation under fresh context");
    assert_eq!(second.durable_height, Some(2));
    assert_eq!(second.outputs_published, 0);
    assert_eq!(processor.replica().expect("replica").state.height, 2);
    assert_eq!(processor.replica().expect("replica").state.timestamp, 300);
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("reopen after two frames");
    let recovered = reopened.recover().expect("recover two frames");
    assert_eq!(recovered.checkpoint.as_ref().map(|row| row.height), Some(1));
    assert_eq!(
        recovered
            .wal_frames
            .iter()
            .map(|frame| frame.height)
            .collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(recovered.pending_outbox.len(), 2);
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}
