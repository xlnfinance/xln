use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use xln_rscore_abi::{AbiValue, BodyTuple, encode_value};
use xln_rscore_engine::{AccountTx, EntityId, JurisdictionEvent};

use super::types::ACCOUNT_SETTLED_TOPIC;
use super::*;

const EVENT_DATA: &str = concat!(
    "0x0000000000000000000000000000000000000000000000000000000000000020",
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000020",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000001d1a93addc0",
    "00000000000000000000000000000000000000000000000000000000000f4240",
    "0000000000000000000000000000000000000000000000000000000000000000",
);
const TS_RECEIPT_ROOT: &str = "0x5ca63546d46ba630af9a061b9ae662c0e274dcd5997b0062d07e70fa166705c7";
#[derive(Deserialize)]
struct WireVector {
    name: String,
    bytes: String,
}

struct FakeRpcServer {
    endpoint: String,
    state: Arc<Mutex<FakeChain>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct FakeChain {
    chain_id: u64,
    head: u64,
    blocks: BTreeMap<u64, Value>,
    receipts: BTreeMap<String, Value>,
}

impl FakeRpcServer {
    fn start(chain: FakeChain) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake rpc");
        listener
            .set_nonblocking(true)
            .expect("nonblocking fake rpc");
        let address = listener.local_addr().expect("fake rpc address");
        let state = Arc::new(Mutex::new(chain));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_state = Arc::clone(&state);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || serve(listener, worker_state, worker_stop));
        Self {
            endpoint: format!("http://{address}"),
            state,
            stop,
            thread: Some(worker),
        }
    }

    fn mutate(&self, update: impl FnOnce(&mut FakeChain)) {
        update(&mut self.state.lock().expect("fake chain lock"));
    }
}

impl Drop for FakeRpcServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.endpoint.trim_start_matches("http://"));
        if let Some(worker) = self.thread.take() {
            worker.join().expect("fake rpc join");
        }
    }
}

fn serve(listener: TcpListener, state: Arc<Mutex<FakeChain>>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_connection(stream, &state);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("fake rpc accept: {error}"),
        }
    }
}

fn handle_connection(mut stream: TcpStream, state: &Arc<Mutex<FakeChain>>) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let Some(request) = read_http_body(&mut stream)? else {
        return Ok(());
    };
    let payload: Value = serde_json::from_slice(&request).expect("fake rpc request json");
    let result = rpc_result(&state.lock().expect("fake chain lock"), &payload);
    let response = json!({"jsonrpc":"2.0","id":1,"result":result}).to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.len(),
        response,
    )?;
    Ok(())
}

fn read_http_body(stream: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).expect("fake headers");
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(str::trim)
                .map(str::to_string)
        })
        .expect("content length")
        .parse::<usize>()
        .expect("content length number");
    if headers
        .to_ascii_lowercase()
        .contains("expect: 100-continue")
        && bytes.len() - header_end < length
    {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
    }
    while bytes.len() - header_end < length {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(Some(bytes[header_end..header_end + length].to_vec()))
}

fn rpc_result(chain: &FakeChain, request: &Value) -> Value {
    match request["method"].as_str().expect("rpc method") {
        "eth_chainId" => Value::String(format!("0x{:x}", chain.chain_id)),
        "eth_blockNumber" => Value::String(format!("0x{:x}", chain.head)),
        "eth_getBlockByNumber" => {
            let height = u64::from_str_radix(
                request["params"][0]
                    .as_str()
                    .expect("block parameter")
                    .trim_start_matches("0x"),
                16,
            )
            .expect("block height");
            chain.blocks.get(&height).cloned().unwrap_or(Value::Null)
        }
        "eth_getTransactionReceipt" => chain
            .receipts
            .get(request["params"][0].as_str().expect("receipt hash"))
            .cloned()
            .unwrap_or(Value::Null),
        method => panic!("unexpected rpc method {method}"),
    }
}

