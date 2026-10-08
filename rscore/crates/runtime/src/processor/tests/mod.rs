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
    EntityFrameAuthority, EntityLeaderState, EntitySingleSigner, EntityStateSlice,
    ResidentEntityConsensusReplica,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::{
    DurableRuntimeProcessor, DurableRuntimeProcessorError, EntityRoute, EntityRouteTable,
    ResidentRuntimeService, RuntimeDurableEnvelope, RuntimeSignerLabel,
};
use crate::machine::{
    RuntimeEntityFrameContext, RuntimeEntityInput, RuntimeEntityKey, RuntimeEntityState,
    RuntimeFrameContext, RuntimeInput, RuntimeLimits, RuntimeLiveInput, RuntimeReplica,
    RuntimeState, RuntimeTx,
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

mod local_profile_publication;
mod origin_empty_route;
mod profile_wire;
mod signed_profile;
#[path = "test_ws.rs"]
mod test_ws;
use test_ws::CanonicalWsServer;

const ENTITY_SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const ENTITY_KEY_LABEL: &str = "h1-hub";
const SOURCE_SEED: &str = "rrs-durable-processor";
const SOURCE_SIGNER: &str = "1";
static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

/// Drain the pipelined committer and fold its outcome into the report of the
/// call that produced the frame, so assertions observe the same post-fsync
/// view the serial processor used to return.
fn merge_synced(
    report: &mut super::RuntimeProcessReport,
    synced: Option<super::RuntimeProcessReport>,
) {
    let Some(synced) = synced else {
        return;
    };
    report.durable_height = synced.durable_height.or(report.durable_height);
    report.outputs_published += synced.outputs_published;
    report.envelopes_published += synced.envelopes_published;
    report.durable_bytes_published += synced.durable_bytes_published;
}

fn attached_test_ingress(
    processor: &mut DurableRuntimeProcessor,
    seed: &str,
    signer: &str,
) -> DirectRuntimeIngress {
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        seed,
        signer,
    ))
    .expect("real attached socket reactor");
    processor.attach_inbound_sessions(ingress.sessions());
    ingress
        .set_delivery_ready(true)
        .expect("fixture ingress ready");
    processor
        .set_delivery_ready(true)
        .expect("fixture publisher ready");
    ingress
}

fn wait_for_processor_publication(
    processor: &mut DurableRuntimeProcessor,
    report: &mut super::RuntimeProcessReport,
    rows: usize,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while report.outputs_published < rows && std::time::Instant::now() < deadline {
        merge_synced(
            report,
            processor
                .retry_publication()
                .expect("async socket completion"),
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(
        report.outputs_published, rows,
        "fsynced output reaches the real socket"
    );
}

fn payment_routes(server: &CanonicalWsServer) -> EntityRouteTable {
    EntityRouteTable::new([EntityRoute {
        target_entity_id: format!("0x{}", "ff".repeat(32)),
        target_runtime_id: server.runtime_id.clone(),
        target_signer_id: format!("0x{}", "66".repeat(20)),
        websocket_url: Some(format!("ws://127.0.0.1:{}/ws", server.port)),
    }])
    .expect("real payment peer route")
}

fn assert_payment_proposal(outputs: &[Vec<u8>]) {
    assert_eq!(outputs.len(), 1, "one durable financial proposal");
    let output = crate::decode_storage_payload(&outputs[0]).expect("durable payment decode");
    assert_eq!(output["entityId"], format!("0x{}", "ff".repeat(32)));
    let transactions = output["entityTxs"][0]["data"]["proposal"]["frame"]["accountTxs"]
        .as_array()
        .expect("bilateral proposal transactions");
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["type"], "direct_payment");
    assert_eq!(transactions[0]["data"]["tokenId"], 1);
    assert_eq!(
        transactions[0]["data"]["amount"],
        json!({"__xlnType":"BigInt","value":"7"})
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::from("0x"), |mut value, byte| {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
        value
    })
}

fn processor_replica() -> RuntimeReplica {
    processor_replica_with_peer(
        ENTITY_SEED,
        SOURCE_SEED,
        EntityId::parse(&format!("0x{}", "ff".repeat(32))).expect("peer"),
    )
}

fn processor_replica_with_peer(
    entity_seed: &str,
    runtime_seed: &str,
    peer_id: EntityId,
) -> RuntimeReplica {
    processor_replica_with_pinned_peer(entity_seed, runtime_seed, peer_id, false)
}

fn processor_replica_with_pinned_peer(
    entity_seed: &str,
    runtime_seed: &str,
    peer_id: EntityId,
    pinned: bool,
) -> RuntimeReplica {
    let private_key = derive_signer_key(entity_seed, ENTITY_KEY_LABEL).expect("entity key");
    let signer_id =
        hex(&derive_signer_address(entity_seed, ENTITY_KEY_LABEL).expect("entity signer address"));
    let identity =
        SigningIdentity::lazy_from_key(private_key, &signer_id, 1, 1, BoardDelays::default())
            .expect("lazy entity");
    let owner = *identity.entity_id();
    let owner_id = EntityId::parse(&hex(&owner)).expect("owner");
    let peer_text = peer_id.as_hex();
    let account_id = AccountId::from_bytes(*peer_id.as_bytes());
    let (left, right) = if owner_id.as_bytes() < peer_id.as_bytes() {
        (owner_id.clone(), peer_id)
    } else {
        (peer_id, owner_id.clone())
    };
    let account_state = AccountState::new(
        AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            left,
            right,
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
            replica: {
                let mut account =
                    AccountReplica::new(owner_id, account_state).expect("account replica");
                if pinned {
                    account.set_envelope(
                        xln_rscore_engine::AccountEnvelope::new(
                            vec![("publicPinned".into(), CanonicalValue::Bool(true))],
                            vec![],
                        )
                        .expect("pinned account"),
                    );
                }
                account
            },
            consensus: None,
        }],
    )
    .expect("account engine");
    let accounts_root = accounts.accounts_root();
    let owner_text = hex(&owner);
    let mut entity = EntityStateSlice::empty(owner_text.clone(), 100);
    entity.known_accounts.insert(peer_text);
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
    let runtime_id = derive_local_runtime_id(runtime_seed, SOURCE_SIGNER).expect("runtime id");
    RuntimeReplica::new(
        RuntimeState {
            height: 0,
            timestamp: 100,
            finalized_j_height: 0,
            e_replicas: BTreeMap::from([(
                RuntimeEntityKey::new(owner, &signer_id).expect("replica key"),
                RuntimeEntityState {
                    accounts_root,
                    entity,
                },
            )]),
        },
        // These socket/WAL tests own no J domain; their Entity jurisdiction is None.
        RuntimeDurableEnvelope::decode(
            &json!({
                "runtimeId":runtime_id,"runtimeConfig":{"minFrameDelayMs":5},
                "infrastructure":{},"jReplicas":[]
            }),
            [0; 32],
        )
        .expect("canonical no-J socket runtime"),
        owner,
        signer_id,
        accounts,
        entity_consensus,
        entity_signer,
        [0x44; 32],
        runtime_seed.to_string(),
        RuntimeLimits {
            checkpoint_period_frames: 100,
            ..RuntimeLimits::hlt()
        },
    )
    .expect("runtime replica")
}

