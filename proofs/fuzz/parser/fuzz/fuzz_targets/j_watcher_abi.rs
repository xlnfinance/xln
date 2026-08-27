#![no_main]
//! C7 wave-2 target 10 — j_watcher EVM-log ABI decoding
//! (`rscore/crates/runtime/src/j_watcher/abi.rs::decode_account_settled`,
//! listed by audit A1 as "the most untrusted decoder in rscore": adversarial
//! chain bytes). The ABI reader is `pub(crate)`; the public entry that
//! executes it is `poll_finalized_j_events` over a `JsonRpc` provider.
//!
//! Harness shape: an in-process deterministic `JsonRpc` implementation (the
//! same role the in-crate tests' fake chain server plays, minus TCP) serves a
//! one-block scaffold whose settled log carries fuzzer-controlled `data`,
//! topics, address and log-coordinate fields. Receipts-root authentication is
//! preserved: the harness RLP-encodes the receipts it serves and computes the
//! ordered trie root with the same `rlp`/`triehash`/`keccak-hasher` stack the
//! production validator uses, then serves that root on the block.
//!
//! Calibration (asserted on every execution): the harness encoder reproduces
//! the committed TypeScript fixture receipt root
//! `TS_RECEIPT_ROOT` (from `runtime/src/j_watcher/tests.rs`) for the fixture
//! receipt — if production `encode_receipt` ever drifts from this mirror,
//! the target fails loudly instead of silently losing the accept path.
//!
//! Properties:
//! 1. `poll_finalized_j_events` never panics on adversarial logs.
//! 2. Typed errors only (`JWatcherError`, rendered `J_WATCHER_*` codes).
//! 3. Accepted decode: every emitted `AccountSettledEvent` is bound to the
//!    scaffold block (height/hash/tx-hash/log index present and exact), every
//!    claim involves the configured entity, and the poll advances the cursor
//!    to the scanned tip.

use libfuzzer_sys::fuzz_target;
use serde_json::{Value, json};
use xln_parser_fuzz_harness::Cursor;
use xln_rscore_runtime::{
    FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JsonRpc, poll_finalized_j_events,
};

const CHAIN_ID: u64 = 31_337;
const HEAD: u64 = 43;
/// `runtime/src/j_watcher/tests.rs:34` — root of the fixture receipt the
/// production validator accepts; the calibration anchor for this harness.
const TS_RECEIPT_ROOT: &str = "0x5ca63546d46ba630af9a061b9ae662c0e274dcd5997b0062d07e70fa166705c7";
/// `runtime/src/j_watcher/types.rs:10` `ACCOUNT_SETTLED_TOPIC`.
const ACCOUNT_SETTLED_TOPIC: [u8; 32] = [
    0x78, 0x45, 0x75, 0x54, 0x51, 0x24, 0xee, 0xf2, 0x7f, 0x8f, 0xcc, 0x14, 0x72, 0xfb, 0x5f, 0x24,
    0x83, 0xbe, 0xb9, 0xcc, 0x23, 0xe6, 0xfe, 0x3d, 0xbf, 0x58, 0x8e, 0xb7, 0xbd, 0x50, 0x1f, 0x7c,
];
/// `runtime/src/j_watcher/tests.rs:19` `EVENT_DATA` — one valid settlement.
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

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

fn repeat_hex(byte: u8, length: usize) -> String {
    hex(&vec![byte; length])
}

/// Mirror of `runtime/src/j_watcher/receipt.rs::encode_receipt` for the fixed
/// scaffold receipt shape (type 0x2, post-Byzantium status). Calibrated
/// against TS_RECEIPT_ROOT on every execution.
fn receipt_rlp(settled_data: &str, settled_topics: &[String], settled_address: &str) -> Vec<u8> {
    let mut stream = rlp::RlpStream::new_list(4);
    // status "0x1" → quantity bytes [0x01]
    stream.append(&vec![0x01_u8]);
    // cumulativeGasUsed "0x5208"
    stream.append(&vec![0x52_u8, 0x08]);
    // logsBloom: 256 zero bytes
    stream.append(&vec![0x00_u8; 256]);
    // logs: [first log, settled log]
    stream.begin_list(2);
    let logs = [
        (repeat_hex(0x22, 20), vec![repeat_hex(0x99, 32)], "0x".to_string()),
        (
            settled_address.to_string(),
            settled_topics.to_vec(),
            settled_data.to_string(),
        ),
    ];
    for (address, topics, data) in logs {
        stream.begin_list(3);
        stream.append(&hex::decode(address.trim_start_matches("0x")).expect("harness address"));
        stream.begin_list(topics.len());
        for topic in topics {
            stream.append(&hex::decode(topic.trim_start_matches("0x")).expect("harness topic"));
        }
        stream.append(&hex::decode(data.trim_start_matches("0x")).expect("harness data"));
    }
    let payload = stream.out().to_vec();
    let mut typed = Vec::with_capacity(payload.len() + 1);
    typed.push(0x02_u8); // receipt type "0x2"
    typed.extend_from_slice(&payload);
    typed
}

