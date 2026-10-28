use super::*;
use crate::j_submit::{
    apply_j_prepared_replacement, apply_j_prepared_transaction, apply_j_submit_result,
    apply_j_submit_retry, decode_pending_j_submit_attempts,
};
use serde_json::json;

#[test]
fn rejected_replacement_hash_survives_result_commit_restore_and_next_retry() {
    let server = crate::j_watcher::tests::FakeRpcServer::submission_market();
    let (mut replica, initial, retry, mut wire, key) = crate::j_submit::unsigned_prepared_attempt();
    replica.durable.j_replicas_mut()[0][1]["rpcs"] = json!([server.endpoint]);
    replica.durable.j_replicas_mut()[0][1]["contracts"]["entityProvider"] =
        json!(format!("0x{}", "23".repeat(20)));
    wire.max_fee_per_gas = 100.into();
    wire.max_priority_fee_per_gas = 10.into();
    let raw = format!("0x{}", hex::encode(wire.sign(&key).unwrap().raw));
    let (rpc, config, _) = live_submit_context(&replica, "SimNet", key).unwrap();
    let prepared = JSubmitter::new(&rpc, config)
        .unwrap()
        .prepared_record("SimNet", &initial.attempt_id, raw)
        .unwrap();
    let original = apply_j_prepared_transaction(&mut replica, &prepared)
        .unwrap()
        .unwrap();
    replica.state.timestamp = 100;
    let RuntimeTx::RecordJSubmitResult(original_result) =
        submit_committed_attempt(&replica, key, &original, None, None)
    else {
        panic!("initial broadcast")
    };
    apply_j_submit_result(&mut replica, &original_result, 101).unwrap();
    replica.state.timestamp = 120101;
    let current = apply_j_submit_retry(&mut replica, &retry, 120101)
        .unwrap()
        .unwrap();
    let RuntimeTx::ReplaceJPreparedTransaction(replacement) =
        submit_committed_attempt(&replica, key, &current, None, None)
    else {
        panic!("market replacement")
    };
    let replaced = apply_j_prepared_replacement(&mut replica, &replacement, 120101)
        .unwrap()
        .unwrap();
    let replaced_wire = crate::j_submit::prepared_wire::decode_prepared_transaction(
        replaced.raw_transaction.as_ref().unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(
        (replaced_wire.max_fee, replaced_wire.priority_fee),
        (113.into(), 12.into())
    );
    server.reject_underpriced();
    let RuntimeTx::RecordJSubmitResult(failure) =
        submit_committed_attempt(&replica, key, &replaced, None, None)
    else {
        panic!("rejected replacement")
    };
    let rejected_hash = format!("0x{}", hex::encode(replaced_wire.hash));
    assert_eq!(failure.outcome, JSubmitResultOutcome::TransientFailure);
    assert_eq!(
        failure.transaction_hash.as_deref(),
        Some(rejected_hash.as_str())
    );
    apply_j_submit_result(&mut replica, &failure, 120102).unwrap();
    let (_, local) = replica
        .entity_slot_mut(&initial.sealed.entity_id, &retry.signer_id)
        .unwrap();
    assert_eq!(
        local.replica_metadata()["jSubmitState"]["txHash"],
        rejected_hash
    );
    // Recovery uses only the committed replica envelope and signed outbox, never RPC memory.
    let restored_meta =
        serde_json::from_slice(&serde_json::to_vec(local.replica_metadata()).unwrap()).unwrap();
    local.install_replica_metadata(restored_meta).unwrap();
    let restored =
        serde_json::from_slice(&serde_json::to_vec(replica.durable.infrastructure()).unwrap())
            .unwrap();
    *replica.durable.infrastructure_mut() = restored;
    assert_eq!(
        decode_pending_j_submit_attempts(replica.durable.infrastructure()).unwrap(),
        vec![replaced]
    );
    replica.state.timestamp = 180102;
    let successor = apply_j_submit_retry(&mut replica, &retry, 180102)
        .unwrap()
        .unwrap();
    let RuntimeTx::ReplaceJPreparedTransaction(next) =
        submit_committed_attempt(&replica, key, &successor, None, None)
    else {
        panic!("rejection must force next bump without a market increase")
    };
    let next = apply_j_prepared_replacement(&mut replica, &next, 180102)
        .unwrap()
        .unwrap();
    let next_wire = crate::j_submit::prepared_wire::decode_prepared_transaction(
        next.raw_transaction.as_ref().unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(
        (next_wire.max_fee, next_wire.priority_fee),
        (128.into(), 14.into())
    );
    assert_eq!(next_wire.nonce, replaced_wire.nonce);
    assert_eq!(next.competing_transactions.len(), 2);
}
