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

// Current Depository ABI: ondelta is Int512(high, low). Receipt root below
// is independently encoded by the TS canonical receipt codec, not Rust.
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
    "0000000000000000000000000000000000000000000000000000000000000000",
);
const TS_RECEIPT_ROOT: &str = "0x54d4b8f966cf56e854e9d65b828f5ab55a1f401ac461d2090583b9599d74c695";

fn token_count_abi(count: ethabi::ethereum_types::U256) -> Value {
    Value::String(format!(
        "0x{}",
        hex::encode(ethabi::encode(&[ethabi::Token::Uint(count)]))
    ))
}

fn token_entry_abi(address: [u8; 20], token_type: u64) -> Vec<u8> {
    use ethabi::ethereum_types::{H160, U256};
    // Depository._tokens returns (address,uint256,uint8). An external id may
    // use all 256 bits; only the address and uint8 words require zero padding.
    ethabi::encode(&[
        ethabi::Token::Address(H160::from(address)),
        ethabi::Token::Uint(U256::MAX),
        ethabi::Token::Uint(U256::from(token_type)),
    ])
}

fn token_entry_value(bytes: &[u8]) -> Value {
    Value::String(format!("0x{}", hex::encode(bytes)))
}

#[test]
fn token_registry_count_accepts_exact_abi_word_through_js_safe_boundary() {
    use super::token_registry::decode_token_count;
    for count in [1_u64, 9_007_199_254_740_991] {
        assert_eq!(
            decode_token_count(&token_count_abi(count.into())).expect("canonical token count"),
            count
        );
    }
}

#[test]
fn token_registry_count_rejects_unsafe_and_noncanonical_abi_words() {
    use super::token_registry::decode_token_count;
    use ethabi::ethereum_types::U256;
    for value in [
        token_count_abi(U256::from(9_007_199_254_740_992_u64)),
        token_count_abi(U256::MAX),
        Value::String(hex_repeat(0, 31)),
        Value::String(hex_repeat(0, 33)),
        Value::String("0x1".into()),
        Value::String(format!("0x{}gg", "00".repeat(31))),
        Value::Null,
    ] {
        assert!(decode_token_count(&value).is_err(), "accepted {value}");
    }
}

#[test]
fn token_registry_erc20_abi_retains_address_with_full_width_external_id() {
    use super::token_registry::decode_erc20_token;
    let address = [0x7b; 20];
    let bytes = token_entry_abi(address, 0);
    assert_eq!(bytes.len(), 96);
    assert_eq!(
        decode_erc20_token(&token_entry_value(&bytes)).expect("canonical ERC20 tuple"),
        Some(address)
    );
}

#[test]
fn token_registry_nft_and_zero_address_entries_are_not_erc20_filters() {
    use super::token_registry::decode_erc20_token;
    for (address, token_type) in [([0x7b; 20], 1), ([0x7b; 20], 2), ([0; 20], 0)] {
        assert_eq!(
            decode_erc20_token(&token_entry_value(&token_entry_abi(address, token_type)))
                .expect("canonical non-ERC20 entry"),
            None
        );
    }
}

#[test]
fn token_registry_entry_rejects_dirty_address_padding_and_wide_token_type() {
    use super::token_registry::decode_erc20_token;
    let mut dirty_address = token_entry_abi([0x7b; 20], 0);
    dirty_address[0] = 1;
    for bytes in [dirty_address, token_entry_abi([0x7b; 20], 256)] {
        assert!(
            decode_erc20_token(&token_entry_value(&bytes)).is_err(),
            "noncanonical address/uint8 word was accepted"
        );
    }
}

#[test]
fn token_registry_entry_rejects_truncated_trailing_and_malformed_abi() {
    use super::token_registry::decode_erc20_token;
    let bytes = token_entry_abi([0x7b; 20], 0);
    let mut trailing = bytes.clone();
    trailing.push(0);
    for value in [
        token_entry_value(&bytes[..95]),
        token_entry_value(&trailing),
        Value::String(format!("0x{}gg", "00".repeat(95))),
        Value::String("0x".into()),
        Value::Null,
    ] {
        assert!(decode_erc20_token(&value).is_err(), "accepted {value}");
    }
}

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
    token_registry: Vec<Value>,
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
        "eth_call" => {
            assert_eq!(request["params"][0]["to"], hex_repeat(0x11, 20));
            assert_eq!(request["params"][1], "latest");
            let data = request["params"][0]["data"].as_str().expect("call data");
            let count_selector = hex::encode(ethabi::short_signature("getTokensLength", &[]));
            if data == format!("0x{count_selector}") {
                return token_count_abi(chain.token_registry.len().into());
            }
            let row_selector = hex::encode(ethabi::short_signature(
                "_tokens",
                &[ethabi::ParamType::Uint(256)],
            ));
            let (index, _) = chain
                .token_registry
                .iter()
                .enumerate()
                .skip(1)
                .find(|(index, _)| data == format!("0x{row_selector}{index:064x}"))
                .expect("exact _tokens(uint256) selector and existing nonzero token id");
            chain.token_registry[index].clone()
        }
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
        token_registry: vec![
            token_entry_value(&token_entry_abi([0; 20], 0)),
            token_entry_value(&token_entry_abi([0x22; 20], 0)),
        ],
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
fn malformed_live_registry_row_rejects_before_receipts_and_keeps_cursor_immutable() {
    let mut chain = fixture_chain();
    chain.token_registry[1] = Value::String("0x".into());
    let server = FakeRpcServer::start(chain);
    let client = HttpJsonRpc::new(&server.endpoint).expect("http client");
    let cursor = cursor_42();
    assert!(matches!(
        poll_finalized_j_events(&client, &config(), &cursor),
        Err(JWatcherError::Hex("tokenRegistryRow")),
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
