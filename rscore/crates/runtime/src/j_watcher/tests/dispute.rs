//! Dispute calldata ingress: a dispute no served Entity receives never needs
//! calldata, and a served dispute submitted through a wrapper contract still
//! resolves the exact ProofBody its event commits to.
use std::cell::RefCell;
use std::collections::BTreeMap;

use ethabi::Token;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use xln_rscore_engine::JurisdictionEvent;
use xln_rscore_entity_kernel::JBatch;
use xln_rscore_entity_kernel::j_batch::{InitialDisputeProof, ProofBody};

use super::super::abi::{DISPUTE_STARTED_TOPIC, HANKO_BATCH_PROCESSED_TOPIC, hex};
use super::super::types::{JWatcherError, JsonRpc, RpcBlock, RpcReceipt};
use super::super::watcher::build_block_batch;
use super::{config, hex_repeat};

const LOCAL: [u8; 32] = [0xaa; 32];
const PEER: [u8; 32] = [0xbb; 32];
const FOREIGN: [u8; 32] = [0xcc; 32];
const BLOCK_HASH: [u8; 32] = [0xcc; 32];

/// In-process JSON-RPC: records every transaction lookup the watcher makes.
#[derive(Default)]
pub(super) struct DisputeRpc {
    pub transactions: BTreeMap<String, Value>,
    pub native: Option<BTreeMap<String, Value>>,
    pub reads: RefCell<Vec<String>>,
}

impl JsonRpc for DisputeRpc {
    fn tron_rpc_attested(&self) -> bool {
        self.native.is_some()
    }
    fn tron_solidity_call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        assert_eq!(method, "gettransactionbyid");
        let id = params["value"].as_str().expect("native txID").to_owned();
        self.reads.borrow_mut().push(format!("native:{id}"));
        let native = self.native.as_ref().expect("native transport");
        Ok(native.get(&id).cloned().unwrap_or_else(|| json!({})))
    }
    fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        assert_eq!(method, "eth_getTransactionByHash");
        let hash = params[0].as_str().expect("transaction hash").to_owned();
        self.reads.borrow_mut().push(hash.clone());
        Ok(self.transactions.get(&hash).cloned().unwrap_or(Value::Null))
    }
}

pub(super) fn body(seed: u8) -> ProofBody {
    ProofBody {
        watch_seed: [0x44; 32],
        left_response_seconds: 10,
        right_response_seconds: 10,
        offdeltas: vec![i64::from(seed).into()],
        token_ids: vec![1.into()],
        transformers: vec![],
    }
}

pub(super) fn body_hash(seed: u8) -> [u8; 32] {
    xln_rscore_entity_kernel::proof_body_hash(&body(seed)).expect("proof body hash")
}

/// processBatch calldata whose one dispute start claims `claimed_hash` for `body(seed)`.
pub(super) fn start_call(claimed_hash: [u8; 32], seed: u8, hanko_nonce: u64) -> Vec<u8> {
    let batch = JBatch {
        dispute_starts: vec![InitialDisputeProof {
            counterentity: LOCAL,
            nonce: 7.into(),
            proposer_is_left: true,
            proofbody_hash: claimed_hash,
            initial_proofbody: body(seed),
            watch_seed: [0x44; 32],
            sig: vec![1],
            starter_initial_arguments: vec![],
            starter_counter_arguments: vec![],
            starter_counter_proof_commitment: [0; 32],
        }],
        ..JBatch::default()
    };
    let encoded = xln_rscore_entity_kernel::encode_j_batch(&batch).expect("encode batch");
    let mut call = Keccak256::digest(b"processBatch(bytes,bytes,uint256)")[..4].to_vec();
    call.extend(ethabi::encode(&[
        Token::Bytes(encoded),
        Token::Bytes(vec![1, 2]),
        Token::Uint(hanko_nonce.into()),
    ]));
    call
}

fn selector(signature: &[u8]) -> Vec<u8> {
    Keccak256::digest(signature)[..4].to_vec()
}

