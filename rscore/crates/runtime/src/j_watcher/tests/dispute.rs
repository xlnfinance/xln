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
    let mut references = super::super::DisputeReferences::default();
    super::super::dispute_reference::remember(&mut references, &start_log).expect("observed start");
    let references = serde_json::from_str(&serde_json::to_string(&references).expect("checkpoint"))
        .expect("restore");
    let result = super::super::watcher::build_block_batch_with_references(
        &config(),
        &block,
        &receipts,
        &references,
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
        Err(JWatcherError::DisputeReferenceUnavailable(
            "proofbody-log-missing"
        ))
    ));
    start_log.topics[3] = word(8);
    assert!(matches!(
        super::super::watcher::build_block_batch_with_history(
            &config(),
            &block,
            &receipts,
            &[start_log]
        ),
        Err(JWatcherError::DisputeReferenceUnavailable(
            "starter-arguments-log-missing"
        ))
    ));
}

#[test]
fn compiled_abi_dispute_signatures_equal_decoder_topics() {
    use super::super::abi::{COUNTER_DISPUTE_REGISTERED_TOPIC, DISPUTE_FINALIZED_TOPIC};
    for artifact in [
        include_str!("../../../../../../frontend/static/contracts/Depository.json"),
        include_str!("../../../../../../frontend/static/contracts/Account.json"),
    ] {
        let artifact: Value = serde_json::from_str(artifact).expect("compiled artifact");
        let contract = ethabi::Contract::load(artifact["abi"].to_string().as_bytes()).expect("ABI");
        for (name, topic) in [
            ("DisputeStarted", DISPUTE_STARTED_TOPIC),
            ("CounterDisputeRegistered", COUNTER_DISPUTE_REGISTERED_TOPIC),
            ("DisputeFinalized", DISPUTE_FINALIZED_TOPIC),
        ] {
            assert_eq!(
                hex(contract.event(name).expect("event").signature().as_bytes()),
                topic
            );
        }
    }
}

#[test]
fn observed_reference_does_not_query_history() {
    struct NoHistory;
    impl super::super::types::JsonRpc for NoHistory {
        fn call(&self, method: &str, _: Value) -> Result<Value, JWatcherError> {
            panic!("observed reference must not call {method}")
        }
    }
    let tx = hex_repeat(0x99, 32);
    let counter = log(
        &tx,
        1,
        vec![
            super::super::abi::COUNTER_DISPUTE_REGISTERED_TOPIC.into(),
            hex(&PEER),
            hex(&LOCAL),
            word(8),
        ],
        ethabi::encode(&[
            Token::Bool(false),
            Token::FixedBytes(body_hash(5).to_vec()),
            Token::Bytes(vec![]),
        ]),
    );
    let (_, receipts) = block_with(
        &tx,
        vec![
            dispute_started_log(&tx, 0, PEER, LOCAL, body_hash(5)),
            counter,
        ],
    );
    let mut state = super::super::DisputeReferences::default();
    super::super::dispute_reference::read_history(&config(), &receipts[..1], &mut state)
        .expect("observe");
    let restored = serde_json::from_str::<super::super::DisputeReferences>(
        &serde_json::to_string(&state).expect("checkpoint"),
    )
    .expect("restore");
    let (block, _) = block_with(&tx, vec![]);
    let batch = super::super::watcher::build_block_batch_with_references(
        &config(),
        &block,
        &receipts,
        &restored,
    )
    .expect("no history required")
    .expect("batch");
    assert_eq!(batch.events.len(), 2);
    let _rpc = NoHistory;
}

