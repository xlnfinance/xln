use super::super::{DisputeReferences, types::*, watcher};
use super::{config, hex_repeat};
use serde_json::{Value, json};
use std::cell::RefCell;

struct ReceiptChain {
    blocks: std::collections::BTreeMap<u64, Value>,
    receipts: std::collections::BTreeMap<String, Value>,
    reads: RefCell<Vec<(String, Value)>>,
}
impl JsonRpc for ReceiptChain {
    fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
        self.reads
            .borrow_mut()
            .push((method.into(), params.clone()));
        match method {
            "eth_chainId" => Ok(json!("0x7a69")),
            "eth_blockNumber" => Ok(json!(43)),
            "eth_call" => Ok(json!(format!("0x{:064x}", 0))),
            "eth_getBlockByNumber" => {
                let height = super::super::receipt::safe_u64(&params[0], "height")?;
                assert!(height >= 41, "must never read genesis");
                Ok(self.blocks[&height].clone())
            }
            "eth_getTransactionReceipt" => Ok(self.receipts[params[0].as_str().unwrap()].clone()),
            _ => panic!("unexpected {method}"),
        }
    }
}

fn chain() -> ReceiptChain {
    // Real bytecode-emitted start/finalization, relocated to the crash boundary.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../core/__tests__/fixtures/jurisdiction/dispute-emitted-logs.json"
    ))
    .unwrap();
    let mut chain = ReceiptChain {
        blocks: Default::default(),
        receipts: Default::default(),
        reads: Default::default(),
    };
    chain.blocks.insert(
        41,
        json!({"number":41,"hash":hex_repeat(41,32),"parentHash":hex_repeat(40,32),
        "receiptsRoot":hex_repeat(0,32),"transactions":[]}),
    );
    for (height, index) in [(42, 0), (43, 1)] {
        let tx = hex_repeat(height as u8, 32);
        let mut log = fixture["logs"][index].clone();
        log["blockNumber"] = json!(height);
        log["blockHash"] = json!(tx);
        log["transactionHash"] = json!(tx);
        log["transactionIndex"] = json!(0);
        log["logIndex"] = json!(0);
        let receipt = json!({"transactionHash":tx,"transactionIndex":0,"blockNumber":height,"blockHash":tx,
            "type":"0x2","status":"0x1","cumulativeGasUsed":"0x1","logsBloom":hex_repeat(0,256),"logs":[log]});
        let encoded = super::super::receipt::encode_receipt(
            &serde_json::from_value(receipt.clone()).unwrap(),
        )
        .unwrap();
        let root = triehash::ordered_trie_root::<keccak_hasher::KeccakHasher, _>([encoded]);
        chain.blocks.insert(
            height,
            json!({"number":height,"hash":tx,"parentHash":hex_repeat((height-1) as u8,32),
            "receiptsRoot":super::super::abi::hex(root.as_ref()),"transactions":[tx]}),
        );
        chain.receipts.insert(tx, receipt);
    }
    chain
}

fn fixture_config(chain: &ReceiptChain) -> JWatcherConfig {
    let log = &chain.receipts[&hex_repeat(42, 32)]["logs"][0];
    let mut cfg = config();
    cfg.depository_address =
        super::super::receipt::fixed_hex::<20>(log["address"].as_str().unwrap(), "address")
            .unwrap();
    cfg.entity_id = xln_rscore_engine::EntityId::parse(log["topics"][1].as_str().unwrap()).unwrap();
    cfg.last_finalized_j_height = 42;
    cfg.entity_provider_deployment_block = Some(41);
    cfg
}