fn entity_key(replica: &RuntimeReplica) -> RuntimeEntityKey {
    assert_eq!(
        replica.state.e_replicas.len(),
        1,
        "processor fixture Entity count"
    );
    replica
        .state
        .e_replicas
        .keys()
        .next()
        .expect("processor fixture Entity key")
        .clone()
}

fn entity_state(replica: &RuntimeReplica) -> &RuntimeEntityState {
    replica
        .state
        .e_replicas
        .get(&entity_key(replica))
        .expect("processor fixture Entity state")
}

fn empty_entity_input_at(replica: &RuntimeReplica, timestamp: u64) -> RuntimeInput {
    let key = entity_key(replica);
    let entity_id = entity_state(replica).entity.entity_id.clone();
    let signer_id = key.signer_id.clone();
    let entity_input = RuntimeEntityInput::decode(json!({
        "entityId": entity_id,
        "signerId": signer_id,
        "entityTxs": [],
    }))
    .expect("empty exact entity input");
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs: vec![entity_input],
        frame: idle_frame_context(timestamp),
    }
}

fn frame_context(replica: &RuntimeReplica, height: u64, timestamp: u64) -> RuntimeFrameContext {
    let key = entity_key(replica);
    let entity_id = entity_state(replica).entity.entity_id.clone();
    let context = json!({
        "version": 1,
        "proposerReplicaId": format!("{}:{}", entity_id, key.signer_id),
        "entityId": entity_id,
        "proposerSignerId": key.signer_id,
        "parentFrameHash": format!("0x{}", "00".repeat(32)),
        "height": height,
        "gossipProfiles": [],
        "peerAssertions": [],
        "htlc": {"version": 1, "entries": [], "originated": []},
    });
    RuntimeFrameContext {
        timestamp,
        finalized_j_height: 0,
        entity_contexts: BTreeMap::from([(
            key,
            std::collections::VecDeque::from([RuntimeEntityFrameContext {
                execution: DeterministicContext::hlt_default(),
                canonical: canonical_value_from_tagged_json(&context)
                    .expect("canonical entity context"),
            }]),
        )]),
    }
}

