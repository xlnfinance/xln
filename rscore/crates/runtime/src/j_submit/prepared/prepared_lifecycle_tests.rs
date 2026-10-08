use super::*;
use crate::j_submit::{
    Eip1559Transaction, RetryJSubmitData, SealedJBatch, build_j_submit_attempt_id,
};

#[test]
fn prepared_signed_batch_is_exact_idempotent_and_rejects_well_signed_wrong_intent() {
    let mut replica = crate::machine::tests::replica(crate::RuntimeLimits::default()).unwrap();
    let key = xln_rscore_crypto::derive_signer_key(
        "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
        "h1-hub",
    )
    .unwrap();
    let signer = xln_rscore_crypto::address_of_private_key(&key).unwrap();
    let entity = xln_rscore_hanko::lazy_single_signer_entity_id(&signer);
    let to = [0x12; 20];
    let batch = super::super::JBatch::default();
    let encoded = super::super::encode_j_batch(&batch).unwrap();
    let hash = super::super::submission::depository_batch_hash(31337, &to, &encoded, 1.into());
    let hanko = xln_rscore_hanko::build_single_signer_hanko_envelope(
        &entity,
        &hash,
        &key,
        1,
        1,
        xln_rscore_hanko::BoardDelays::default(),
    )
    .unwrap();
    let chain_hanko = xln_rscore_hanko::compact_hanko_for_chain(&hanko, &hash).unwrap();
    let retry = RetryJSubmitData {
        entity_id: format!("0x{}", hex::encode(entity)),
        signer_id: format!("0x{}", hex::encode(signer)),
        jurisdiction_name: "SimNet".into(),
        batch_hash: format!("0x{}", hex::encode(hash)),
        entity_nonce: 1,
        batch_generation: 1,
        fee_overrides: None,
    };
    let attempt = DurableJSubmitAttempt {
        jurisdiction_name: retry.jurisdiction_name.clone(),
        batch_hash: retry.batch_hash.clone(),
        batch_generation: 1,
        attempt_id: build_j_submit_attempt_id(&retry, 1).unwrap(),
        attempt_number: 1,
        attempted_at: 100,
        fee_overrides: None,
        raw_transaction: None,
        sealed: SealedJBatch {
            entity_id: entity,
            signer_id: signer,
            nonce: 1.into(),
            batch,
            hanko,
        },
    };
    let (state, local) = replica.entity_slot_mut(&entity, &retry.signer_id).unwrap();
    state.entity.j_batch_state = Some(xln_rscore_entity_kernel::JBatchState {
        broadcast_count: 1,
        status: xln_rscore_entity_kernel::JBatchStatus::Sent,
        sent_batch: Some(xln_rscore_entity_kernel::SentJBatch {
            batch: attempt.sealed.batch.clone(),
            batch_hash: hash,
            encoded_batch: encoded.clone(),
            entity_nonce: 1,
            first_submitted_at: 100,
            last_submitted_at: 100,
            submit_attempts: 1,
            fee_overrides: None,
            transaction_hash: None,
            last_failure: None,
            terminal_failure: None,
        }),
        ..Default::default()
    });
    let metadata = super::super::lifecycle::metadata_object(local).unwrap();
    metadata.insert("hankoWitness".into(), json!({"__xlnType":"Map","value":[[retry.batch_hash,{"hanko":format!("0x{}",hex::encode(&attempt.sealed.hanko)),"type":"jBatch"}]]}));
    metadata.insert("jSubmitState".into(), json!({"jurisdictionName":"SimNet","batchHash":retry.batch_hash,"entityNonce":1,"batchGeneration":1,"submitAttempts":1,"lastSubmittedAt":100}));
    *replica.durable.j_replicas_mut() = json!([["SimNet", {"chainId":31337,"contracts":{"depository":format!("0x{}", hex::encode(to))}}]]);
    infrastructure_pending_mut(&mut replica.durable)
        .unwrap()
        .push(attempt_value(&attempt).unwrap());
    let tx = Eip1559Transaction {
        chain_id: 31337,
        nonce: 7,
        max_priority_fee_per_gas: 1.into(),
        max_fee_per_gas: 10.into(),
        gas_limit: 1_000_000.into(),
        to,
        value: 0.into(),
        data: super::super::submission::process_batch_calldata(&encoded, &chain_hanko, 1.into()),
    };
    let record = |tx: &Eip1559Transaction| JPreparedTransactionData {
        jurisdiction_name: "SimNet".into(),
        attempt_id: attempt.attempt_id.clone(),
        raw_transaction: format!("0x{}", hex::encode(tx.sign(&key).unwrap().raw)),
    };
    for field in ["target", "chain", "value", "data"] {
        let mut wrong = tx.clone();
        match field {
            "target" => wrong.to[0] ^= 1,
            "chain" => wrong.chain_id += 1,
            "value" => wrong.value = 1.into(),
            _ => wrong.data[0] ^= 1,
        }
        assert!(
            apply_j_prepared_transaction(&mut replica, &record(&wrong)).is_err(),
            "{field}"
        );
        assert_eq!(
            super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
                .unwrap()[0]
                .raw_transaction,
            None
        );
    }
    let record = record(&tx);
    let prepared = apply_j_prepared_transaction(&mut replica, &record)
        .unwrap()
        .unwrap();
    assert_eq!(
        prepared.raw_transaction.as_ref(),
        Some(&record.raw_transaction)
    );
    let exact_pending = replica.durable.infrastructure().clone();
    assert!(
        apply_j_prepared_transaction(&mut replica, &record)
            .unwrap()
            .is_none()
    );
    assert_eq!(replica.durable.infrastructure(), &exact_pending);
    let restored = super::super::decode_pending_j_submit_attempts(&exact_pending).unwrap();
    assert_eq!(restored, vec![prepared]);
    let mut alternate = tx;
    alternate.nonce += 1;
    let conflict = JPreparedTransactionData {
        raw_transaction: format!("0x{}", hex::encode(alternate.sign(&key).unwrap().raw)),
        ..record.clone()
    };
    assert!(
        apply_j_prepared_transaction(&mut replica, &conflict)
            .unwrap_err()
            .to_string()
            .contains("PREPARED_TRANSACTION_CONFLICT")
    );
    let mut current = attempt;
    for (index, outcome) in [
        super::super::JSubmitResultOutcome::TransientFailure,
        super::super::JSubmitResultOutcome::Submitted,
    ]
    .into_iter()
    .enumerate()
    {
        super::super::apply_j_submit_result(
            &mut replica,
            &super::super::JSubmitResultData {
                entity_id: retry.entity_id.clone(),
                signer_id: retry.signer_id.clone(),
                jurisdiction_name: "SimNet".into(),
                batch_hash: retry.batch_hash.clone(),
                entity_nonce: 1,
                batch_generation: 1,
                attempt_id: current.attempt_id.clone(),
                attempt_number: current.attempt_number,
                attempted_at: current.attempted_at,
                outcome,
                message: None,
                adapter_failure: None,
                transaction_hash: None,
            },
            current.attempted_at + 1,
        )
        .unwrap();
        let pending =
            super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
                .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].raw_transaction.as_ref(),
            Some(&record.raw_transaction)
        );
        assert!(super::super::lifecycle::prepared_attempt_completed(
            &replica,
            &pending[0]
        ));
        // A newer result may replace the last-result pointer while the journal
        // still proves this prepared attempt completed. Never dispatch it again.
        let (_, local) = replica.entity_slot_mut(&entity, &retry.signer_id).unwrap();
        super::super::lifecycle::metadata_object(local)
            .unwrap()
            .get_mut("jSubmitState")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("lastResultAttemptId".into(), json!("later-attempt"));
        assert!(super::super::lifecycle::prepared_attempt_completed(
            &replica,
            &pending[0]
        ));
        // A captured pre-signing outbox copy has no raw bytes. The committed
        // result journal still retires that exact attempt after restart.
        let mut unsigned_outbox_copy = pending[0].clone();
        unsigned_outbox_copy.raw_transaction = None;
        assert!(super::super::lifecycle::prepared_attempt_completed(
            &replica,
            &unsigned_outbox_copy
        ));
        prune_completed_prepared_attempts(&mut replica).unwrap();
        current =
            super::super::apply_j_submit_retry(&mut replica, &retry, current.attempted_at + 60_001)
                .unwrap()
                .unwrap();
        assert_eq!(current.attempt_number, index as u64 + 2);
        assert_eq!(
            current.raw_transaction.as_ref(),
            Some(&record.raw_transaction)
        );
        assert_eq!(
            super::super::decode_pending_j_submit_attempts(replica.durable.infrastructure())
                .unwrap(),
            vec![current.clone()]
        );
    }
}
