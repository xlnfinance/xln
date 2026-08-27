use std::fs;
use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::super::*;
use crate::storage::native::{
    CanonicalRuntimeFrameDraft, NativeRuntimeStore, NativeStorageConfig, ReplicaMetaStateMode,
    RuntimeFrameCommit, build_runtime_frame_commit,
};

static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

#[test]
fn websocket_and_replay_targets_reject_the_same_missing_route_and_bad_row() {
    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "xln-rscore-publisher-validation-{}-{serial}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let target = format!("0x{}", "77".repeat(20));
    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let missing_route = store
        .append_frame(frame(1, vec![output_row(&target, 1, "route")]))
        .expect("durable route fixture");
    let empty_routes = DirectRouteTable::new([]).expect("empty routes");
    let mut websocket = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        "rrs-validation-client",
        "client",
        empty_routes.clone(),
    ))
    .expect("websocket target");
    let mut replay = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        "rrs-validation-client",
        "client",
        empty_routes,
    ))
    .expect("replay target");
    assert!(matches!(
        websocket.publish_durable(&mut store, &missing_route),
        Err(RuntimeTransportError::Route(_))
    ));
    assert!(matches!(
        replay.validate_durable(&mut store, &missing_route),
        Err(RuntimeTransportError::Route(_))
    ));

    let routes = DirectRouteTable::new([DirectRoute {
        target_runtime_id: target.clone(),
        url: "ws://127.0.0.1:1/ws".into(),
    }])
    .expect("route");
    let malformed = crate::encode_storage_payload(&object(vec![
        ("runtimeId", CanonicalValue::String(target)),
        (
            "entityId",
            CanonicalValue::String(format!("0x{}", "11".repeat(32))),
        ),
        ("signerId", CanonicalValue::String("1".into())),
        ("entityTxs", CanonicalValue::Array(vec![])),
    ]))
    .expect("decodable but incomplete outbox row");
    let bad_row = store
        .append_frame(frame(2, vec![malformed]))
        .expect("durable malformed fixture");
    let mut websocket = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        "rrs-validation-client",
        "client",
        routes.clone(),
    ))
    .expect("websocket target");
    let mut replay = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        "rrs-validation-client",
        "client",
        routes,
    ))
    .expect("replay target");
    assert!(matches!(
        websocket.publish_durable(&mut store, &bad_row),
        Err(RuntimeTransportError::Outbox(_))
    ));
    assert!(matches!(
        replay.validate_durable(&mut store, &bad_row),
        Err(RuntimeTransportError::Outbox(_))
    ));
    drop(store);
    fs::remove_dir_all(base).expect("remove validation fixture");
}

#[test]
fn durable_sender_reconnects_without_loss_or_duplicate_and_bounds_backpressure() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repository root");
    let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!("xln-rscore-ws-{}-{serial}", std::process::id()));
    let received = base.join("received.log");
    fs::create_dir_all(&base).expect("isolated transport fixture");
    let mut server = start_typescript_server(&root, &received);
    let startup: Value =
        serde_json::from_str(&read_server_line(&mut server.child)).expect("server startup json");
    let target = startup["runtimeId"].as_str().expect("server runtime id");
    let port = startup["port"].as_u64().expect("server port");

    let mut store = NativeRuntimeStore::open(base.join("db"), NativeStorageConfig::default())
        .expect("native store");
    let first = store
        .append_frame(frame(1, vec![output_row(target, 1, "once")]))
        .expect("durable frame");
    let routes = DirectRouteTable::new([DirectRoute {
        target_runtime_id: target.into(),
        url: format!("ws://127.0.0.1:{port}/ws"),
    }])
    .expect("routes");
    let mut config =
        DirectOutboxPublisherConfig::production("rrs-transport-client", "client", routes.clone());
    config.io_timeout = Duration::from_secs(3);
    let mut publisher = DirectOutboxPublisher::new(config).expect("publisher");
    let report = publisher
        .publish_durable(&mut store, &first)
        .expect("publish after forced handshake reconnect");
    assert_eq!((report.rows_published, report.reconnects), (1, 1));
    wait_for_lines(&received, 1);
    assert_eq!(line_count(&received), 1);

    let duplicate = publisher
        .publish_durable(&mut store, &first)
        .expect("same durable token is idempotent");
    assert_eq!(duplicate.rows_published, 0);
    assert_eq!(line_count(&received), 1);

    let second = store
        .append_frame(frame(
            2,
            vec![
                output_row(target, 2, "bounded-a"),
                output_row(target, 2, "bounded-b"),
            ],
        ))
        .expect("second durable frame");
    let mut bounded_config =
        DirectOutboxPublisherConfig::production("rrs-transport-client", "client", routes);
    bounded_config.max_queue_rows = 1;
    bounded_config.max_envelope_rows = 1;
    let mut bounded = DirectOutboxPublisher::new(bounded_config).expect("bounded publisher");
    assert!(matches!(
        bounded.publish_durable(&mut store, &second),
        Err(RuntimeTransportError::Queue { rows: 2, .. }),
    ));
    assert_eq!(line_count(&received), 1);

    publisher.close();
    drop(store);
    let _ = fs::remove_dir_all(base);
}

