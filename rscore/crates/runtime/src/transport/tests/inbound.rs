use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::super::crypto::{derive_local_runtime_id, encryption_identity};
use super::super::routing::OutboundEnvelope;
use super::super::session::{DirectSession, SessionConfig};
use super::super::*;
use crate::storage::native::{
    CanonicalRuntimeFrameDraft, NativeRuntimeStore, NativeStorageConfig, RuntimeFrameCommit,
    build_runtime_frame_commit,
};

static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

#[test]
fn rust_publisher_reaches_authenticated_rust_ingress_without_a_delivery_receipt() {
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        "rrs-ingress-server",
        "server",
    ))
    .expect("bind ingress");
    let target = ingress.runtime_id().to_owned();
    let source_seed = "rrs-ingress-client";
    let source_signer = "client";
    let source = super::super::crypto::derive_local_runtime_id(source_seed, source_signer)
        .expect("source runtime id");
    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "xln-rscore-native-ingress-{}-{serial}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let durable = store
        .append_frame(frame(1, vec![output_row(&target, 1)]))
        .expect("durable frame");
    let routes = DirectRouteTable::new([DirectRoute {
        target_runtime_id: target,
        url: format!("ws://{}/ws", ingress.local_address()),
    }])
    .expect("route table");
    let mut publisher = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        source_seed,
        source_signer,
        routes,
    ))
    .expect("publisher");
    let report = publisher
        .publish_durable(&mut store, &durable)
        .unwrap_or_else(|error| {
            panic!(
                "authenticated publication:{error}:server={:?}",
                ingress.last_session_error()
            )
        });
    assert_eq!((report.rows_published, report.envelopes_published), (1, 1));
    let received = ingress
        .recv_timeout(Duration::from_secs(3))
        .expect("ingress healthy")
        .expect("one inbound batch");
    assert_eq!(received.peer_runtime_id, source);
    assert_eq!(
        (
            received.source_runtime_height,
            received.source_runtime_timestamp
        ),
        (1, 123)
    );
    assert_eq!(
        (received.entity_inputs.len(), received.entity_tx_count),
        (1, 0)
    );
    let metrics_deadline = std::time::Instant::now() + Duration::from_secs(1);
    while ingress.metrics().accepted_batches != 1 && std::time::Instant::now() < metrics_deadline {
        std::thread::yield_now();
    }
    assert_eq!(ingress.metrics().accepted_batches, 1);
    publisher.close();
    ingress.shutdown().expect("clean shutdown");
    drop(store);
    fs::remove_dir_all(base).expect("remove fixture");
}