fn direct_payment_input(replica: &RuntimeReplica) -> RuntimeInput {
    let key = entity_key(replica);
    let owner = entity_state(replica).entity.entity_id.clone();
    let peer = entity_state(replica)
        .entity
        .known_accounts
        .iter()
        .next()
        .expect("payment counterparty")
        .clone();
    let entity_input = RuntimeEntityInput::decode(json!({
        "entityId": owner,
        "signerId": key.signer_id,
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

fn idle_frame_context(timestamp: u64) -> RuntimeFrameContext {
    // Idle Runtime inputs are accepted and stored without fabricating an
    // Entity proposal context or consuming another certified Entity height.
    RuntimeFrameContext {
        timestamp,
        finalized_j_height: 0,
        entity_contexts: BTreeMap::new(),
    }
}

fn no_external_input(timestamp: u64) -> RuntimeInput {
    RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs: Vec::new(),
        frame: idle_frame_context(timestamp),
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

fn signing_entity_id(seed: &str) -> EntityId {
    let key = derive_signer_key(seed, ENTITY_KEY_LABEL).expect("real Entity key");
    let signer = hex(&derive_signer_address(seed, ENTITY_KEY_LABEL).expect("real Entity signer"));
    let identity = SigningIdentity::lazy_from_key(key, &signer, 1, 1, BoardDelays::default())
        .expect("real lazy Entity identity");
    EntityId::parse(&hex(identity.entity_id())).expect("Entity id")
}

fn payment_service(
    replica: RuntimeReplica,
    ingress: DirectRuntimeIngress,
    directory: &std::path::Path,
    seed: &str,
    route: EntityRoute,
) -> ResidentRuntimeService {
    let store = NativeRuntimeStore::open(directory, NativeStorageConfig::default())
        .expect("real payment WAL");
    let processor = DurableRuntimeProcessor::new(
        replica,
        store,
        EntityRouteTable::new([route]).expect("exact peer route"),
        seed,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("Runtime signer"),
    )
    .expect("real durable payment processor");
    ResidentRuntimeService::new(
        processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new()),
    )
    .expect("real no-J Runtime service")
}

#[test]
fn two_native_runtimes_commit_direct_payment_and_ack_on_one_dialed_socket() {
    let directory = path();
    let peer_seed = hex(&[0x7b; 32]);
    let a_seed = "rrs-payment-ack-a";
    let b_seed = "rrs-payment-ack-b";
    let a_entity = signing_entity_id(ENTITY_SEED);
    let b_entity = signing_entity_id(&peer_seed);
    let a_replica = processor_replica_with_peer(ENTITY_SEED, a_seed, b_entity.clone());
    let b_replica = processor_replica_with_peer(&peer_seed, b_seed, a_entity.clone());
    let a_key = entity_key(&a_replica);
    let b_key = entity_key(&b_replica);
    let payment = direct_payment_input(&a_replica).entity_inputs;
    let bind = |seed| {
        let mut config = DirectRuntimeIngressConfig::production(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            seed,
            SOURCE_SIGNER,
        );
        config.queue_capacity = 1;
        DirectRuntimeIngress::bind(config).expect("one-slot real ingress")
    };
    let a_ingress = bind(a_seed);
    let b_ingress = bind(b_seed);
    let a_runtime = a_ingress.runtime_id().to_owned();
    let b_runtime = b_ingress.runtime_id().to_owned();
    let b_url = format!("ws://{}/ws", b_ingress.local_address());
    let mut a = payment_service(
        a_replica,
        a_ingress,
        &directory.join("a"),
        a_seed,
        EntityRoute {
            target_entity_id: b_entity.as_hex(),
            target_runtime_id: b_runtime.clone(),
            target_signer_id: b_key.signer_id.clone(),
            websocket_url: Some(b_url),
        },
    );
    let mut b = payment_service(
        b_replica,
        b_ingress,
        &directory.join("b"),
        b_seed,
        EntityRoute {
            target_entity_id: a_entity.as_hex(),
            target_runtime_id: a_runtime.clone(),
            target_signer_id: a_key.signer_id.clone(),
            websocket_url: None,
        },
    );
    let a_account = AccountId::from_bytes(*b_entity.as_bytes());
    let b_account = AccountId::from_bytes(*a_entity.as_bytes());
    let token = TokenId::new(1).expect("payment token");
    let status = |service: &mut ResidentRuntimeService, owner: &RuntimeEntityKey, peer| {
        service
            .account_status(owner, peer, vec![token])
            .expect("real Account point read")
            .expect("bilateral Account exists")
    };
    assert!(a.delivery_ready() && b.delivery_ready());
    assert_eq!(status(&mut a, &a_key, a_account).current_height, 0);
    assert_eq!(status(&mut b, &b_key, b_account).current_height, 0);
    let proposed = a
        .process_local_entity_inputs(payment)
        .expect("normal payment admission")
        .expect("payment produces a Runtime frame");
    let proposal_height = proposed.commitments.expect("proposal commitment").height;
    a.sync_committed()
        .expect("proposal WAL fsync before delivery");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while status(&mut b, &b_key, b_account).current_height == 0
        && std::time::Instant::now() < deadline
    {
        a.process_next(std::time::Duration::from_millis(2))
            .expect("sender production retry");
        b.process_next(std::time::Duration::from_millis(2))
            .expect("receiver production proposal admission");
        b.sync_committed()
            .expect("real signed ACK is fsynced before send");
    }
    assert_eq!(
        status(&mut b, &b_key, b_account).current_height,
        1,
        "receiver commits the real proposal"
    );
    assert_eq!(b.ingress_metrics().accepted_connections, 1);
    assert_eq!(b.ingress_metrics().authenticated_sessions, 1);
    // A must consume the signed reply through process_next. Reading the
    // DirectSession test helper would hide the missing production ingress.
    while status(&mut a, &a_key, a_account)
        .pending_frame_height
        .is_some()
        && std::time::Instant::now() < deadline
    {
        b.process_next(std::time::Duration::from_millis(2))
            .expect("receiver ACK publication completion");
        a.process_next(std::time::Duration::from_millis(2))
            .expect("sender production ACK admission");
        a.sync_committed().expect("ACK Runtime WAL fsync");
    }
    let a_final = status(&mut a, &a_key, a_account);
    let b_final = status(&mut b, &b_key, b_account);
    assert_eq!(
        a_final.pending_frame_height, None,
        "dialed socket ACK must drain sender Account pending frame"
    );
    assert_eq!((a_final.current_height, b_final.current_height), (1, 1));
    assert_eq!((a_final.mempool_len, b_final.mempool_len), (0, 0));
    assert_eq!(b_final.pending_frame_height, None);
    assert_eq!(
        a_final.tokens, b_final.tokens,
        "both peers commit identical economic Delta"
    );
    let expected_delta = BigInt::from(if a_entity.as_bytes() < b_entity.as_bytes() {
        -7
    } else {
        7
    });
    assert_eq!(
        a_final.tokens[&token]
            .as_ref()
            .expect("committed payment Delta")
            .offdelta(),
        &expected_delta
    );
    assert_eq!(
        a.ingress_metrics().accepted_connections,
        0,
        "B has no outbound URL and cannot open a second dial"
    );
    assert_eq!(b.ingress_metrics().accepted_connections, 1);
    assert!(a.ingress_metrics().pending_batches_high_water <= 1);
    assert!(b.ingress_metrics().pending_batches_high_water <= 1);
    let ack_height = a.processor().replica().expect("ACK state").state.height;
    assert!(ack_height > proposal_height);
    a.shutdown().expect("sender ingress shutdown");
    b.shutdown().expect("receiver ingress shutdown");
    drop(a);
    drop(b);

    let mut wal = NativeRuntimeStore::open(directory.join("a"), NativeStorageConfig::default())
        .expect("reopen sender WAL independently");
    let frame = wal
        .read_durable_frame(ack_height)
        .expect("durable ACK frame");
    let decoded = crate::decode_storage_payload(&frame.frame_bytes).expect("ACK WAL decode");
    let inputs = decoded["runtimeInput"]["entityInputs"]
        .as_array()
        .expect("accepted ACK Runtime input");
    assert!(
        inputs
            .iter()
            .any(|input| input["entityTxs"].as_array().is_some_and(|txs| txs
                .iter()
                .any(|tx| { tx["type"] == "accountInput" && tx["data"]["ack"].is_object() }))),
        "signed ACK is durable input, not a socket-only receipt"
    );
    drop(wal);
    std::fs::remove_dir_all(directory).expect("remove two-Runtime WAL fixture");
}

#[test]
fn saturated_real_ingress_cannot_block_a_new_financial_wal_fsync_before_drain() {
    let directory = path();
    let replica = processor_replica();
    let owner = entity_state(&replica).entity.entity_id.clone();
    let signer = entity_key(&replica).signer_id;
    let payment = direct_payment_input(&replica).entity_inputs;
    let server = CanonicalWsServer::start_saturating("dialed-saturation", &owner, &signer);
    let peer_runtime = server.runtime_id.clone();
    let mut config = DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    );
    config.queue_capacity = 1;
    let ingress = DirectRuntimeIngress::bind(config).expect("real capacity-one ingress");
    let mut service = payment_service(
        replica,
        ingress,
        &directory,
        SOURCE_SEED,
        EntityRoute {
            target_entity_id: format!("0x{}", "ff".repeat(32)),
            target_runtime_id: peer_runtime.clone(),
            target_signer_id: format!("0x{}", "66".repeat(20)),
            websocket_url: Some(format!("ws://127.0.0.1:{}/ws", server.port)),
        },
    );
    service
        .process_local_entity_inputs(payment.clone())
        .expect("real payment proposal")
        .expect("proposal Runtime frame");
    service.sync_committed().expect("payment proposal fsync");
    // Do not call process_next: one accepted frame fills the queue, the
    // second real authenticated server reply must block the dialed reader.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while service.ingress_metrics().backpressure_events == 0 && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let blocked = service.ingress_metrics();
    assert!(
        blocked.backpressure_events > 0,
        "actual reader saturation, not capacity configuration"
    );
    assert_eq!(blocked.accepted_batches, 1);
    assert_eq!(
        service.open_runtime_ids().expect("actual dialed session"),
        vec![peer_runtime]
    );
    server.wait_for_rows(1);
    assert_eq!(
        blocked.pending_batches, 2,
        "one queued and one reader-held real input"
    );
    let second = service
        .process_local_entity_inputs(payment)
        .expect("next local payment while reader blocked")
        .expect("next financial Runtime frame");
    let height = second
        .commitments
        .expect("next financial commitment")
        .height;
    let durable = service
        .sync_committed()
        .expect("full ingress must not deadlock the WAL committer")
        .expect("second frame fsync report");
    assert_eq!(durable.durable_height, Some(height));
    assert_eq!(height, 2);
    assert_eq!(
        service.ingress_metrics().pending_batches,
        2,
        "fsync completed before the first drain"
    );
    assert_eq!(service.ingress_metrics().accepted_batches, 1);
    let drain_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while service.ingress_metrics().pending_batches > 0
        && std::time::Instant::now() < drain_deadline
    {
        service
            .process_next(std::time::Duration::from_millis(2))
            .expect("drain real authenticated inputs");
    }
    assert_eq!(service.ingress_metrics().accepted_batches, 2);
    assert_eq!(service.ingress_metrics().pending_batches, 0);
    assert_eq!(
        service.ingress_metrics().accepted_connections,
        0,
        "both replies use Rust's outgoing socket, with no inbound connection"
    );
    assert_eq!(service.ingress_metrics().queue_rejections, 0);
    service.sync_committed().expect("drained frame fsync");
    service.shutdown().expect("saturation service shutdown");
    drop(service);
    drop(server);
    let mut wal = NativeRuntimeStore::open(&directory, NativeStorageConfig::default())
        .expect("reopen real WAL");
    let frame = wal
        .read_durable_frame(height)
        .expect("financial frame durable despite saturated reader");
    let frame = crate::decode_storage_payload(&frame.frame_bytes).expect("financial frame decode");
    // An existing local continuation precedes the new financial input in
    // this frame. Assert the exact payment without inventing input position.
    let financial_txs: Vec<_> = frame["runtimeInput"]["entityInputs"]
        .as_array()
        .expect("durable financial inputs")
        .iter()
        .filter(|input| input["entityId"] == owner && input["signerId"] == signer)
        .flat_map(|input| input["entityTxs"].as_array().expect("Entity transactions"))
        .filter(|tx| tx["type"] == "directPayment")
        .collect();
    assert_eq!(financial_txs.len(), 1, "exactly one new durable payment");
    assert_eq!(financial_txs[0]["data"]["tokenId"], 1);
    assert_eq!(
        financial_txs[0]["data"]["amount"],
        json!({"__xlnType": "BigInt", "value": "7"})
    );
    assert_eq!(
        financial_txs[0]["data"]["targetEntityId"],
        format!("0x{}", "ff".repeat(32))
    );
    drop(wal);
    std::fs::remove_dir_all(directory).expect("remove saturation fixture");
}

#[test]
fn one_runtime_input_is_applied_fsynced_and_recovered_once() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let input = direct_payment_input(&replica);
    let server = CanonicalWsServer::start("recover-payment");
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("native store");
    let routes = payment_routes(&server);
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("durable processor");
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    let mut report = processor.process(input).expect("durable frame");
    merge_synced(
        &mut report,
        processor.sync_committed().expect("commit sync"),
    );
    assert_eq!(report.durable_height, Some(1));
    wait_for_processor_publication(&mut processor, &mut report, 1);
    server.wait_for_rows(1);
    assert_eq!(server.rows().expect("received payment").len(), 1);
    let commitments = report.commitments.expect("post-fsync commitments");
    assert_eq!(commitments.height, 1);
    assert_eq!(commitments.runtime_output_count, 1);
    assert!(commitments.entity_event_count > 0);
    assert_eq!(commitments.entity_effect_count, 0);
    assert_ne!(commitments.runtime_frame_hash, [0; 32]);
    assert_ne!(commitments.post_state_hash, [0; 32]);
    let entity_commitment = commitments.entities.first().expect("Entity commitment");
    assert_ne!(entity_commitment.certified_frame_hash, [0; 32]);
    assert_ne!(commitments.events_parity_digest, [0; 32]);
    assert_ne!(commitments.entity_effects_parity_digest, [0; 32]);
    assert_eq!(
        entity_commitment.accounts_root,
        entity_state(processor.replica().expect("live replica")).accounts_root
    );
    assert_eq!(processor.replica().expect("live replica").state.height, 1);
    ingress.shutdown().expect("payment reactor shutdown");
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen after process crash");
    let recovery = reopened.recover().expect("recover durable WAL");
    assert_eq!(recovery.checkpoint.as_ref().map(|row| row.height), Some(1));
    assert!(recovery.wal_frames.is_empty());
    assert_eq!(recovery.pending_outbox.len(), 1);
    assert_payment_proposal(&recovery.pending_outbox[0].outputs);
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn local_prepare_dispute_freezes_the_existing_account_in_its_durable_runtime_frame() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let key = entity_key(&replica);
    let owner = entity_state(&replica).entity.entity_id.clone();
    let peer = format!("0x{}", "ff".repeat(32));
    let account_id = AccountId::from_bytes(
        *EntityId::parse(&peer)
            .expect("fixture peer Entity")
            .as_bytes(),
    );
    let initial_accounts_root = entity_state(&replica).accounts_root;
    let input = RuntimeEntityInput::decode(json!({
        "entityId": owner,
        "signerId": key.signer_id,
        "entityTxs": [{
            "type": "prepareDispute",
            "data": {
                "counterpartyEntityId": peer,
                "description": "local durable prepare reproduction",
                "minCooldownMs": 10,
            },
        }],
    }))
    .expect("local prepareDispute input");
    let store = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("local prepare store");
    let processor = DurableRuntimeProcessor::new(
        replica,
        store,
        EntityRouteTable::new([]).expect("empty routes"),
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("local prepare signer"),
    )
    .expect("local prepare processor");
    let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .expect("local prepare ingress");
    let mut service = ResidentRuntimeService::new(
        processor,
        ingress,
        Box::new(CanonicalEntityInfraMaterializer::new()),
    )
    .expect("local prepare service");

    assert!(
        service
            .account_status(&key, account_id, vec![])
            .expect("initial Account view")
            .expect("existing Account")
            .active,
        "fixture Account must start active",
    );
    let report = service
        .process_local_entity_inputs_at(vec![input], 200)
        .expect("local prepareDispute apply")
        .expect("local prepareDispute Runtime frame");
    assert_eq!(report.runtime_entity_inputs, 1);
    assert_eq!(report.entity_txs_selected, 1);
    assert_eq!(report.entity_txs_pending, 0);
    let commitments = report.commitments.as_ref().expect("frame commitments");
    assert_eq!(commitments.height, 1);
    let committed_accounts_root = commitments
        .entities
        .first()
        .expect("Entity commitment")
        .accounts_root;
    assert_eq!(
        service
            .sync_committed()
            .expect("local prepare fsync")
            .expect("local prepare durable report")
            .durable_height,
        Some(1),
    );
    let frame_events = service
        .processor()
        .replica()
        .expect("post-commit replica")
        .e_replicas
        .get(&key)
        .expect("post-commit Entity replica")
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .expect("post-commit Entity frame")
        .frame
        .events
        .clone();
    assert!(
        !service
            .account_status(&key, account_id, vec![])
            .expect("post-commit Account view")
            .expect("existing Account after prepare")
            .active,
        "prepareDispute must freeze the resident Account; frame events: {frame_events:?}",
    );
    assert_ne!(committed_accounts_root, initial_accounts_root);
    assert_eq!(
        committed_accounts_root,
        entity_state(service.processor().replica().expect("post-frame replica")).accounts_root,
        "the mutated Account root must belong to the same Runtime frame",
    );

    service.shutdown().expect("local prepare shutdown");
    drop(service);
    let mut reopened = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("reopen local prepare store");
    assert_eq!(
        reopened
            .recover()
            .expect("recover local prepare frame")
            .checkpoint
            .as_ref()
            .map(|row| row.height),
        Some(1),
    );
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove local prepare fixture");
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
        "entityId": entity_state(&replica).entity.entity_id,
        "signerId": entity_key(&replica).signer_id,
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
    };
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
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
    let mut materializer = CanonicalEntityInfraMaterializer::new();
    let mut report = processor
        .process_live(input, &mut materializer)
        .expect("selected context then fsynced Runtime frame");
    merge_synced(
        &mut report,
        processor.sync_committed().expect("commit sync"),
    );
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(report.outputs_published, 0);
    let commitments = report.commitments.as_ref().expect("post-fsync commitments");
    assert_eq!(commitments.events_parity_digest, [0; 32]);
    assert_eq!(commitments.entity_effects_parity_digest, [0; 32]);
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
    let target_entity_id = entity_state(&replica).entity.entity_id.clone();
    let target_signer_id = entity_key(&replica).signer_id;
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
        Box::new(CanonicalEntityInfraMaterializer::new()),
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
    let mut source_ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        source_seed,
        source_signer,
    ))
    .expect("source publication reactor");
    publisher.attach_inbound_sessions(source_ingress.sessions());
    source_ingress
        .set_delivery_ready(true)
        .expect("source receive ready");
    publisher
        .set_delivery_ready(true)
        .expect("source publisher ready");
    publisher
        .publish_durable(&mut source_store, &first)
        .expect("first authenticated socket publish");
    publisher
        .publish_durable(&mut source_store, &second)
        .expect("second authenticated socket publish");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while service.ingress_metrics().accepted_batches < 2 && std::time::Instant::now() < deadline {
        publisher
            .retry_pending()
            .expect("source async completion and FIFO retry");
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(service.ingress_metrics().accepted_batches, 2);

    let mut report = service
        .process_next(std::time::Duration::from_secs(3))
        .expect("socket to durable reducer")
        .expect("one durable Runtime frame");
    merge_synced(&mut report, service.sync_committed().expect("commit sync"));
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
    drop(publisher);
    source_ingress.shutdown().expect("source reactor shutdown");
    service.shutdown().expect("target shutdown");
    drop(service);
    drop(source_store);

    let mut reopened = NativeRuntimeStore::open(&target_path, NativeStorageConfig::default())
        .expect("restart target store");
    let recovery = reopened.recover().expect("recover target frame");
    assert_eq!(
        recovery.checkpoint.as_ref().map(|row| row.height),
        Some(1),
        "the first Runtime frame materializes even without Entity work"
    );
    assert!(recovery.wal_frames.is_empty());
    let durable = reopened.read_durable_frame(1).expect("genesis frame");
    let frame = crate::decode_storage_payload(&durable.frame_bytes)
        .expect("recovered coalesced Runtime frame");
    let source_runtime_id =
        derive_local_runtime_id(source_seed, source_signer).expect("authenticated sender");
    let expected_inputs = [(1, 150), (2, 151)].map(|(height, timestamp)| {
        json!({
            "runtimeId": target_runtime_id,
            "entityId": target_entity_id,
            "signerId": target_signer_id,
            "entityTxs": [],
            "from": source_runtime_id,
            "sourceRuntimeFrame": {"height": height, "timestamp": timestamp},
        })
    });
    assert_eq!(
        frame["runtimeInput"],
        json!({"runtimeTxs": [], "entityInputs": expected_inputs})
    );
    assert_eq!(frame["runtimeOutputCount"], 0);
    assert!(
        frame.get("entityContextRefs").is_none(),
        "idle Entity contexts are omitted"
    );
    assert_eq!(recovery.pending_outbox.len(), 1);
    assert!(recovery.pending_outbox[0].outputs.is_empty());
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
        Box::new(CanonicalEntityInfraMaterializer::new()),
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
    let hub_entity_id = entity_state(&replica).entity.entity_id.clone();
    let hub_signer_id = entity_key(&replica).signer_id;
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
        Box::new(CanonicalEntityInfraMaterializer::new()),
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
    user.set_delivery_ready(true)
        .expect("user startup complete");
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
    assert!(
        report
            .expect("held batch processes after publish")
            .is_some(),
        "a pending target must not globally block the already-admitted inbound batch",
    );
    let reply = user.recv_envelope().expect("hub reply after reconnect");
    assert_eq!(reply["sourceRuntimeHeight"], 1);
    user.close();
    service.shutdown().expect("inbound-only shutdown");
    drop(service);
    std::fs::remove_dir_all(path).expect("remove inbound-only fixture");
}

