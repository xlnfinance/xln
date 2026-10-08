use super::*;
use crate::restore::{ConcreteWalSource, decode_concrete_runtime_wal_frame};
use std::collections::BTreeMap;

fn vector() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/native-tron-registration-replacement-v1.json"
    ))
    .unwrap()
}
fn replacement(value: &Value) -> Value {
    value["frame"]["runtimeInput"]["runtimeTxs"][0]["data"].clone()
}

#[test]
fn actual_native_replacement_wal_decodes() {
    let fixture = vector();
    let raw = hex::decode(fixture["walFrameHex"].as_str().unwrap()).unwrap();
    let source = ConcreteWalSource::new(2, raw, BTreeMap::new(), vec![]).unwrap();
    decode_concrete_runtime_wal_frame(&source, 0).unwrap();
}

#[test]
fn actual_native_replacement_matches_ts_infrastructure_and_duplicate_is_idempotent() {
    let fixture = vector();
    let mut env = RuntimeDurableEnvelope::decode(&fixture["before"], [0; 32]).unwrap();
    let data = decode(&replacement(&fixture)).unwrap();
    apply(&mut env, &data).unwrap();
    assert_eq!(*env.infrastructure(), fixture["after"]["infrastructure"]);
    apply(&mut env, &data).unwrap();
    assert_eq!(*env.infrastructure(), fixture["after"]["infrastructure"]);
}

#[test]
fn native_replacement_rejects_wrong_old_hash_expiry_policy_call_and_malformed_duplicate() {
    let fixture = vector();
    for key in ["previousTransactionHash", "requestHash"] {
        let mut input = replacement(&fixture);
        input[key] = json!(format!("0x{}", "00".repeat(32)));
        let mut env = RuntimeDurableEnvelope::decode(&fixture["before"], [0; 32]).unwrap();
        assert!(apply(&mut env, &decode(&input).unwrap()).is_err());
        assert_eq!(*env.infrastructure(), fixture["before"]["infrastructure"]);
    }
    let mut input = replacement(&fixture);
    input["evidence"]["timestamp"] = json!(1);
    let mut env = RuntimeDurableEnvelope::decode(&fixture["before"], [0; 32]).unwrap();
    assert!(apply(&mut env, &decode(&input).unwrap()).is_err());
    let input = decode(&replacement(&fixture)).unwrap();
    env.j_replicas_mut()[0][1]
        .as_object_mut()
        .unwrap()
        .remove("watcherReceiptCommitment");
    assert!(
        apply(&mut env, &input)
            .unwrap_err()
            .contains("NATIVE_REQUIRED")
    );
    let mut env = RuntimeDurableEnvelope::decode(&fixture["before"], [0; 32]).unwrap();
    env.infrastructure_mut()["numberedRegistrationIntents"]["value"][0][1]["request"]["payerSignerId"] =
        json!(format!("0x{}", "11".repeat(20)));
    assert!(
        apply(&mut env, &input)
            .unwrap_err()
            .contains("CALL_MISMATCH")
    );
    let mut env = RuntimeDurableEnvelope::decode(&fixture["before"], [0; 32]).unwrap();
    apply(&mut env, &input).unwrap();
    let mut altered = replacement(&fixture);
    altered["evidence"]["blockHash"] = json!(format!("0x{}", "00".repeat(32)));
    assert!(apply(&mut env, &decode(&altered).unwrap()).is_err());
}