#[test]
fn inbound_session_replies_after_wal_without_a_second_dial() {
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        "rrs-ingress-reply-server",
        "server",
    ))
    .expect("bind ingress");
    let hub_runtime_id = ingress.runtime_id().to_owned();
    let user_seed = "rrs-ingress-reply-user";
    let user_signer = "user";
    let user_runtime_id = derive_local_runtime_id(user_seed, user_signer).expect("user runtime id");
    let mut user = DirectSession::connect(SessionConfig {
        url: &format!("ws://{}/ws", ingress.local_address()),
        target_runtime_id: &hub_runtime_id,
        source_runtime_id: &user_runtime_id,
        source_seed: user_seed,
        source_signer_id: user_signer,
        identity: &encryption_identity(user_seed),
        io_timeout: Duration::from_secs(3),
        max_message_bytes: 32 * 1024 * 1024,
    })
    .expect("user dials hub");
    wait_for_open_session(&ingress, &user_runtime_id);
    assert_eq!(ingress.metrics().open_sessions, 1);
    user.send_envelope(&user_to_hub_envelope(&hub_runtime_id, &user_runtime_id))
        .expect("user inbound entity_inputs");
    let received = ingress
        .recv_timeout(Duration::from_secs(3))
        .expect("ingress healthy")
        .expect("inbound batch on retained session");
    assert_eq!(received.peer_runtime_id, user_runtime_id);

    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "xln-rscore-native-inbound-reply-{}-{serial}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let first = store
        .append_frame(frame(1, vec![output_row(&user_runtime_id, 1)]))
        .expect("durable height 1");
    let second = store
        .append_frame(frame(2, vec![output_row(&user_runtime_id, 2)]))
        .expect("durable height 2");
    let mut publisher = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        "rrs-ingress-reply-server",
        "server",
        DirectRouteTable::new([]).expect("no dial routes"),
    ))
    .expect("publisher");
    publisher.attach_inbound_sessions(ingress.sessions());
    let first_report = publisher
        .publish_durable(&mut store, &first)
        .expect("reply on inbound session");
    assert_eq!(
        (first_report.rows_published, first_report.rows_pending),
        (0, 1)
    );
    let first_reply = user.recv_envelope().expect("first hub reply");
    assert_eq!(first_reply["sourceRuntimeHeight"], 1);
    assert_eq!(first_reply["sourceRuntimeId"], hub_runtime_id);
    let first_completion = publisher
        .retry_pending()
        .expect("collect first socket write");
    assert_eq!(
        (
            first_completion.rows_published,
            first_completion.rows_pending
        ),
        (1, 0)
    );
    let second_report = publisher
        .publish_durable(&mut store, &second)
        .expect("fifo second reply");
    assert_eq!(
        (second_report.rows_published, second_report.rows_pending),
        (0, 1)
    );
    let second_reply = user.recv_envelope().expect("second hub reply");
    assert_eq!(second_reply["sourceRuntimeHeight"], 2);
    let second_completion = publisher
        .retry_pending()
        .expect("collect second socket write");
    assert_eq!(
        (
            second_completion.rows_published,
            second_completion.rows_pending
        ),
        (1, 0)
    );
    publisher.close();
    user.close();
    ingress.shutdown().expect("clean shutdown");
    drop(store);
    fs::remove_dir_all(base).expect("remove reply fixture");
}

#[test]
fn full_writer_queue_applies_backpressure_without_dropping_the_batch() {
    let mut config = DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        "rrs-ingress-backpressure-server",
        "server",
    );
    config.queue_capacity = 1;
    let mut ingress = DirectRuntimeIngress::bind(config).expect("bind ingress");
    let hub_runtime_id = ingress.runtime_id().to_owned();
    let mut users = ["backpressure-a", "backpressure-b"].map(|seed| {
        let runtime_id = derive_local_runtime_id(seed, "user").expect("user runtime id");
        let session = DirectSession::connect(SessionConfig {
            url: &format!("ws://{}/ws", ingress.local_address()),
            target_runtime_id: &hub_runtime_id,
            source_runtime_id: &runtime_id,
            source_seed: seed,
            source_signer_id: "user",
            identity: &encryption_identity(seed),
            io_timeout: Duration::from_secs(3),
            max_message_bytes: 32 * 1024 * 1024,
        })
        .expect("user dials hub");
        (runtime_id, session)
    });
    for (runtime_id, session) in &mut users {
        wait_for_open_session(&ingress, runtime_id);
        session
            .send_envelope(&user_to_hub_envelope(&hub_runtime_id, runtime_id))
            .expect("user inbound entity_inputs");
    }
    let blocked_deadline = Instant::now() + Duration::from_secs(1);
    while ingress.metrics().backpressure_events == 0 && Instant::now() < blocked_deadline {
        std::thread::yield_now();
    }
    let blocked = ingress.metrics();
    assert_eq!(blocked.backpressure_events, 1);
    assert_eq!(blocked.pending_batches_high_water, 2);
    assert_eq!(blocked.queue_rejections, 0);

    let received = [0, 1].map(|_| {
        ingress
            .recv_timeout(Duration::from_secs(1))
            .expect("ingress healthy")
            .expect("retained batch")
            .peer_runtime_id
    });
    assert!(
        users
            .iter()
            .all(|(runtime_id, _)| received.contains(runtime_id))
    );
    let accepted_deadline = Instant::now() + Duration::from_secs(1);
    while ingress.metrics().accepted_batches != 2 && Instant::now() < accepted_deadline {
        std::thread::yield_now();
    }
    let metrics = ingress.metrics();
    assert_eq!(metrics.accepted_batches, 2);
    assert_eq!(metrics.pending_batches, 0);
    assert!(metrics.backpressure_wait_micros > 0);
    assert!(metrics.backpressure_wait_max_micros > 0);
    for (_, session) in users {
        session.close();
    }
    ingress.shutdown().expect("clean shutdown");
}

