use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::json;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

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
        .append_frame(frame(1, vec![output_row(&target)]))
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

fn output_row(target: &str) -> Vec<u8> {
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
            object(vec![("height", number(1)), ("timestamp", number(123))]),
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