/// Safe-style wrapper: the call is an ABI-encoded `bytes` argument.
fn safe_wrapper(inner: Vec<u8>) -> Vec<u8> {
    let mut call = selector(b"execTransaction(address,uint256,bytes)");
    call.extend(ethabi::encode(&[
        Token::Address([0x55; 20].into()),
        Token::Uint(0.into()),
        Token::Bytes(inner),
    ]));
    call
}

/// Gnosis MultiSend: packed (uint8,address,uint256,uint256,bytes) records.
fn multi_send(inner: &[Vec<u8>]) -> Vec<u8> {
    let mut packed = Vec::new();
    for call in inner {
        packed.push(0);
        packed.extend([0x55; 20]);
        packed.extend([0; 32]);
        packed.extend(ethabi::encode(&[Token::Uint(call.len().into())]));
        packed.extend(call);
    }
    let mut call = selector(b"multiSend(bytes)");
    call.extend(ethabi::encode(&[Token::Bytes(packed)]));
    call
}

fn quantity(bytes: &[u8]) -> String {
    let digits = hex::encode(bytes);
    let trimmed = digits.trim_start_matches('0');
    format!("0x{}", if trimmed.is_empty() { "0" } else { trimmed })
}

/// An EIP-1559 transaction signed by the canonical submitter, as RPC returns it.
fn signed_transaction(data: Vec<u8>) -> (String, Value) {
    let tx = crate::j_submit::Eip1559Transaction {
        chain_id: 31_337,
        nonce: 1,
        max_priority_fee_per_gas: 1.into(),
        max_fee_per_gas: 2.into(),
        gas_limit: 1_000_000.into(),
        to: [0x55; 20],
        value: 0.into(),
        data: data.clone(),
    };
    let signed = tx.sign(&[1; 32]).expect("sign transaction");
    let fields = rlp::Rlp::new(&signed.raw[1..]);
    let field = |index| {
        fields
            .at(index)
            .and_then(|item| item.data().map(<[u8]>::to_vec))
    };
    let hash = hex(&signed.hash);
    (
        hash.clone(),
        json!({
            "hash": hash, "type": "0x2", "chainId": "0x7a69", "nonce": "0x1",
            "maxPriorityFeePerGas": "0x1", "maxFeePerGas": "0x2", "gas": "0xf4240",
            "to": hex(&[0x55; 20]), "value": "0x0", "input": hex(&data), "accessList": [],
            "yParity": quantity(&field(9).expect("yParity")),
            "r": quantity(&field(10).expect("r")), "s": quantity(&field(11).expect("s")),
        }),
    )
}

fn log(transaction: &str, index: u64, topics: Vec<String>, data: Vec<u8>) -> Value {
    json!({
        "address": hex_repeat(0x11, 20), "topics": topics, "data": hex(&data),
        "blockNumber": "0x2b", "blockHash": hex(&BLOCK_HASH), "transactionHash": transaction,
        "transactionIndex": "0x0", "logIndex": format!("0x{index:x}"),
    })
}

fn word(value: u64) -> String {
    hex(&ethabi::encode(&[Token::Uint(value.into())]))
}

/// DisputeStarted(sender, counterentity, nonce=7, ...) committing to `proofbody_hash`.
pub(super) fn dispute_started_log(
    transaction: &str,
    index: u64,
    sender: [u8; 32],
    counterentity: [u8; 32],
    proofbody_hash: [u8; 32],
) -> Value {
    let data = ethabi::encode(&[
        Token::Bool(true),
        Token::FixedBytes(proofbody_hash.to_vec()),
        Token::FixedBytes(vec![0x44; 32]),
        Token::Bytes(vec![]),
        Token::Bytes(vec![]),
        Token::FixedBytes(vec![0; 32]),
        Token::Uint(120.into()),
        Token::Uint(100.into()),
        Token::Uint(10.into()),
        Token::Uint(10.into()),
    ]);
    let topics = vec![
        DISPUTE_STARTED_TOPIC.to_owned(),
        hex(&sender),
        hex(&counterentity),
        word(7),
    ];
    log(transaction, index, topics, data)
}

