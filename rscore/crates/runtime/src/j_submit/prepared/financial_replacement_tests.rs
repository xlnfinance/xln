use super::*;
use serde_json::json;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/native-tron-financial-replacement-v1.json"
    ))
    .unwrap()
}
fn ready() -> (crate::RuntimeReplica, JPreparedReplacement, String) {
    let value = fixture();
    let mut replica = crate::machine::tests::replica(crate::RuntimeLimits::default()).unwrap();
    replica.durable =
        crate::processor::RuntimeDurableEnvelope::decode(&value["before"], [0; 32]).unwrap();
    let input = &value["frame"]["runtimeInput"]["runtimeTxs"][0]["data"];
    let data = decode_replacement(input).unwrap();
    let old = super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
        .unwrap()
        .pop()
        .unwrap()
        .raw_transaction
        .unwrap();
    (replica, data, old)
}
#[test]
fn actual_native_financial_replacement_preserves_sealed_intent_and_rebroadcasts_once() {
    let (mut replica, data, old) = ready();
    let before = super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
        .unwrap()
        .pop()
        .unwrap();
    let emitted = apply_j_prepared_replacement(&mut replica, &data)
        .unwrap()
        .expect("one post-WAL broadcast");
    let after = super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
        .unwrap()
        .pop()
        .unwrap();
    let mut expected = before;
    expected.raw_transaction = Some(data.0["rawTransaction"].as_str().unwrap().into());
    assert_eq!(after, expected);
    assert_eq!(
        *replica.durable.infrastructure(),
        fixture()["after"]["infrastructure"]
    );
    assert_eq!(emitted, expected);
    assert_ne!(after.raw_transaction.as_deref(), Some(old.as_str()));
    let committed = replica.durable.infrastructure().clone();
    assert!(
        apply_j_prepared_replacement(&mut replica, &data)
            .unwrap()
            .is_none()
    );
    assert_eq!(*replica.durable.infrastructure(), committed);
}
#[test]
fn actual_native_financial_replacement_rejects_wrong_policy_witness_and_sealed_batch() {
    for field in ["policy", "oldHash", "blockHash", "timestamp", "intent"] {
        let (mut replica, data, _) = ready();
        let mut value = data.0.clone();
        match field {
            "policy" => {
                replica.durable.j_replicas_mut()[0][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("watcherReceiptCommitment");
            }
            "oldHash" => value["previousTransactionHash"] = json!(format!("0x{}", "00".repeat(32))),
            "blockHash" => value["evidence"]["blockHash"] = json!(format!("0x{}", "00".repeat(32))),
            "timestamp" => value["evidence"]["timestamp"] = json!(1),
            _ => {
                let rows = infrastructure_pending_mut(&mut replica.durable).unwrap();
                let mut attempt = parse_attempt(&rows[0]).unwrap();
                attempt.sealed.nonce += ethabi::ethereum_types::U256::one();
                rows[0] = attempt_value(&attempt).unwrap();
            }
        }
        let before = replica.durable.infrastructure().clone();
        assert!(
            apply_j_prepared_replacement(&mut replica, &decode_replacement(&value).unwrap())
                .is_err(),
            "{field}"
        );
        assert_eq!(*replica.durable.infrastructure(), before, "{field}");
    }
}

#[test]
fn actual_native_financial_replacement_physical_wal_restores() {
    let value = fixture();
    let raw = hex::decode(value["walFrameHex"].as_str().unwrap()).unwrap();
    let source =
        crate::restore::ConcreteWalSource::new(25, raw, Default::default(), vec![]).unwrap();
    crate::restore::decode_concrete_runtime_wal_frame(&source, 0).unwrap();
}

#[test]
fn watcher_retired_financial_attempt_cannot_be_recreated_by_late_replacement() {
    let (mut replica, data, _) = ready();
    infrastructure_pending_mut(&mut replica.durable)
        .unwrap()
        .clear();
    let before = replica.durable.infrastructure().clone();
    assert!(
        apply_j_prepared_replacement(&mut replica, &data)
            .unwrap()
            .is_none()
    );
    assert_eq!(*replica.durable.infrastructure(), before);
}
