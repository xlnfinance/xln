//! Dispute logs supply their proof without a transaction lookup.
use super::super::abi::{DISPUTE_STARTED_TOPIC, HANKO_BATCH_PROCESSED_TOPIC, hex};
use super::super::types::{JWatcherError, RpcBlock, RpcReceipt};
use super::super::watcher::build_block_batch;
use super::{config, hex_repeat};
use ethabi::Token;
use serde_json::{Value, json};
use xln_rscore_engine::JurisdictionEvent;
use xln_rscore_entity_kernel::j_batch::ProofBody;
const LOCAL: [u8; 32] = [0xaa; 32];
const PEER: [u8; 32] = [0xbb; 32];
const BLOCK_HASH: [u8; 32] = [0xcc; 32];
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
        Token::Bytes(xln_rscore_entity_kernel::encode_proof_body(&body(5)).expect("encode proof")),
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
    block: &RpcBlock,
    receipts: &[RpcReceipt],
) -> Result<xln_rscore_engine::DisputeStartedEvent, JWatcherError> {
    let batch = build_block_batch(&config(), block, receipts)?.expect("local dispute batch");
    let [JurisdictionEvent::DisputeStarted(event)] = batch.events.as_slice() else {
        panic!(
            "expected exactly one DisputeStarted, got {:?}",
            batch.events
        );
    };
    Ok(event.clone())
}

#[test]
fn served_start_uses_log_body_and_authenticated_batch_nonce_without_rpc() {
    let hash = hex_repeat(0x99, 32);
    let (block, receipts) = block_with(
        &hash,
        vec![
            dispute_started_log(&hash, 0, PEER, LOCAL, body_hash(5)),
            hanko_batch_log(&hash, 1, PEER, 3),
        ],
    );
    let event = only_dispute_started(&block, &receipts).expect("start log");
    assert_eq!(event.initial_proofbody.offdeltas, vec![5.into()]);
    assert_eq!(event.batch_nonce, Some(3));
}
#[test]
fn served_start_rejects_a_body_hash_mismatch_without_rpc() {
    let hash = hex_repeat(0x99, 32);
    let (block, receipts) = block_with(
        &hash,
        vec![dispute_started_log(&hash, 0, PEER, LOCAL, body_hash(6))],
    );
    assert!(matches!(
        only_dispute_started(&block, &receipts),
        Err(JWatcherError::DisputeEvidence("proofbody-hash"))
    ));
}

#[test]
fn counter_log_carries_its_body_and_rejects_a_hash_mismatch() {
    use super::super::abi::COUNTER_DISPUTE_REGISTERED_TOPIC;
    let tx = hex_repeat(0x99, 32);
    let encoded = xln_rscore_entity_kernel::encode_proof_body(&body(5)).expect("body");
    for (hash, accepted) in [(body_hash(5), true), (body_hash(6), false)] {
        let data = ethabi::encode(&[
            Token::Bool(false),
            Token::FixedBytes(hash.to_vec()),
            Token::Bytes(encoded.clone()),
        ]);
        let (block, receipts) = block_with(
            &tx,
            vec![log(
                &tx,
                0,
                vec![
                    COUNTER_DISPUTE_REGISTERED_TOPIC.into(),
                    hex(&PEER),
                    hex(&LOCAL),
                    word(11),
                ],
                data,
            )],
        );
        let result = build_block_batch(&config(), &block, &receipts);
        if accepted {
            let batch = result.expect("counter log").expect("batch");
            let JurisdictionEvent::CounterDisputeRegistered(event) = &batch.events[0] else {
                panic!("counter event");
            };
            assert_eq!(event.counter_proofbody.offdeltas, vec![5.into()]);
        } else {
            assert!(matches!(
                result,
                Err(JWatcherError::DisputeEvidence("proofbody-hash"))
            ));
        }
    }
}