pub(super) fn hanko_batch_log(
    transaction: &str,
    index: u64,
    entity: [u8; 32],
    nonce: u64,
) -> Value {
    let topics = vec![
        HANKO_BATCH_PROCESSED_TOPIC.to_owned(),
        hex(&entity),
        hex(&[0x99; 32]),
    ];
    log(
        transaction,
        index,
        topics,
        ethabi::encode(&[Token::Uint(nonce.into())]),
    )
}

pub(super) fn block_with(transaction: &str, logs: Vec<Value>) -> (RpcBlock, Vec<RpcReceipt>) {
    let block = json!({
        "number": "0x2b", "hash": hex(&BLOCK_HASH), "parentHash": hex_repeat(0xee, 32),
        "receiptsRoot": hex_repeat(0, 32), "transactions": [transaction],
    });
    let receipt = json!({
        "transactionHash": transaction, "transactionIndex": "0x0", "blockNumber": "0x2b",
        "blockHash": hex(&BLOCK_HASH), "type": "0x2", "status": "0x1",
        "cumulativeGasUsed": "0x1", "logsBloom": hex_repeat(0, 256), "logs": logs,
    });
    (
        serde_json::from_value(block).expect("block"),
        vec![serde_json::from_value(receipt).expect("receipt")],
    )
}

pub(super) fn only_dispute_started(
    rpc: &DisputeRpc,
    block: &RpcBlock,
    receipts: &[RpcReceipt],
) -> Result<xln_rscore_engine::DisputeStartedEvent, JWatcherError> {
    let batch = build_block_batch(rpc, &config(), block, receipts)?.expect("local dispute batch");
    let [JurisdictionEvent::DisputeStarted(event)] = batch.events.as_slice() else {
        panic!(
            "expected exactly one DisputeStarted, got {:?}",
            batch.events
        );
    };
    Ok(event.clone())
}

fn served_start(data: Vec<u8>) -> Result<xln_rscore_engine::DisputeStartedEvent, JWatcherError> {
    let (hash, transaction) = signed_transaction(data);
    let rpc = DisputeRpc {
        transactions: BTreeMap::from([(hash.clone(), transaction)]),
        ..DisputeRpc::default()
    };
    let (block, receipts) = block_with(
        &hash,
        vec![
            dispute_started_log(&hash, 0, PEER, LOCAL, body_hash(5)),
            hanko_batch_log(&hash, 1, PEER, 3),
        ],
    );
    only_dispute_started(&rpc, &block, &receipts)
}

#[test]
fn foreign_dispute_through_a_wrapper_reads_no_calldata_and_emits_nothing() {
    let (hash, transaction) = signed_transaction(safe_wrapper(vec![0xde, 0xad]));
    let rpc = DisputeRpc {
        transactions: BTreeMap::from([(hash.clone(), transaction)]),
        ..DisputeRpc::default()
    };
    let (block, receipts) = block_with(
        &hash,
        vec![dispute_started_log(&hash, 0, PEER, FOREIGN, body_hash(5))],
    );
    let batch = build_block_batch(&rpc, &config(), &block, &receipts).expect("foreign dispute");
    assert!(batch.is_none());
    assert!(rpc.reads.borrow().is_empty());
}

#[test]
fn served_dispute_inside_an_abi_bytes_wrapper_resolves_its_proof_body() {
    let event = served_start(safe_wrapper(start_call(body_hash(5), 5, 3))).expect("wrapped start");
    assert_eq!(event.initial_proofbody.offdeltas, vec![5.into()]);
    assert_eq!(event.batch_nonce, Some(3));
}