/// Restart boundary: the previous process bound the peer through its signed
/// Profile (RAM). After the restart no operator route and no re-announced
/// Profile exist, yet a new committed output for that peer must bind through
/// the destination already fsynced in the flat outbox instead of fail-stopping
/// on `RRS_ENTITY_ROUTE_MISSING`. Both rows stay in the publication backlog
/// until the peer's authenticated session exists, then publish exactly once in
/// durable order.
#[test]
fn restart_rebinds_a_known_peer_from_the_durable_outbox_and_publishes_once() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let user_seed = "rrs-recovered-route-user";
    let user_signer = "user";
    let user_runtime_id = derive_local_runtime_id(user_seed, user_signer).expect("user runtime id");
    let peer_entity_id = format!("0x{}", "ff".repeat(32));
    let peer_signer_id = format!("0x{}", "66".repeat(20));
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
            &peer_entity_id,
            &peer_signer_id,
        )],
        None,
    )
    .expect("durable row bound before the restart");
    let frame_hash = encoded.frame_hash;
    let mut store = NativeRuntimeStore::open(&path, NativeStorageConfig::default())
        .expect("recovered-route store");
    store
        .append_frame(encoded.commit)
        .expect("recovered-route fsync");
    let mut replica = processor_replica();
    replica.state.height = 1;
    replica
        .durable
        .advance_frame_hash([0; 32], frame_hash)
        .expect("recovered-route lineage");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        EntityRouteTable::new([]).expect("no operator route and no re-announced profile"),
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("recovered-route signer"),
    )
    .expect("restart binds the peer from its own durable outbox");
    let ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    let staged = processor
        .retry_publication()
        .expect("resend while the peer is offline")
        .expect("the recovered frame is staged for resend");
    assert_eq!(
        (staged.durable_height, staged.outputs_published),
        (Some(1), 0)
    );
    let backlog = processor.publication_backlog();
    assert_eq!((backlog.targets, backlog.rows), (1, 1));
    assert_eq!(
        backlog.failures.keys().collect::<Vec<_>>(),
        vec![&user_runtime_id],
        "the recovered row waits for the peer's session; it is neither dropped nor fatal",
    );

    let payment = direct_payment_input(processor.replica().expect("restarted replica"));
    let mut report = processor
        .process(payment)
        .expect("a new committed output binds through the recovered route");
    merge_synced(
        &mut report,
        processor.sync_committed().expect("payment WAL fsync"),
    );
    assert_eq!(report.durable_height, Some(2));
    assert_eq!(report.outputs_published, 0);
    assert_eq!(processor.publication_backlog().rows, 2);
    let proposal = processor
        .read_durable_frame(2)
        .expect("durable payment frame");
    assert_payment_proposal(&proposal.outputs);
    let bound = crate::decode_storage_payload(&proposal.outputs[0]).expect("bound row");
    assert_eq!(bound["runtimeId"], user_runtime_id);
    assert_eq!(bound["signerId"], peer_signer_id);

    let mut user = DirectSession::connect(SessionConfig {
        url: &format!("ws://{}/ws", ingress.local_address()),
        target_runtime_id: ingress.runtime_id(),
        source_runtime_id: &user_runtime_id,
        source_seed: user_seed,
        source_signer_id: user_signer,
        identity: &encryption_identity(user_seed),
        io_timeout: std::time::Duration::from_secs(3),
        max_message_bytes: 32 * 1024 * 1024,
    })
    .expect("peer reconnects after the restart");
    user.set_delivery_ready(true)
        .expect("peer startup complete");
    wait_for_processor_publication(&mut processor, &mut report, 2);
    let first = user.recv_envelope().expect("recovered frame-1 row");
    assert_eq!(first["sourceRuntimeHeight"], 1);
    let second = user.recv_envelope().expect("new frame-2 proposal");
    assert_eq!(second["sourceRuntimeHeight"], 2);
    assert!(
        processor.retry_publication().expect("idle retry").is_none(),
        "each row publishes exactly once",
    );
    let backlog = processor.publication_backlog();
    assert_eq!((backlog.targets, backlog.rows), (0, 0));
    assert!(backlog.failures.is_empty());
    assert!(!processor.has_pending_publication());
    user.close();
    drop(ingress);
    drop(processor);
    std::fs::remove_dir_all(path).expect("remove recovered-route fixture");
}