fn fixture_chain() -> FakeChain {
    let parent = hex_repeat(0xee, 32);
    let block = hex_repeat(0xcc, 32);
    let transaction = hex_repeat(0xdd, 32);
    let depository = hex_repeat(0x11, 20);
    let base = json!({
        "blockNumber":"0x2b", "blockHash":block,
        "transactionHash":transaction, "transactionIndex":"0x0",
    });
    let mut first_log = base.clone();
    merge(
        &mut first_log,
        json!({
            "address":hex_repeat(0x22,20), "topics":[hex_repeat(0x99,32)],
            "data":"0x", "logIndex":"0x0",
        }),
    );
    let mut settled_log = base;
    merge(
        &mut settled_log,
        json!({
            "address":depository, "topics":[format!("0x{}", hex::encode(ACCOUNT_SETTLED_TOPIC))],
            "data":EVENT_DATA, "logIndex":"0x1",
        }),
    );
    let receipt = json!({
        "transactionHash":transaction, "transactionIndex":"0x0",
        "blockNumber":"0x2b", "blockHash":block, "type":"0x2", "status":"0x1",
        "cumulativeGasUsed":"0x5208", "logsBloom":hex_repeat(0,256),
        "logs":[first_log,settled_log],
    });
    FakeChain {
        chain_id: 31_337,
        head: 43,
        blocks: BTreeMap::from([
            (
                42,
                json!({
                    "number":"0x2a", "hash":parent, "parentHash":hex_repeat(0xaa,32),
                    "receiptsRoot":hex_repeat(0x56,32), "transactions":[],
                }),
            ),
            (
                43,
                json!({
                    "number":"0x2b", "hash":block, "parentHash":parent,
                    "receiptsRoot":TS_RECEIPT_ROOT, "transactions":[transaction],
                }),
            ),
        ]),
        receipts: BTreeMap::from([(transaction, receipt)]),
    }
}

fn merge(target: &mut Value, fields: Value) {
    target
        .as_object_mut()
        .expect("target object")
        .extend(fields.as_object().expect("fields object").clone());
}

fn hex_repeat(byte: u8, length: usize) -> String {
    format!("0x{}", hex::encode(vec![byte; length]))
}

fn config() -> JWatcherConfig {
    JWatcherConfig {
        chain_id: 31337,
        depository_address: [0x11; 20],
        entity_provider_address: [0x12; 20],
        entity_id: EntityId::parse(&hex_repeat(0xaa, 32)).expect("entity"),
        erc20_tokens: BTreeMap::new(),
        external_wallets: Vec::new(),
        hash_ladders: Default::default(),
        confirmation_depth: 0,
        max_blocks_per_poll: 16,
    }
}

fn cursor_42() -> FinalizedWatcherCursor {
    FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([0xee; 32]),
    }
}

#[test]
fn authenticated_http_range_matches_typescript_receipt_and_claim_goldens() {
    let server = FakeRpcServer::start(fixture_chain());
    let client = HttpJsonRpc::new(&server.endpoint).expect("http client");
    let result = poll_finalized_j_events(&client, &config(), &cursor_42()).expect("watcher poll");
    assert_eq!(result.cursor.scanned_through, 43);
    assert_eq!(result.cursor.block_hash, Some([0xcc; 32]));
    assert_eq!(result.batches.len(), 1);
    let batch = &result.batches[0];
    assert_eq!(batch.events.len(), 1);
    let JurisdictionEvent::AccountSettled(_) = &batch.events[0] else {
        panic!("expected AccountSettled");
    };
    assert!(batch.reserve_updates.is_empty());
    assert_eq!(batch.account_claims.len(), 1);
    assert_eq!(
        hex::encode(claim_wire(&batch.account_claims[0].tx)),
        typescript_claim_wire(),
    );
}

#[test]
fn committed_cursor_deduplicates_restart_and_detects_finalized_reorg() {
    let server = FakeRpcServer::start(fixture_chain());
    let client = HttpJsonRpc::new(&server.endpoint).expect("http client");
    let first = poll_finalized_j_events(&client, &config(), &cursor_42()).expect("first poll");
    let restored = first.cursor.clone();
    assert_eq!(restored, first.cursor);
    let restarted = poll_finalized_j_events(&client, &config(), &restored).expect("restart poll");
    assert!(restarted.batches.is_empty());
    assert_eq!(restarted.cursor, first.cursor);
    server.mutate(|chain| {
        chain.blocks.get_mut(&43).expect("tip")["hash"] = Value::String(hex_repeat(0xff, 32));
    });
    assert!(matches!(
        poll_finalized_j_events(&client, &config(), &first.cursor),
        Err(JWatcherError::FinalizedReorg(43)),
    ));
}