#[test]
fn finalized_log_carries_effective_sidecar_and_rejects_its_tampering() {
    use super::super::abi::DISPUTE_FINALIZED_TOPIC;
    use sha3::{Digest, Keccak256};
    let tx = hex_repeat(0x99, 32);
    let body = xln_rscore_entity_kernel::encode_proof_body(&body(5)).expect("body");
    let hash = Token::FixedBytes(body_hash(5).to_vec());
    let initial_hash = Token::FixedBytes(body_hash(0).to_vec());
    let sidecar = vec![
        initial_hash.clone(),
        Token::Uint(11.into()),
        Token::Bool(false),
        Token::Bool(true),
        Token::FixedBytes(Keccak256::digest([]).to_vec()),
        Token::Bytes(vec![0xab]),
        Token::Bytes(vec![]),
    ];
    let commitment = Keccak256::digest(ethabi::encode(&[
        initial_hash,
        Token::Uint(11.into()),
        Token::Bool(false),
        Token::Bool(true),
        Token::FixedBytes(Keccak256::digest([]).to_vec()),
        Token::FixedBytes(Keccak256::digest([0xab]).to_vec()),
        Token::FixedBytes(Keccak256::digest([]).to_vec()),
    ]));
    for tamper in [false, true] {
        let mut fields = sidecar.clone();
        if tamper {
            fields[6] = Token::Bytes(vec![1, 2]);
        }
        let data = ethabi::encode(&[
            hash.clone(),
            Token::FixedBytes(commitment.to_vec()),
            Token::Bytes(body.clone()),
            Token::Tuple(fields),
        ]);
        let (block, receipts) = block_with(
            &tx,
            vec![log(
                &tx,
                0,
                vec![
                    DISPUTE_FINALIZED_TOPIC.into(),
                    hex(&PEER),
                    hex(&LOCAL),
                    word(7),
                ],
                data,
            )],
        );
        let result = build_block_batch(&config(), &block, &receipts);
        if tamper {
            assert!(matches!(
                result,
                Err(JWatcherError::DisputeEvidence("finalized"))
            ));
        } else {
            let batch = result.expect("finalized log").expect("batch");
            let JurisdictionEvent::DisputeFinalized(event) = &batch.events[0] else {
                panic!("final event");
            };
            assert_eq!(event.final_proofbody.offdeltas, vec![5.into()]);
            assert_eq!(batch.dispute_finalization_evidence[0].sig, "0x");
            assert_eq!(batch.dispute_finalization_evidence[0].left_arguments, "0x");
            assert_eq!(
                batch.dispute_finalization_evidence[0].right_arguments,
                "0xab"
            );
        }
    }
}

#[test]
fn hash_only_finalization_recovers_body_and_starter_arguments_from_earlier_logs() {
    use super::super::abi::DISPUTE_FINALIZED_TOPIC;
    use sha3::{Digest, Keccak256};
    let tx = hex_repeat(0x99, 32);
    let arguments = vec![0x56; 65536];
    let start = dispute_started_log(&tx, 0, PEER, LOCAL, body_hash(5));
    let mut start_log: super::super::types::RpcLog = serde_json::from_value(start).expect("start");
    let mut fields = ethabi::decode(
        &[
            ethabi::ParamType::Bool,
            ethabi::ParamType::FixedBytes(32),
            ethabi::ParamType::FixedBytes(32),
            ethabi::ParamType::Bytes,
            ethabi::ParamType::Bytes,
            ethabi::ParamType::FixedBytes(32),
            ethabi::ParamType::Uint(256),
            ethabi::ParamType::Uint(256),
            ethabi::ParamType::Uint(32),
            ethabi::ParamType::Uint(32),
            ethabi::ParamType::Bytes,
        ],
        &super::super::receipt::parse_hex(&start_log.data, None, "data").expect("bytes"),
    )
    .expect("fields");
    fields[3] = Token::Bytes(arguments.clone());
    start_log.data = hex(&ethabi::encode(&fields));
    start_log.block_number = json!("0x2a");
    let sidecar = vec![
        Token::FixedBytes(body_hash(5).to_vec()),
        Token::Uint(7.into()),
        Token::Bool(false),
        Token::Bool(true),
        Token::FixedBytes(Keccak256::digest(&arguments).to_vec()),
        Token::Bytes(vec![]),
        Token::Bytes(vec![]),
    ];
    let commitment = Keccak256::digest(ethabi::encode(&[
        sidecar[0].clone(),
        sidecar[1].clone(),
        sidecar[2].clone(),
        sidecar[3].clone(),
        sidecar[4].clone(),
        Token::FixedBytes(Keccak256::digest([]).to_vec()),
        Token::FixedBytes(Keccak256::digest([]).to_vec()),
    ]));
    let final_log = log(
        &tx,
        0,
        vec![
            DISPUTE_FINALIZED_TOPIC.into(),
            hex(&PEER),
            hex(&LOCAL),
            word(7),
        ],
        ethabi::encode(&[
            Token::FixedBytes(body_hash(5).to_vec()),
            Token::FixedBytes(commitment.to_vec()),
            Token::Bytes(vec![]),
            Token::Tuple(sidecar),
        ]),
    );
    let (block, receipts) = block_with(&tx, vec![final_log]);
    let result = super::super::watcher::build_block_batch_with_history(
        &config(),
        &block,
        &receipts,
        &[start_log.clone()],
    )
    .expect("restart resolves earlier log")
    .expect("batch");
    let JurisdictionEvent::DisputeFinalized(event) = &result.events[0] else {
        panic!("final event");
    };
    assert_eq!(event.final_proofbody.offdeltas, vec![5.into()]);
    assert_eq!(
        result.dispute_finalization_evidence[0].left_arguments,
        hex(&arguments)
    );
    assert!(matches!(
        super::super::watcher::build_block_batch_with_history(&config(), &block, &receipts, &[]),
        Err(JWatcherError::DisputeEvidence("proofbody-log-missing"))
    ));
    start_log.topics[3] = word(8);
    assert!(matches!(
        super::super::watcher::build_block_batch_with_history(
            &config(),
            &block,
            &receipts,
            &[start_log]
        ),
        Err(JWatcherError::DisputeEvidence(
            "starter-arguments-log-missing"
        ))
    ));
}