#[test]
fn runtime_checkpoint_cadence_materializes_without_entity_work() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let mut replica = processor_replica();
    replica.limits.canonical_hash_period_frames = 1;
    let input = direct_payment_input(&replica);
    let server = CanonicalWsServer::start("canonical-cadence");
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("native store");
    let routes = payment_routes(&server);
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    processor
        .process(input)
        .expect("materialized genesis frame");
    let first_root = entity_state(processor.replica().expect("payment replica")).accounts_root;
    let second_input = empty_entity_input_at(processor.replica().expect("live replica"), 300);
    processor
        .process(second_input)
        .expect("durable canonical-only frame");
    let durable = processor.read_durable_frame(2).expect("durable frame");
    let frame = crate::decode_storage_payload(&durable.frame_bytes).expect("decode frame");
    assert_eq!(frame.get("materializedState"), Some(&Value::Bool(false)));
    assert!(frame.get("canonicalStateHash").is_some());
    assert!(frame.get("canonicalEntityHashes").is_some());
    assert!(frame.get("runtimeMachineRoot").is_none());
    assert!(
        frame.get("entityContextRefs").is_none(),
        "idle Entity contexts are omitted"
    );
    assert_eq!(
        entity_state(processor.replica().expect("idle replica")).accounts_root,
        first_root
    );
    assert_payment_proposal(&processor.read_durable_frame(1).unwrap().outputs);
    // No Entity transition produces a checkpoint in these empty admissions.
    // The Runtime must still materialize at HEAD(1) + period(100).
    for height in 3..=101 {
        let input = empty_entity_input_at(processor.replica().unwrap(), 300 + height);
        processor
            .process(input)
            .expect("Runtime cadence without Entity work");
    }
    let durable = processor.read_durable_frame(101).expect("cadence frame");
    let frame = crate::decode_storage_payload(&durable.frame_bytes).unwrap();
    assert_eq!(frame.get("materializedState"), Some(&Value::Bool(true)));
    assert_eq!(
        entity_state(processor.replica().unwrap()).accounts_root,
        first_root
    );
    ingress
        .shutdown()
        .expect("canonical cadence reactor shutdown");
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("reopen");
    let recovery = reopened.recover().expect("recover");
    assert_eq!(
        recovery.checkpoint.as_ref().map(|row| row.height),
        Some(101)
    );
    assert!(recovery.wal_frames.is_empty());
    assert!(
        recovery
            .pending_outbox
            .iter()
            .all(|frame| frame.outputs.is_empty())
    );
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove processor fixture");
}