#[test]
fn stalled_inbound_target_does_not_block_a_healthy_target() {
    let table = InboundSessionTable::default();
    let poll = mio::Poll::new().expect("poll");
    let waker =
        std::sync::Arc::new(mio::Waker::new(poll.registry(), mio::Token(0)).expect("waker"));
    let (work_tx, _work_rx) = std::sync::mpsc::sync_channel(1);
    let user = format!("0x{}", "aa".repeat(20));
    let _guard = table
        .register(&user, work_tx, waker)
        .expect("stalled inbound session");
    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "xln-rscore-native-inbound-timeout-{}-{serial}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let mut healthy = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        "rrs-ingress-healthy-target",
        "healthy",
    ))
    .expect("bind healthy target");
    let healthy_runtime_id = healthy.runtime_id().to_owned();
    let first = store
        .append_frame(frame(
            1,
            vec![output_row(&user, 1), output_row(&healthy_runtime_id, 1)],
        ))
        .expect("durable height 1");
    let second = store
        .append_frame(frame(2, vec![output_row(&healthy_runtime_id, 2)]))
        .expect("durable height 2");
    let mut config = DirectOutboxPublisherConfig::production(
        "rrs-ingress-timeout-server",
        "server",
        DirectRouteTable::new([DirectRoute {
            target_runtime_id: healthy_runtime_id.clone(),
            url: format!("ws://{}/ws", healthy.local_address()),
        }])
        .expect("healthy direct route"),
    );
    config.io_timeout = Duration::from_millis(50);
    let mut publisher = DirectOutboxPublisher::new(config).expect("publisher");
    publisher.attach_inbound_sessions(table);
    let first_report = publisher
        .publish_durable(&mut store, &first)
        .expect("target failure is reported without blocking healthy target");
    assert_eq!(
        (first_report.rows_published, first_report.rows_pending),
        (1, 1)
    );
    assert!(first_report.failed_targets.is_empty());
    let first_received = healthy
        .recv_timeout(Duration::from_secs(1))
        .expect("healthy ingress")
        .expect("healthy target receives first frame");
    assert_eq!(first_received.source_runtime_height, 1);

    let second_report = publisher
        .publish_durable(&mut store, &second)
        .expect("next durable frame stages while dead target remains pending");
    assert_eq!(
        (second_report.rows_published, second_report.rows_pending),
        (1, 1)
    );
    assert!(second_report.failed_targets.is_empty());
    let second_received = healthy
        .recv_timeout(Duration::from_secs(1))
        .expect("healthy ingress")
        .expect("healthy target receives second frame");
    assert_eq!(second_received.source_runtime_height, 2);
    publisher.close();
    healthy.shutdown().expect("healthy shutdown");
    drop(store);
    fs::remove_dir_all(base).expect("remove timeout fixture");
}

fn wait_for_open_session(ingress: &DirectRuntimeIngress, runtime_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if ingress.has_open_session(runtime_id).expect("session table") {
            return;
        }
        std::thread::yield_now();
    }
    panic!("authenticated inbound session was not retained");
}