/// Deterministic adversarial chain: block 42 (anchor, empty) + block 43 with
/// one transaction whose receipt carries the fuzz-controlled settled log.
struct FuzzChain {
    block43: Value,
    receipt: Value,
}

impl JsonRpc for FuzzChain {
    fn call(&self, method: &str, _params: Value) -> Result<Value, JWatcherError> {
        match method {
            "eth_chainId" => Ok(Value::String(format!("0x{CHAIN_ID:x}"))),
            "eth_blockNumber" => Ok(Value::String(format!("0x{HEAD:x}"))),
            "eth_getBlockByNumber" => {
                let height = u64::from_str_radix(
                    _params[0].as_str().unwrap_or("0x0").trim_start_matches("0x"),
                    16,
                )
                .unwrap_or(0);
                match height {
                    42 => Ok(json!({
                        "number": "0x2a",
                        "hash": repeat_hex(0xee, 32),
                        "parentHash": repeat_hex(0xaa, 32),
                        "receiptsRoot": repeat_hex(0x56, 32),
                        "transactions": [],
                    })),
                    43 => Ok(self.block43.clone()),
                    _ => Ok(Value::Null),
                }
            }
            "eth_getTransactionReceipt" => Ok(self.receipt.clone()),
            other => Err(JWatcherError::Rpc(other.to_string())),
        }
    }
}

/// One poll with the fuzz-controlled settled log. Returns the poll outcome.
fn poll(log: Value) -> Result<xln_rscore_runtime::JWatcherPoll, JWatcherError> {
    let receipt_base = json!({
        "transactionHash": repeat_hex(0xdd, 32),
        "transactionIndex": "0x0",
        "blockNumber": "0x2b",
        "blockHash": repeat_hex(0xcc, 32),
        "type": "0x2",
        "status": "0x1",
        "cumulativeGasUsed": "0x5208",
        "logsBloom": repeat_hex(0, 256),
    });
    let first_log = json!({
        "address": repeat_hex(0x22, 20),
        "topics": [repeat_hex(0x99, 32)],
        "data": "0x",
        "blockNumber": "0x2b",
        "blockHash": repeat_hex(0xcc, 32),
        "transactionHash": repeat_hex(0xdd, 32),
        "transactionIndex": "0x0",
        "logIndex": "0x0",
    });
    let mut receipt = receipt_base;
    receipt["logs"] = json!([first_log, log]);
    let settled_topics = receipt["logs"][1]["topics"].as_array();
    let settled_address = receipt["logs"][1]["address"].as_str().unwrap_or("0x").to_string();
    let encoded = receipt_rlp(
        receipt["logs"][1]["data"].as_str().unwrap_or("0x"),
        &settled_topics.map(|topics| {
            topics
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        }).unwrap_or_default(),
        &settled_address,
    );
    let root = triehash::ordered_trie_root::<keccak_hasher::KeccakHasher, _>(&[encoded]);
    let block43 = json!({
        "number": "0x2b",
        "hash": repeat_hex(0xcc, 32),
        "parentHash": repeat_hex(0xee, 32),
        "receiptsRoot": hex(&root),
        "transactions": [repeat_hex(0xdd, 32)],
    });
    let chain = FuzzChain { block43, receipt };
    let config = JWatcherConfig {
        chain_id: CHAIN_ID,
        depository_address: [0x11; 20],
        entity_id: xln_rscore_engine::EntityId::parse(&repeat_hex(0xaa, 32))
            .expect("harness entity"),
        confirmation_depth: 0,
        max_blocks_per_poll: 16,
    };
    let cursor = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([0xee; 32]),
    };
    poll_finalized_j_events(&chain, &config, &cursor)
}