#[test]
fn checkpoint_barrier_materializes_an_isolated_runtime_frame_off_cadence() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let server = CanonicalWsServer::start("checkpoint-barrier");
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("native store");
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        payment_routes(&server),
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    processor
        .process(direct_payment_input(
            processor.replica().expect("genesis replica"),
        ))
        .expect("materialized genesis");
    let first_root = entity_state(processor.replica().expect("barrier replica")).accounts_root;
    let barrier = RuntimeInput {
        runtime_txs: vec![RuntimeTx::CheckpointBarrier],
        entity_inputs: Vec::new(),
        frame: idle_frame_context(300),
    };
    processor.process(barrier).expect("materialized barrier");
    let durable = processor.read_durable_frame(2).expect("barrier frame");
    let frame = crate::decode_storage_payload(&durable.frame_bytes).expect("decode barrier frame");
    assert_eq!(frame.get("materializedState"), Some(&Value::Bool(true)));
    assert_eq!(
        entity_state(processor.replica().expect("barrier replica")).accounts_root,
        first_root
    );
    assert_eq!(
        frame.pointer("/runtimeInput/runtimeTxs/0/type"),
        Some(&Value::String("checkpointBarrier".into()))
    );
    ingress.shutdown().expect("barrier reactor shutdown");
    drop(processor);

    let mut reopened =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("reopen store");
    assert_eq!(
        reopened
            .recover()
            .expect("recover barrier")
            .checkpoint
            .as_ref()
            .map(|row| row.height),
        Some(2)
    );
    drop(reopened);
    std::fs::remove_dir_all(path).expect("remove barrier fixture");
}