fn user_to_hub_envelope(hub_runtime_id: &str, user_runtime_id: &str) -> OutboundEnvelope {
    OutboundEnvelope {
        target_runtime_id: hub_runtime_id.into(),
        source_height: 1,
        source_timestamp: 123,
        entity_id: Some(format!("0x{}", "11".repeat(32))),
        transaction_count: 0,
        value: json!({
            "sourceRuntimeId": user_runtime_id,
            "sourceRuntimeHeight": 1,
            "sourceRuntimeTimestamp": 123,
            "entityInputs": [{
                "runtimeId": hub_runtime_id,
                "entityId": format!("0x{}", "11".repeat(32)),
                "signerId": "1",
                "entityTxs": [],
            }],
        }),
        row_count: 1,
        durable_bytes: 1,
    }
}

#[test]
fn canonical_typescript_client_reaches_rust_ingress() {
    let server_seed = "rrs-ingress-typescript-server";
    let server_signer = "server";
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        server_seed,
        server_signer,
    ))
    .expect("bind ingress");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repository root");
    let output = Command::new("bun")
        .args(["-e", TYPESCRIPT_CLIENT])
        .current_dir(root)
        .env("RRS_TARGET_RUNTIME_ID", ingress.runtime_id())
        .env(
            "RRS_TARGET_URL",
            format!("ws://{}/ws", ingress.local_address()),
        )
        .env("RRS_TARGET_SEED", server_seed)
        .output()
        .expect("run TypeScript client");
    assert!(
        output.status.success(),
        "typescript client failed:stdout={}:stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let received = ingress
        .recv_timeout(Duration::from_secs(3))
        .expect("ingress healthy")
        .expect("TypeScript batch");
    assert_eq!(
        (
            received.source_runtime_height,
            received.source_runtime_timestamp
        ),
        (7, 9)
    );
    assert_eq!(
        (received.entity_inputs.len(), received.entity_tx_count),
        (1, 0)
    );
    ingress.shutdown().expect("clean shutdown");
}

#[test]
fn canonical_typescript_client_receives_rust_outbox_on_the_same_authenticated_socket() {
    let server_seed = "rrs-ingress-typescript-reply-server";
    let server_signer = "server";
    let client_seed = "rrs-ingress-typescript-reply-client";
    let client_signer = "1";
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        server_seed,
        server_signer,
    ))
    .expect("bind ingress");
    let hub_runtime_id = ingress.runtime_id().to_owned();
    let client_runtime_id = derive_local_runtime_id(client_seed, client_signer).expect("client id");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repository root");
    let child = Command::new("bun")
        .args(["-e", TYPESCRIPT_CLIENT_SAME_SOCKET_REPLY])
        .current_dir(root)
        .env("RRS_TARGET_RUNTIME_ID", &hub_runtime_id)
        .env(
            "RRS_TARGET_URL",
            format!("ws://{}/ws", ingress.local_address()),
        )
        .env("RRS_TARGET_SEED", server_seed)
        .env("RRS_CLIENT_SEED", client_seed)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn TypeScript client");
    wait_for_open_session(&ingress, &client_runtime_id);
    let received = ingress
        .recv_timeout(Duration::from_secs(3))
        .expect("ingress healthy")
        .expect("TypeScript inbound batch");
    assert_eq!(received.peer_runtime_id, client_runtime_id);
    assert_eq!(
        (
            received.source_runtime_height,
            received.source_runtime_timestamp
        ),
        (7, 9)
    );
    assert_eq!(
        (received.entity_inputs.len(), received.entity_tx_count),
        (1, 0)
    );

    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "xln-rscore-native-ts-reply-{}-{serial}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let durable = store
        .append_frame(frame(1, vec![output_row(&client_runtime_id, 1)]))
        .expect("durable reply frame");
    let mut publisher = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        server_seed,
        server_signer,
        DirectRouteTable::new([]).expect("empty direct routes forbid a second dial"),
    ))
    .expect("publisher");
    publisher.attach_inbound_sessions(ingress.sessions());
    let report = publisher
        .publish_durable(&mut store, &durable)
        .expect("reply on retained ingress session");
    assert_eq!((report.rows_published, report.rows_pending), (0, 1));

    let output = child.wait_with_output().expect("typescript client exit");
    assert!(
        output.status.success(),
        "typescript client failed:stdout={}:stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).expect("reply json");
    assert_eq!(reply["sourceRuntimeId"], hub_runtime_id);
    assert_eq!(reply["sourceRuntimeHeight"], json!(1));
    assert_eq!(reply["sourceRuntimeTimestamp"], json!(123));
    assert_eq!(reply["entityId"], format!("0x{}", "11".repeat(32)));
    assert_eq!(reply["signerId"], "1");
    assert_eq!(reply["entityTxs"], json!([]));
    assert_eq!(reply["sessionAuthenticated"], true);
    let completion = publisher
        .retry_pending()
        .expect("collect TypeScript socket write");
    assert_eq!((completion.rows_published, completion.rows_pending), (1, 0));

    publisher.close();
    ingress.shutdown().expect("clean shutdown");
    drop(store);
    fs::remove_dir_all(base).expect("remove fixture");
}