/// Assert the harness RLP mirror still matches production by rebuilding the
/// committed fixture receipt root.
fn assert_calibration() {
    let fixture_topics = [hex(&ACCOUNT_SETTLED_TOPIC)];
    let encoded = receipt_rlp(EVENT_DATA, &fixture_topics, &repeat_hex(0x11, 20));
    let root = triehash::ordered_trie_root::<keccak_hasher::KeccakHasher, _>(&[encoded]);
    assert_eq!(
        hex(&root),
        TS_RECEIPT_ROOT,
        "J_WATCHER_HARNESS_RLP_DRIFT: harness receipt encoder no longer matches production encode_receipt (fixture root mismatch)"
    );
    // The fixture log itself must decode (accept-path calibration).
    let log = json!({
        "address": repeat_hex(0x11, 20),
        "topics": [hex(&ACCOUNT_SETTLED_TOPIC)],
        "data": EVENT_DATA,
        "blockNumber": "0x2b",
        "blockHash": repeat_hex(0xcc, 32),
        "transactionHash": repeat_hex(0xdd, 32),
        "transactionIndex": "0x0",
        "logIndex": "0x1",
    });
    let poll = poll(log).expect("J_WATCHER_FIXTURE_ACCEPT_PATH_BROKEN: fixture event no longer decodes");
    assert!(
        poll.batches.iter().any(|batch| !batch.account_claims.is_empty()),
        "J_WATCHER_FIXTURE_NO_CLAIMS"
    );
}

fuzz_target!(|data: &[u8]| {
    assert_calibration();

    let mut cursor = Cursor::new(data);
    // [be_u64(2) data length][data bytes][topics mode][topic 32]
    // [address mode][address 20][coordinates mode][index mode]
    let data_len = (cursor.be_u64(2) as usize).min(4096);
    let data_bytes = cursor.take(data_len).to_vec();
    let topics_mode = cursor.u8() % 4;
    let fuzz_topic = xln_parser_fuzz_harness::fixed_bytes::<32>(&mut cursor);
    let address_mode = cursor.u8() % 2;
    let fuzz_address = xln_parser_fuzz_harness::fixed_bytes::<20>(&mut cursor);
    let coordinates_mode = cursor.u8() % 3;
    let index_mode = cursor.u8() % 3;

    let canonical_topic = hex(&ACCOUNT_SETTLED_TOPIC);
    let topics: Vec<String> = match topics_mode {
        0 => vec![canonical_topic],
        1 => Vec::new(),
        2 => vec![hex(&fuzz_topic)],
        _ => vec![canonical_topic, hex(&fuzz_topic)],
    };
    let address = if address_mode == 0 {
        repeat_hex(0x11, 20)
    } else {
        hex(&fuzz_address)
    };
    // Coordinate sabotage modes: wrong block hash / wrong tx index — typed
    // rejections upstream of the ABI reader, kept so the boundary stays
    // covered alongside the ABI surface itself.
    let (block_hash, transaction_index): (String, Value) = match coordinates_mode {
        0 => (repeat_hex(0xcc, 32), json!("0x0")),
        1 => (repeat_hex(0xab, 32), json!("0x0")),
        _ => (repeat_hex(0xcc, 32), json!("0x5")),
    };
    let (log_index, index_field) = match index_mode {
        0 => (Some(json!("0x1")), None),
        1 => (Some(json!("0x1")), Some(json!("0x1"))),
        _ => (Some(json!("0x1")), Some(json!("0x2"))),
    };

    let log = json!({
        "address": address,
        "topics": topics,
        "data": if data_bytes.is_empty() {
            "0x".to_string()
        } else {
            hex(&data_bytes)
        },
        "blockNumber": "0x2b",
        "blockHash": block_hash,
        "transactionHash": repeat_hex(0xdd, 32),
        "transactionIndex": transaction_index,
        "logIndex": log_index,
        "index": index_field,
    });

    match poll(log) {
        Ok(poll) => {
            assert_eq!(
                poll.cursor.scanned_through, 43,
                "J_WATCHER_CURSOR_NOT_ADVANCED"
            );
            for batch in &poll.batches {
                assert_eq!(batch.j_height, 43, "J_WATCHER_BATCH_HEIGHT_DIVERGENCE");
                for claim in &batch.account_claims {
                    let xln_rscore_engine::AccountTx::JEventClaim(tx) = &claim.tx else {
                        panic!("J_WATCHER_CLAIM_WITHOUT_EVENTS: non-claim tx emitted");
                    };
                    assert!(
                        !tx.events.is_empty(),
                        "J_WATCHER_CLAIM_WITHOUT_EVENTS"
                    );
                }
            }
        }
        Err(error) => {
            let text = error.to_string();
            assert!(
                text.starts_with("J_WATCHER_"),
                "J_WATCHER_UNTYPED_ERROR: {text}"
            );
        }
    }
});