#[test]
fn actual_bytecode_emitted_logs_round_trip_and_restore() {
    use super::super::{DisputeReferences, types::RpcLog};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../core/__tests__/fixtures/jurisdiction/dispute-emitted-logs.json"
    ))
    .expect("real emitted logs");
    let artifact: Value = serde_json::from_str(include_str!(
        "../../../../../../frontend/static/contracts/Depository.json"
    ))
    .expect("artifact");
    let contract = ethabi::Contract::load(artifact["abi"].to_string().as_bytes()).expect("ABI");
    let mut state = DisputeReferences::default();
    let mut kinds = std::collections::BTreeSet::new();
    for value in fixture["logs"].as_array().expect("logs") {
        let mut value = value.clone();
        value["transactionIndex"] = json!(0);
        let log: RpcLog = serde_json::from_value(value).expect("log");
        let event = contract
            .events()
            .find(|e| hex(e.signature().as_bytes()) == log.topics[0])
            .expect("ABI event");
        kinds.insert(event.name.clone());
        let raw = ethabi::RawLog {
            topics: log
                .topics
                .iter()
                .map(|t| {
                    super::super::receipt::fixed_hex::<32>(t, "topic")
                        .expect("topic")
                        .into()
                })
                .collect(),
            data: super::super::receipt::parse_hex(&log.data, None, "data").expect("data"),
        };
        let decoded = event.parse_log(raw).expect("compiled ABI decode");
        let nonindexed: Vec<_> = event
            .inputs
            .iter()
            .zip(&decoded.params)
            .filter(|(p, _)| !p.indexed)
            .map(|(_, v)| v.value.clone())
            .collect();
        assert_eq!(hex(&ethabi::encode(&nonindexed)), log.data);
        assert!(
            super::super::abi::event_kind(&log)
                .expect("dispatch")
                .is_some()
        );
        super::super::dispute_reference::remember(&mut state, &log).expect("remember");
        state = serde_json::from_str(&serde_json::to_string(&state).expect("checkpoint"))
            .expect("restore");
        let mut cfg = config();
        cfg.depository_address =
            super::super::receipt::fixed_hex::<20>(&log.address, "address").expect("address");
        cfg.entity_id = xln_rscore_engine::EntityId::parse(&log.topics[1]).expect("sender");
        let (mut block, mut receipts) = block_with(&log.transaction_hash, vec![]);
        block.number = log.block_number.clone();
        block.hash = log.block_hash.clone();
        receipts[0].logs = vec![log];
        let batch = super::super::watcher::build_block_batch_with_references(
            &cfg, &block, &receipts, &state,
        )
        .expect("production decoder")
        .expect("dispute delivered");
        assert_eq!(batch.events.len(), 1);
    }
    assert_eq!(kinds.len(), 3);
}

#[test]
fn missing_reference_uses_only_bounded_pages_from_recorded_start() {
    use super::super::{DisputeReferences, types::JsonRpc};
    struct Pages(std::cell::RefCell<Vec<(u64, u64)>>);
    impl JsonRpc for Pages {
        fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
            assert_eq!(method, "eth_getLogs");
            let from = super::super::receipt::safe_u64(&params[0]["fromBlock"], "from")?;
            let to = super::super::receipt::safe_u64(&params[0]["toBlock"], "to")?;
            assert!(from >= 700 && to - from < 256);
            self.0.borrow_mut().push((from, to));
            Ok(json!([]))
        }
    }
    let tx = hex_repeat(0x99, 32);
    let mut counter = log(
        &tx,
        0,
        vec![
            super::super::abi::COUNTER_DISPUTE_REGISTERED_TOPIC.into(),
            hex(&PEER),
            hex(&LOCAL),
            word(8),
        ],
        ethabi::encode(&[
            Token::Bool(false),
            Token::FixedBytes(body_hash(5).to_vec()),
            Token::Bytes(vec![]),
        ]),
    );
    counter["blockNumber"] = json!(1000);
    let (_, receipts) = block_with(&tx, vec![counter]);
    let mut state = DisputeReferences::default();
    let rpc = Pages(Default::default());
    assert!(matches!(
        super::super::dispute_reference::refill(&rpc, &config(), &receipts, &mut state),
        Err(JWatcherError::DisputeReferenceUnavailable(
            "start-block-missing"
        ))
    ));
    assert!(rpc.0.borrow().is_empty());
    state
        .start_blocks
        .insert(format!("{}:{}", hex(&LOCAL), hex(&PEER)), 700);
    super::super::dispute_reference::refill(&rpc, &config(), &receipts, &mut state)
        .expect("bounded refill");
    assert_eq!(*rpc.0.borrow(), vec![(700, 955), (956, 1000)]);
}