#[test]
fn hostile_receipt_root_rejects_only_the_poll_and_keeps_cursor_immutable() {
    let mut chain = fixture_chain();
    chain.blocks.get_mut(&43).expect("tip")["receiptsRoot"] = Value::String(hex_repeat(0x44, 32));
    let server = FakeRpcServer::start(chain);
    let client = HttpJsonRpc::new(&server.endpoint).expect("http client");
    let cursor = cursor_42();
    assert!(matches!(
        poll_finalized_j_events(&client, &config(), &cursor),
        Err(JWatcherError::ReceiptRootMismatch),
    ));
    assert_eq!(cursor, cursor_42());
}

#[test]
fn malformed_non_ascii_rpc_hex_is_rejected_without_panicking() {
    assert!(matches!(
        super::receipt::parse_hex("0xé", None, "hostileHex"),
        Err(JWatcherError::Hex("hostileHex")),
    ));
}

#[test]
fn endpoint_on_a_different_chain_is_rejected_before_any_range_is_consumed() {
    let mut chain = fixture_chain();
    chain.chain_id = 1;
    let server = FakeRpcServer::start(chain);
    let client = HttpJsonRpc::new(&server.endpoint).expect("http client");
    let cursor = cursor_42();
    assert!(matches!(
        poll_finalized_j_events(&client, &config(), &cursor),
        Err(JWatcherError::ChainIdMismatch {
            expected: 31_337,
            actual: 1,
        }),
    ));
    assert_eq!(cursor, cursor_42());
}

fn claim_wire(tx: &AccountTx) -> Vec<u8> {
    let AccountTx::JEventClaim(claim) = tx else {
        panic!("expected j event claim");
    };
    let events_hash = xln_rscore_engine::canonical_events_hash(&claim.events).expect("events hash");
    let events = claim.events.iter().map(event_wire).collect();
    encode_value(&AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Integer(9),
        AbiValue::Integer(claim.j_height.into()),
        AbiValue::Bytes(claim.j_block_hash.to_vec()),
        AbiValue::Bytes(events_hash.to_vec()),
        AbiValue::Tuple(BodyTuple::from_vec(events)),
        AbiValue::Nil,
        AbiValue::Nil,
    ])))
    .expect("claim wire")
}

fn event_wire(event: &JurisdictionEvent) -> AbiValue {
    let JurisdictionEvent::AccountSettled(event) = event else {
        panic!("fixture claim must contain AccountSettled");
    };
    let metadata = &event.metadata;
    AbiValue::Tuple(BodyTuple::from_vec(vec![
        AbiValue::Integer(0),
        AbiValue::Tuple(BodyTuple::from_vec(vec![
            optional_integer(metadata.block_number),
            optional_hash(metadata.block_hash),
            optional_hash(metadata.transaction_hash),
            optional_integer(metadata.log_index),
            optional_integer(metadata.event_index),
        ])),
        AbiValue::Bytes(event.left_entity.as_bytes().to_vec()),
        AbiValue::Bytes(event.right_entity.as_bytes().to_vec()),
        AbiValue::Integer(event.token_id.get().into()),
        AbiValue::Text(event.left_reserve.to_string()),
        AbiValue::Text(event.right_reserve.to_string()),
        AbiValue::Text(event.collateral.to_string()),
        AbiValue::Text(event.ondelta.to_string()),
        AbiValue::Integer(event.nonce.into()),
    ]))
}

fn optional_integer(value: Option<u64>) -> AbiValue {
    value.map_or(AbiValue::Nil, |value| AbiValue::Integer(value.into()))
}

fn optional_hash(value: Option<[u8; 32]>) -> AbiValue {
    value.map_or(AbiValue::Nil, |value| AbiValue::Bytes(value.to_vec()))
}

fn typescript_claim_wire() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../core/__tests__/rscore/tx-wire-vectors.json");
    let bytes =
        std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let vectors: Vec<WireVector> = serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("decode {}: {error}", path.display()));
    vectors
        .into_iter()
        .find(|vector| vector.name == "j_event_claim/minimal")
        .map(|vector| vector.bytes)
        .expect("TypeScript j_event_claim/minimal golden")
}