#[test]
fn crash_after_entity_certificate_before_shared_cursor_reauthenticates_start() {
    let chain = chain();
    let cfg = fixture_config(&chain);
    let restored = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([42; 32]),
        dispute_references: DisputeReferences::default(),
    };
    let recovered =
        watcher::recover_dispute_references(&chain, &cfg, &restored, 41, Some(42)).unwrap();
    assert_eq!(recovered.scanned_through, 42);
    assert_eq!(
        recovered
            .dispute_references
            .start_blocks
            .values()
            .copied()
            .collect::<Vec<_>>(),
        vec![42]
    );
    let mut wrong_anchor = restored.clone();
    wrong_anchor.block_hash = Some([99; 32]);
    assert!(
        watcher::recover_dispute_references(&chain, &cfg, &wrong_anchor, 41, Some(42)).is_err()
    );
    let polled = watcher::poll_finalized_j_events(&chain, &cfg, &recovered).unwrap();
    assert_eq!(polled.batches.len(), 1, "start must not be delivered twice");
    assert!(matches!(
        polled.batches[0].events[0],
        xln_rscore_engine::JurisdictionEvent::DisputeFinalized(_)
    ));
    assert!(
        chain
            .reads
            .borrow()
            .iter()
            .any(|(method, params)| method == "eth_getTransactionReceipt"
                && params[0] == hex_repeat(42, 32))
    );
}

#[test]
fn finalized_height_rescan_never_resolves_hash_only_disputes() {
    let chain = chain();
    let mut cfg = fixture_config(&chain);
    cfg.last_finalized_j_height = 43;
    let block: RpcBlock = serde_json::from_value(chain.blocks[&43].clone()).unwrap();
    let receipt: RpcReceipt =
        serde_json::from_value(chain.receipts[&hex_repeat(43, 32)].clone()).unwrap();
    assert!(
        watcher::build_block_batch_with_references(
            &cfg,
            &block,
            &[receipt],
            &DisputeReferences::default()
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn fresh_import_uses_deployment_floor_for_missing_start() {
    struct Pages(RefCell<Vec<(u64, u64)>>, Value);
    impl JsonRpc for Pages {
        fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
            assert_eq!(method, "eth_getLogs");
            let from = super::super::receipt::safe_u64(&params[0]["fromBlock"], "from")?;
            let to = super::super::receipt::safe_u64(&params[0]["toBlock"], "to")?;
            self.0.borrow_mut().push((from, to));
            Ok(if from == 956 {
                json!([self.1])
            } else {
                json!([])
            })
        }
    }
    let chain = chain();
    let mut cfg = fixture_config(&chain);
    cfg.entity_provider_deployment_block = Some(700);
    let mut start = chain.receipts[&hex_repeat(42, 32)]["logs"][0].clone();
    start["blockNumber"] = json!(960);
    let mut receipt = chain.receipts[&hex_repeat(43, 32)].clone();
    receipt["logs"][0]["blockNumber"] = json!(1000);
    let receipts = vec![serde_json::from_value(receipt).unwrap()];
    let rpc = Pages(Default::default(), start);
    let mut state = DisputeReferences::default();
    super::super::dispute_reference::refill(&rpc, &cfg, &receipts, &mut state).unwrap();
    assert_eq!(*rpc.0.borrow(), vec![(700, 955), (956, 1000)]);
    let mut block: RpcBlock = serde_json::from_value(chain.blocks[&43].clone()).unwrap();
    block.number = json!(1000);
    assert!(
        watcher::build_block_batch_with_references(&cfg, &block, &receipts, &state)
            .unwrap()
            .is_some()
    );
}

#[test]
fn recovery_rejects_unauthenticated_start_without_mutating_restored_cache() {
    let mut chain = chain();
    let cfg = fixture_config(&chain);
    let restored = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([42; 32]),
        dispute_references: DisputeReferences::default(),
    };
    chain.blocks.get_mut(&42).unwrap()["receiptsRoot"] = json!(hex_repeat(0, 32));
    assert!(matches!(
        watcher::recover_dispute_references(&chain, &cfg, &restored, 41, Some(42)),
        Err(JWatcherError::ReceiptRootMismatch)
    ));
    assert_eq!(restored.dispute_references, DisputeReferences::default());
}

#[test]
fn unfinalized_recovery_target_mismatch_is_retryable_not_finalized_reorg() {
    let chain = chain();
    let mut cfg = fixture_config(&chain);
    cfg.last_finalized_j_height = 41;
    let anchor = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([99; 32]),
        dispute_references: DisputeReferences::default(),
    };
    assert!(matches!(
        watcher::recover_dispute_references(&chain, &cfg, &anchor, 41, Some(42)),
        Err(JWatcherError::RangeChanged(42))
    ));
}