const TYPESCRIPT_CLIENT: &str = r#"
import { deriveSignerAddressSync } from './core/account/crypto.ts';
import { RuntimeWsClient } from './core/network/p2p/ws-client.ts';
import { directRuntimeWsAudience } from './core/network/p2p/ws-protocol.ts';
import { deriveEncryptionKeyPair } from './core/protocol/crypto/p2p-crypto.ts';

const target = process.env.RRS_TARGET_RUNTIME_ID;
const url = process.env.RRS_TARGET_URL;
const targetSeed = process.env.RRS_TARGET_SEED;
if (!target || !url || !targetSeed) throw new Error('RRS_TEST_ENV');
const seed = 'rrs-ingress-typescript-client';
const signerId = '1';
const runtimeId = deriveSignerAddressSync(seed, signerId).toLowerCase();
const client = new RuntimeWsClient({
  url,
  runtimeId,
  signerId,
  seed,
  helloAudience: directRuntimeWsAudience(target),
  encryptionKeyPair: deriveEncryptionKeyPair(seed),
  getTargetEncryptionKey: () => deriveEncryptionKeyPair(targetSeed).publicKey,
  onError: error => { throw error; },
});
await client.connect();
const deadline = Date.now() + 3_000;
while (!client.isOpen() && Date.now() < deadline) await Bun.sleep(5);
if (!client.isOpen()) throw new Error('RRS_TEST_HANDSHAKE_TIMEOUT');
const sent = client.sendEntityInputsRaw(target, {
  sourceRuntimeId: runtimeId,
  sourceRuntimeHeight: 7,
  sourceRuntimeTimestamp: 9,
  entityInputs: [{
    runtimeId: target,
    entityId: `0x${'11'.repeat(32)}`,
    signerId: '1',
    entityTxs: [],
  }],
}, 11);
if (!sent) throw new Error('RRS_TEST_SEND_FAILED');
await Bun.sleep(25);
await client.closeAndWait(1_000);
console.log('RRS_TS_TO_RUST_OK');
"#;

const TYPESCRIPT_CLIENT_SAME_SOCKET_REPLY: &str = r#"
import { deriveSignerAddressSync } from './core/account/crypto.ts';
import { RuntimeWsClient } from './core/network/p2p/ws-client.ts';
import { directRuntimeWsAudience } from './core/network/p2p/ws-protocol.ts';
import { deriveEncryptionKeyPair } from './core/protocol/crypto/p2p-crypto.ts';

