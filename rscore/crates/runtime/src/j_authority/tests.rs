use super::*;

fn envelope() -> RuntimeDurableEnvelope {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-tron-import-v1.json"
    ))
    .unwrap();
    // This is the actual TS durable post-import view: registry is absent.
    let mut machine = fixture["machine"].clone();
    machine["jReplicas"] = fixture["expectedView"]["jReplicas"].clone();
    machine["infrastructure"] = json!({});
    RuntimeDurableEnvelope::decode(&machine, [0; 32]).unwrap()
}
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../fixtures/native-tron-authority-v1.json"
    ))
    .unwrap()
}

#[test]
fn actual_evm_and_tvm_authority_survive_durable_registry_projection() {
    let mut envelope = envelope();
    for vector in vectors() {
        let evidence = decode(&vector).unwrap();
        apply(&mut envelope, &evidence).unwrap();
        let first = envelope.infrastructure().clone();
        apply(&mut envelope, &evidence).unwrap();
        assert_eq!(first, *envelope.infrastructure());
    }
    assert_eq!(
        envelope.infrastructure()["certifiedRegistrationEvidence"]["value"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn actual_authority_rejects_changed_receipt_signature_emitter_and_policy() {
    let values = vectors();
    let mut bad = values[0].clone();
    bad["receiptsRoot"] = json!(format!("0x{}", "11".repeat(32)));
    assert!(decode(&bad).unwrap_err().contains("PROOF_NODE_MISSING"));
    let mut bad = values[0].clone();
    bad["emitter"] = json!(format!("0x{}", "11".repeat(20)));
    assert!(decode(&bad).unwrap_err().contains("RECEIPT_LOG_MISMATCH"));
    let mut bad = values[1].clone();
    bad["witnessSignature"] = json!(format!("0x{}", "00".repeat(65)));
    assert!(decode(&bad).unwrap_err().contains("WITNESS_SIGNATURE"));
    let mut env = envelope();
    let native = decode(&values[1]).unwrap();
    env.j_replicas_mut()[0][1]
        .as_object_mut()
        .unwrap()
        .remove("watcherReceiptCommitment");
    assert!(
        apply(&mut env, &native)
            .unwrap_err()
            .contains("RECEIPT_COMMITMENT_MISMATCH")
    );
    let mut env = envelope();
    env.j_replicas_mut()[0][1]["rpcs"] = json!(["http://different.invalid/"]);
    assert!(
        apply(&mut env, &native)
            .unwrap_err()
            .contains("RPC_NOT_CONFIGURED")
    );
    let mut env = envelope();
    env.j_replicas_mut()[0][1]["chainId"] = json!(999);
    assert!(
        apply(&mut env, &native)
            .unwrap_err()
            .contains("STACK_LOCAL_MATCH")
    );
}