fn output_row(target: &str, height: u64, message: &str) -> Vec<u8> {
    crate::encode_storage_payload(&object(vec![
        ("runtimeId", CanonicalValue::String(target.into())),
        (
            "entityId",
            CanonicalValue::String(format!("0x{}", "11".repeat(32))),
        ),
        ("signerId", CanonicalValue::String("1".into())),
        (
            "entityTxs",
            CanonicalValue::Array(vec![object(vec![
                ("type", CanonicalValue::String("chat".into())),
                (
                    "data",
                    object(vec![
                        ("from", CanonicalValue::String("1".into())),
                        ("message", CanonicalValue::String(message.into())),
                    ]),
                ),
            ])]),
        ),
        (
            "sourceRuntimeFrame",
            object(vec![("height", number(height)), ("timestamp", number(123))]),
        ),
    ]))
    .expect("canonical output row")
}

fn frame(height: u64, outputs: Vec<Vec<u8>>) -> RuntimeFrameCommit {
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: 123,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            replica_meta_state_mode: ReplicaMetaStateMode::LiveHead,
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            pending_runtime_input: None,
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

struct TestServer {
    child: Child,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_typescript_server(root: &std::path::Path, received: &std::path::Path) -> TestServer {
    let script = r#"
import { appendFileSync } from 'node:fs';
import { deriveSignerAddressSync } from './core/account/crypto.ts';
import { createDirectRuntimeWsRoute } from './core/network/p2p/direct-runtime-bun.ts';
import { directRuntimeWsAudience, serializeWsMessage } from './core/network/p2p/ws-protocol.ts';
const seed='rrs-transport-server';
const runtimeId=deriveSignerAddressSync(seed,'1').toLowerCase();
let sequence=0;
const route=createDirectRuntimeWsRoute({runtimeId,runtimeSeed:seed,path:'/ws',onEntityInputs(_from,envelope){appendFileSync(process.env.RRS_RECEIVED_PATH,JSON.stringify({height:envelope.sourceRuntimeHeight,count:envelope.entityInputs.length})+'\n');}});
let server;
server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,ref){if(ref.upgrade(request,{data:{sequence:++sequence}}))return;return new Response('websocket only',{status:400});},websocket:{maxPayloadLength:route.websocket.maxPayloadLength,open(ws){if(ws.data.sequence===1){ws.send(serializeWsMessage({type:'hello_challenge',challenge:'0xfirstdisconnect',audience:directRuntimeWsAudience(runtimeId)}));ws.close(1012,'retry');return;}route.websocket.open(ws);},message(ws,raw){route.websocket.message(ws,raw);},drain(ws){route.websocket.drain(ws);},close(ws,code,reason){route.websocket.close(ws,code,reason);}}});
console.log(JSON.stringify({port:server.port,runtimeId}));
process.on('SIGTERM',()=>{server.stop(true);process.exit(0)});
"#;
    let child = Command::new("bun")
        .args(["-e", script])
        .current_dir(root)
        .env("RRS_RECEIVED_PATH", received)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start canonical TypeScript websocket server");
    TestServer { child }
}

fn read_server_line(child: &mut Child) -> String {
    let stdout = child.stdout.as_mut().expect("server stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("server startup line");
    line
}

fn line_count(path: &std::path::Path) -> usize {
    fs::read_to_string(path)
        .expect("received rows")
        .lines()
        .count()
}

fn wait_for_lines(path: &std::path::Path, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if fs::read_to_string(path)
            .ok()
            .is_some_and(|value| value.lines().count() >= count)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("transport delivery timeout");
}