#[test]
fn fresh_anchor_without_referenced_starts_never_reads_deployment_receipts() {
    let chain = chain();
    let cfg = fixture_config(&chain);
    let anchor = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([42; 32]),
        dispute_references: DisputeReferences::default(),
    };
    let recovered = watcher::recover_dispute_references(&chain, &cfg, &anchor, 0, None).unwrap();
    assert_eq!(recovered, anchor);
    assert_eq!(
        chain
            .reads
            .borrow()
            .iter()
            .filter(|(method, _)| method == "eth_getTransactionReceipt")
            .count(),
        0
    );
    assert_eq!(
        chain
            .reads
            .borrow()
            .iter()
            .filter(|(method, _)| method == "eth_getBlockByNumber")
            .count(),
        1
    );
}

#[test]
fn restart_reconciles_private_42_before_receipts_and_certified_42_fails_closed() {
    let chain = chain();
    let certified = FinalizedWatcherCursor {
        scanned_through: 41,
        block_hash: Some([41; 32]),
        dispute_references: DisputeReferences::default(),
    };
    assert_eq!(
        watcher::reconcile_recovery_frontier(&chain, &certified, Some((42, [99; 32]))).unwrap(),
        Some((42, [42; 32]))
    );
    assert_eq!(
        chain
            .reads
            .borrow()
            .iter()
            .filter(|(method, _)| method == "eth_getTransactionReceipt")
            .count(),
        0
    );
    // After the Runtime commits the rewind, recovery observes the certified head.
    assert_eq!(
        watcher::reconcile_recovery_frontier(&chain, &certified, Some((41, [41; 32]))).unwrap(),
        None
    );
    let wrong = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([99; 32]),
        ..certified
    };
    assert!(matches!(
        watcher::reconcile_recovery_frontier(&chain, &wrong, None),
        Err(JWatcherError::FinalizedReorg(42))
    ));
}

#[test]
fn intermediate_recovery_page_link_does_not_claim_finality() {
    struct PageRace {
        boundary_reads: RefCell<u32>,
    }
    impl JsonRpc for PageRace {
        fn call(&self, method: &str, params: Value) -> Result<Value, JWatcherError> {
            if method == "eth_chainId" {
                return Ok(json!("0x7a69"));
            }
            assert_eq!(method, "eth_getBlockByNumber");
            let height = super::super::receipt::safe_u64(&params[0], "height")?;
            if height == 297 {
                *self.boundary_reads.borrow_mut() += 1;
            }
            let changed = *self.boundary_reads.borrow() > 2;
            let hash = if changed && height == 297 {
                99
            } else {
                height as u8
            };
            let parent = if changed && height == 298 {
                99
            } else {
                (height - 1) as u8
            };
            Ok(
                json!({"number":height, "hash":hex_repeat(hash,32), "parentHash":hex_repeat(parent,32),
                "receiptsRoot":"0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421", "transactions":[]}),
            )
        }
    }
    let chain = PageRace {
        boundary_reads: RefCell::new(0),
    };
    let mut cfg = config();
    cfg.last_finalized_j_height = 298;
    let anchor = FinalizedWatcherCursor {
        scanned_through: 298,
        block_hash: Some([42; 32]),
        dispute_references: DisputeReferences::default(),
    };
    assert!(matches!(
        watcher::recover_dispute_references(&chain, &cfg, &anchor, 41, Some(42)),
        Err(JWatcherError::RangeChanged(297))
    ));
    assert_eq!(anchor.dispute_references, DisputeReferences::default());
}

#[test]
fn referenced_start_bounds_recovery_even_with_zero_shared_cursor() {
    let chain = chain();
    let cfg = fixture_config(&chain);
    let anchor = FinalizedWatcherCursor {
        scanned_through: 42,
        block_hash: Some([42; 32]),
        dispute_references: DisputeReferences::default(),
    };
    let recovered =
        watcher::recover_dispute_references(&chain, &cfg, &anchor, 0, Some(42)).unwrap();
    assert_eq!(
        recovered
            .dispute_references
            .start_blocks
            .values()
            .copied()
            .collect::<Vec<_>>(),
        vec![42]
    );
    assert!(
        chain
            .reads
            .borrow()
            .iter()
            .filter(|(method, _)| method == "eth_getBlockByNumber")
            .all(
                |(_, params)| super::super::receipt::safe_u64(&params[0], "height").unwrap() >= 41
            )
    );
}