#[test]
fn served_dispute_inside_packed_multisend_skips_decoys_and_keeps_the_logged_hanko_nonce() {
    // Decoys first: a different claimed hash, and the right claimed hash over a
    // different body. Neither matches the event; the executed call does.
    let data = multi_send(&[
        start_call(body_hash(6), 6, 9),
        start_call(body_hash(5), 6, 9),
        start_call(body_hash(5), 5, 3),
    ]);
    let event = served_start(data).expect("multisend start");
    assert_eq!(event.initial_proofbody.offdeltas, vec![5.into()]);
    assert_eq!(event.batch_nonce, Some(3));
}

#[test]
fn wrapper_whose_embedded_batch_commits_another_proof_body_is_rejected() {
    assert!(matches!(
        served_start(safe_wrapper(start_call(body_hash(6), 6, 3))),
        Err(JWatcherError::DisputeEvidence("start")),
    ));
}

/// raw_data (field 1) of a signed native wire `{1: raw_data, 2: signature}`.
fn tron_raw_data(signed: &[u8]) -> Vec<u8> {
    assert_eq!(signed[0], 0x0a, "raw_data field tag");
    let (mut length, mut shift, mut offset) = (0_usize, 0, 1);
    loop {
        let byte = signed[offset];
        offset += 1;
        length |= usize::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            break;
        }
        shift += 7;
    }
    signed[offset..offset + length].to_vec()
}

fn tron_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/tron-signed-call-v1.json"
    ))
    .expect("TronWeb signed-call fixture")
}

fn native_tron_start(
    raw: &[u8],
    tx_id: [u8; 32],
) -> Result<xln_rscore_engine::DisputeStartedEvent, JWatcherError> {
    let id = hex::encode(tx_id);
    let hash = format!("0x{id}");
    let rpc = DisputeRpc {
        native: Some(BTreeMap::from([(
            id.clone(),
            json!({ "txID": id, "raw_data_hex": hex::encode(raw) }),
        )])),
        ..DisputeRpc::default()
    };
    let (block, receipts) = block_with(
        &hash,
        vec![
            dispute_started_log(&hash, 0, PEER, LOCAL, body_hash(5)),
            hanko_batch_log(&hash, 1, PEER, 3),
        ],
    );
    let event = only_dispute_started(&rpc, &block, &receipts);
    assert_eq!(*rpc.reads.borrow(), vec![format!("native:{id}")]);
    event
}

#[test]
fn included_tron_call_decoder_reads_the_tronweb_raw_data_vector() {
    let fixture = tron_fixture();
    let raw = tron_raw_data(&hex::decode(fixture["raw"].as_str().expect("raw")).expect("wire"));
    let tx_id: [u8; 32] = hex::decode(fixture["hash"].as_str().expect("hash"))
        .expect("txID")
        .try_into()
        .expect("32-byte txID");
    assert_eq!(
        hex::encode(
            crate::j_submit::prepared_wire::decode_included_tron_call(&tx_id, &raw)
                .expect("included call")
        ),
        fixture["data"].as_str().expect("data"),
    );
    assert!(crate::j_submit::prepared_wire::decode_included_tron_call(&[0; 32], &raw).is_err());
}

#[test]
fn tron_dispute_calldata_is_bound_by_sha256_of_native_raw_data() {
    let fixture = tron_fixture();
    let key: [u8; 32] = hex::decode(fixture["key"].as_str().expect("key"))
        .expect("key hex")
        .try_into()
        .expect("32-byte key");
    let (signed, tx_id) = crate::j_submit::sign_tron_call(
        &fixture["head"],
        &[0x22; 20],
        &start_call(body_hash(5), 5, 3),
        10_000_000,
        &key,
    )
    .expect("sign native call");
    let raw = tron_raw_data(&signed);
    let event = native_tron_start(&raw, tx_id).expect("native dispute start");
    assert_eq!(event.initial_proofbody.offdeltas, vec![5.into()]);
    assert_eq!(event.batch_nonce, Some(3));
    let mut forged = raw;
    *forged.last_mut().expect("raw_data byte") ^= 1;
    assert!(matches!(
        native_tron_start(&forged, tx_id),
        Err(JWatcherError::TransactionHashMismatch),
    ));
}