const target = process.env.RRS_TARGET_RUNTIME_ID;
const url = process.env.RRS_TARGET_URL;
const targetSeed = process.env.RRS_TARGET_SEED;
const seed = process.env.RRS_CLIENT_SEED;
if (!target || !url || !targetSeed || !seed) throw new Error('RRS_TEST_ENV');
const signerId = '1';
const runtimeId = deriveSignerAddressSync(seed, signerId).toLowerCase();
const entityId = `0x${'11'.repeat(32)}`;
let settle;
const reply = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('RRS_TEST_REPLY_TIMEOUT')), 3_000);
  settle = payload => { clearTimeout(timer); resolve(payload); };
});
const client = new RuntimeWsClient({
  url,
  runtimeId,
  signerId,
  seed,
  helloAudience: directRuntimeWsAudience(target),
  encryptionKeyPair: deriveEncryptionKeyPair(seed),
  getTargetEncryptionKey: () => deriveEncryptionKeyPair(targetSeed).publicKey,
  onError: error => { throw error; },
  onEntityInputs: (from, envelope, _timestamp, sessionAuthenticated) => {
    settle({ from, envelope, sessionAuthenticated });
  },
});
await client.connect();
const deadline = Date.now() + 3_000;
while (!client.isOpen() && Date.now() < deadline) await Bun.sleep(5);
if (!client.isOpen()) throw new Error('RRS_TEST_HANDSHAKE_TIMEOUT');
const sent = client.sendEntityInputsRaw(target, {
  sourceRuntimeId: runtimeId,
  sourceRuntimeHeight: 7,
  sourceRuntimeTimestamp: 9,
  entityInputs: [{
    runtimeId: target,
    entityId,
    signerId: '1',
    entityTxs: [],
  }],
}, 11);
if (!sent) throw new Error('RRS_TEST_SEND_FAILED');
if (!client.isOpen()) throw new Error('RRS_TEST_SOCKET_CLOSED_AFTER_SEND');
const got = await reply;
if (got.from !== target) throw new Error(`RRS_TEST_FROM:${got.from}`);
if (got.envelope.sourceRuntimeId !== target) throw new Error('RRS_TEST_SOURCE_RUNTIME');
if (got.envelope.sourceRuntimeHeight !== 1 || got.envelope.sourceRuntimeTimestamp !== 123) {
  throw new Error('RRS_TEST_SOURCE_FRAME');
}
const input = got.envelope.entityInputs[0];
if (!input || input.entityId !== entityId || input.signerId !== '1' || input.entityTxs.length !== 0) {
  throw new Error('RRS_TEST_ENTITY_INPUT');
}
if (got.sessionAuthenticated !== true) throw new Error('RRS_TEST_SESSION_AUTH');
await client.closeAndWait(1_000);
process.stdout.write(JSON.stringify({
  sourceRuntimeId: got.envelope.sourceRuntimeId,
  sourceRuntimeHeight: got.envelope.sourceRuntimeHeight,
  sourceRuntimeTimestamp: got.envelope.sourceRuntimeTimestamp,
  entityId: input.entityId,
  signerId: input.signerId,
  entityTxs: input.entityTxs,
  sessionAuthenticated: got.sessionAuthenticated,
}));
"#;

fn output_row(target: &str, source_height: u64) -> Vec<u8> {
    crate::encode_storage_payload(&object(vec![
        ("runtimeId", CanonicalValue::String(target.into())),
        (
            "entityId",
            CanonicalValue::String(format!("0x{}", "11".repeat(32))),
        ),
        ("signerId", CanonicalValue::String("1".into())),
        ("entityTxs", CanonicalValue::Array(vec![])),
        (
            "sourceRuntimeFrame",
            object(vec![
                ("height", number(source_height)),
                ("timestamp", number(123)),
            ]),
        ),
    ]))
    .expect("canonical outbox row")
}

fn frame(height: u64, outputs: Vec<Vec<u8>>) -> RuntimeFrameCommit {
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: 123,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        crate::storage::native::EntityContextPayloadRows::empty(),
        outputs,
        None,
    )
    .expect("canonical frame")
    .commit
}

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture number"))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