#[test]
fn cadence_100_is_measured_from_the_first_materialized_runtime_frame() {
    let path = path();
    let _ = std::fs::remove_dir_all(&path);
    let replica = processor_replica();
    let server = CanonicalWsServer::start("materialized-cadence");
    let store = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
        },
    )
    .expect("native store");
    let routes = payment_routes(&server);
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    let mut materializer = CanonicalEntityInfraMaterializer::new();
    for height in 1..=101 {
        let timestamp = 100_u64.checked_add(height).expect("timestamp");
        let entity_inputs = if height == 1 || height == 101 {
            direct_payment_input(processor.replica().expect("live replica")).entity_inputs
        } else {
            empty_entity_input_at(processor.replica().expect("live replica"), timestamp)
                .entity_inputs
        };
        let mut report = processor
            .process_live(
                RuntimeLiveInput {
                    runtime_txs: Vec::new(),
                    entity_inputs,
                    timestamp,
                    finalized_j_height: 0,
                },
                &mut materializer,
            )
            .expect("canonical live frame");
        merge_synced(
            &mut report,
            processor.sync_committed().expect("commit sync"),
        );
        assert_eq!(report.durable_height, Some(height));
        let durable = processor.read_durable_frame(height).expect("cadence frame");
        let encoded = crate::decode_storage_payload(&durable.frame_bytes).expect("cadence decode");
        assert_eq!(encoded["materializedState"], height == 1 || height == 101);
        if height > 1 && height < 101 {
            assert!(
                report
                    .commitments
                    .expect("idle Runtime commitment")
                    .entities
                    .is_empty()
            );
        }
    }
    assert_eq!(processor.replica().expect("live replica").state.height, 101);
    let expected_accounts_root =
        entity_state(processor.replica().expect("live replica")).accounts_root;
    ingress.shutdown().expect("cadence reactor shutdown");
    drop(processor);

    let mut reopened = NativeRuntimeStore::open(
        &path,
        NativeStorageConfig {
            checkpoint_period_frames: 100,
            ..NativeStorageConfig::default()
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
    let input = direct_payment_input(&replica);
    let server = CanonicalWsServer::start("uncertain-fsync");
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let routes = payment_routes(&server);
    let mut processor = DurableRuntimeProcessor::new(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("processor");
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);

    // Keep LevelDB's open file handles alive but remove the directory at the
    // exact boundary that must be fsynced after its synchronous write. The
    // write outcome is now uncertain, so neither the replica nor any output
    // may be exposed and the process must be reopened from durable storage.
    std::fs::rename(&path, &displaced).expect("displace live database directory");
    processor
        .process(input)
        .expect("apply may pipeline ahead of the commit result");
    assert!(matches!(
        processor.sync_committed(),
        Err(DurableRuntimeProcessorError::Storage(_))
    ));
    assert!(matches!(
        processor.replica(),
        Err(DurableRuntimeProcessorError::Poisoned)
    ));
    assert_eq!(
        server.rows(),
        None,
        "uncertain payment must never reach the real peer"
    );
    assert_eq!(
        ingress.metrics().authenticated_sessions,
        0,
        "no pre-fsync publication connection"
    );
    ingress
        .shutdown()
        .expect("uncertain-fsync reactor shutdown");
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
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    let first = processor
        .process(input)
        .expect("durable frame stages despite unavailable peer");
    assert_eq!(first.outputs_published, 0);
    assert_eq!(
        processor.replica().expect("durable replica").state.height,
        1
    );
    let next = no_external_input(300);
    processor
        .process(next)
        .expect("unavailable peer does not block the next Runtime input");
    assert_eq!(
        processor.replica().expect("advanced replica").state.height,
        2
    );
    ingress
        .shutdown()
        .expect("unavailable peer fixture shutdown");
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
    let mut report = processor.process(input).expect("durable replay frame");
    merge_synced(
        &mut report,
        processor.sync_committed().expect("commit sync"),
    );
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
fn cross_j_r6_h72_recorded_omission_cannot_hide_new_native_output_or_change_sender_pruning() {
    let path = path();
    let replica = processor_replica();
    let input = direct_payment_input(&replica);
    let reference = processor_replica();
    let reference_input = direct_payment_input(&reference);
    let mut applied = crate::apply_runtime(reference, reference_input)
        .expect("canonical direct-payment transition");
    let routes = EntityRouteTable::new([EntityRoute {
        target_entity_id: format!("0x{}", "ff".repeat(32)),
        target_runtime_id: format!("0x{}", "55".repeat(20)),
        target_signer_id: format!("0x{}", "66".repeat(20)),
        websocket_url: Some("ws://127.0.0.1:1/ws".into()),
    }])
    .expect("canonical remote route");
    let store =
        NativeRuntimeStore::open(&path, NativeStorageConfig::default()).expect("native store");
    let mut processor = DurableRuntimeProcessor::new_replay_validate_only(
        replica,
        store,
        routes,
        SOURCE_SEED,
        RuntimeSignerLabel::new(SOURCE_SIGNER).expect("signer label"),
    )
    .expect("exact replay processor");
    // Recorded current outputs are comparison evidence only. Omitting the
    // genuine proposal must leave it generated and durably committed, so the
    // replay caller's ordered count/digest comparison exposes the omission.
    let mut report = processor
        .process_exact_replay(input, &[])
        .expect("generate proposal despite the recorded omission");
    merge_synced(&mut report, processor.sync_committed().expect("WAL fsync"));
    assert_eq!(report.durable_height, Some(1));
    assert_eq!(report.outputs_published, 1);
    assert_eq!(
        report
            .commitments
            .as_ref()
            .expect("actual commitments")
            .runtime_output_count,
        1
    );
    let frame = processor
        .read_durable_frame(1)
        .expect("actual native WAL evidence");
    assert_eq!(frame.outputs.len(), 1);
    let output = crate::decode_storage_payload(&frame.outputs[0]).expect("actual proposal");
    assert_eq!(output["sourceRuntimeFrame"]["height"], 1);
    assert_eq!(output["entityTxs"][0]["type"], "accountInput");
    assert_eq!(output["entityTxs"][0]["data"]["kind"], "ack_frame");
    assert!(output["entityTxs"][0]["data"]["ack"].is_null());
    let proposal = &output["entityTxs"][0]["data"]["proposal"]["frame"];
    assert_eq!(
        proposal["accountTxs"]
            .as_array()
            .expect("economic txs")
            .len(),
        1
    );
    assert_eq!(proposal["accountTxs"][0]["type"], "direct_payment");
    assert_eq!(
        proposal["accountTxs"][0]["data"]["amount"],
        json!({"__xlnType":"BigInt","value":"7"})
    );
    let settled = super::projection::replay_proposal_settled;
    assert!(!settled(&mut applied.replica, &output).expect("matching pending proposal"));
    let mut changed_height = output.clone();
    changed_height["entityTxs"][0]["data"]["proposal"]["frame"]["height"] =
        json!(proposal["height"].as_u64().expect("proposal height") + 1);
    assert!(settled(&mut applied.replica, &changed_height).expect("different proposal height"));
    let mut changed_hash = output.clone();
    changed_hash["entityTxs"][0]["data"]["proposal"]["frame"]["stateHash"] =
        json!(format!("0x{}", "00".repeat(32)));
    assert!(settled(&mut applied.replica, &changed_hash).expect("different proposal hash"));
    // This classifier runs after signature validation. Its ACK-presence rule
    // must preserve the envelope independently of successor proposal liveness.
    changed_hash["entityTxs"][0]["data"]["ack"] = json!({
        "height": proposal["height"], "frameHash": proposal["stateHash"],
        "frameHanko": output["entityTxs"][0]["data"]["proposal"]["frameHanko"],
    });
    assert!(!settled(&mut applied.replica, &changed_hash).expect("ACK remains owed"));
    let mut missing_owner = output;
    missing_owner["entityTxs"][0]["data"]["fromEntityId"] = json!(format!("0x{}", "77".repeat(32)));
    assert!(
        settled(&mut applied.replica, &missing_owner)
            .unwrap_err()
            .to_string()
            .contains("ACCOUNT_PROPOSAL_SOURCE_MISSING")
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
    let mut ingress = attached_test_ingress(&mut processor, SOURCE_SEED, SOURCE_SIGNER);
    let mut first = processor.process(input).expect("fsync then websocket");
    merge_synced(&mut first, processor.sync_committed().expect("commit sync"));
    assert_eq!(first.durable_height, Some(1));
    wait_for_processor_publication(&mut processor, &mut first, 1);
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

    let next_input = no_external_input(300);
    let mut second = processor
        .process(next_input)
        .expect("local continuation under fresh context");
    merge_synced(
        &mut second,
        processor.sync_committed().expect("commit sync"),
    );
    assert_eq!(second.durable_height, Some(2));
    assert_eq!(second.outputs_published, 0);
    assert_eq!(processor.replica().expect("replica").state.height, 2);
    assert_eq!(processor.replica().expect("replica").state.timestamp, 300);
    ingress
        .shutdown()
        .expect("publication fixture reactor shutdown");
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
