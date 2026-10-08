//! The one durable signed wire belongs to the existing committed batch attempt.
use super::DurableJSubmitAttempt;
use super::lifecycle::JSubmitLifecycleError;
use super::lifecycle::{
    attempt_value, error, infrastructure_pending_mut, normalize, parse_attempt,
};
use super::prepared_wire::decode_prepared_transaction;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JPreparedTransactionData {
    pub jurisdiction_name: String,
    pub attempt_id: String,
    pub raw_transaction: String,
}

pub(crate) fn decode_prepared(
    value: &Value,
) -> Result<JPreparedTransactionData, JSubmitLifecycleError> {
    let field = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| error(format!("PREPARED_FIELD:{key}")))
    };
    let object = value.as_object().ok_or_else(|| error("PREPARED_DATA"))?;
    if object.len() != 3 {
        return Err(error("PREPARED_FIELDS"));
    }
    Ok(JPreparedTransactionData {
        jurisdiction_name: field("jurisdictionName")?,
        attempt_id: field("attemptId")?,
        raw_transaction: field("rawTransaction")?,
    })
}

pub fn encode_j_prepared_transaction(
    data: &JPreparedTransactionData,
) -> Result<Value, JSubmitLifecycleError> {
    Ok(json!({"type":"recordJPreparedTransaction","data":{
        "jurisdictionName":data.jurisdiction_name,"attemptId":data.attempt_id,"rawTransaction":data.raw_transaction
    }}))
}

pub(super) fn validate_wire(
    replica: &crate::RuntimeReplica,
    attempt: &DurableJSubmitAttempt,
    raw: &str,
) -> Result<(), JSubmitLifecycleError> {
    let row = replica
        .durable
        .j_replicas()
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get(0).and_then(Value::as_str) == Some(attempt.jurisdiction_name.as_str())
            })
        })
        .and_then(|row| row.get(1))
        .ok_or_else(|| error("PREPARED_JURISDICTION"))?;
    let native = match row.get("watcherReceiptCommitment").and_then(Value::as_str) {
        Some("tron-rpc-attested") => true,
        None => false,
        _ => return Err(error("PREPARED_RECEIPT_POLICY")),
    };
    let wire = decode_prepared_transaction(raw, native).map_err(|e| error(e.to_string()))?;
    let chain_id = row
        .get("chainId")
        .and_then(Value::as_u64)
        .ok_or_else(|| error("PREPARED_CHAIN"))?;
    let depository = row
        .pointer("/contracts/depository")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PREPARED_DEPOSITORY"))?;
    let encoded = super::encode_j_batch(&attempt.sealed.batch).map_err(|e| error(e.to_string()))?;
    let hash = super::submission::depository_batch_hash(
        chain_id,
        &wire.to,
        &encoded,
        attempt.sealed.nonce,
    );
    if format!("0x{}", hex::encode(wire.to)) != normalize(depository)
        || (!native && wire.chain_id != Some(chain_id))
        || !wire.value.is_zero()
        || format!("0x{}", hex::encode(hash)) != attempt.batch_hash
    {
        return Err(error("PREPARED_BATCH_DOMAIN"));
    }
    let hanko = xln_rscore_hanko::compact_hanko_for_chain(&attempt.sealed.hanko, &hash)
        .map_err(|e| error(e.to_string()))?;
    if wire.data
        != super::submission::process_batch_calldata(&encoded, &hanko, attempt.sealed.nonce)
        || (!attempt.sealed.batch.external_token_to_reserve.is_empty()
            && wire.signer != attempt.sealed.signer_id)
    {
        return Err(error("PREPARED_BATCH_INTENT"));
    }
    Ok(())
}

pub fn apply_j_prepared_transaction(
    replica: &mut crate::RuntimeReplica,
    data: &JPreparedTransactionData,
) -> Result<Option<DurableJSubmitAttempt>, JSubmitLifecycleError> {
    let pending = super::decode_pending_j_submit_attempts(replica.durable.infrastructure())?;
    let matches = pending
        .into_iter()
        .filter(|attempt| {
            attempt.attempt_id == data.attempt_id
                && normalize(&attempt.jurisdiction_name) == normalize(&data.jurisdiction_name)
        })
        .collect::<Vec<_>>();
    let mut attempt = match matches.as_slice() {
        [] => return Ok(None), // Certified watcher retirement may win the race.
        [attempt] => attempt.clone(),
        _ => return Err(error("PENDING_ATTEMPT_DUPLICATED")),
    };
    validate_wire(replica, &attempt, &data.raw_transaction)?;
    if let Some(raw) = &attempt.raw_transaction {
        return if raw == &data.raw_transaction {
            Ok(None)
        } else {
            Err(error("PREPARED_TRANSACTION_CONFLICT"))
        };
    }
    attempt.raw_transaction = Some(data.raw_transaction.clone());
    let rows = infrastructure_pending_mut(&mut replica.durable)?;
    let index = rows
        .iter()
        .position(|row| {
            parse_attempt(row).is_ok_and(|candidate| {
                candidate.attempt_id == attempt.attempt_id
                    && candidate.jurisdiction_name == attempt.jurisdiction_name
            })
        })
        .ok_or_else(|| error("PREPARED_PENDING_MISSING"))?;
    rows[index] = attempt_value(&attempt)?;
    replica.durable.invalidate_infrastructure_digest();
    Ok(Some(attempt))
}

/// Completed attempts retain their signed wire until a committed Entity/J
/// transition retires the exact sealed batch. No receipt heuristic owns this.
pub fn prune_completed_prepared_attempts(
    replica: &mut crate::RuntimeReplica,
) -> Result<(), JSubmitLifecycleError> {
    let stale = super::decode_pending_j_submit_attempts(replica.durable.infrastructure())?
        .into_iter()
        .filter(|attempt| super::lifecycle::prepared_attempt_completed(replica, attempt))
        .filter(|attempt| {
            !replica
                .entity_slot(
                    &attempt.sealed.entity_id,
                    &format!("0x{}", hex::encode(attempt.sealed.signer_id)),
                )
                .is_some_and(|(state, _)| {
                    state.entity.j_batch_state.as_ref().is_some_and(|batch| {
                        batch.broadcast_count == attempt.batch_generation
                            && batch.sent_batch.as_ref().is_some_and(|sent| {
                                format!("0x{}", hex::encode(sent.batch_hash)) == attempt.batch_hash
                                    && sent.entity_nonce == attempt.sealed.nonce.low_u64()
                            })
                    })
                })
        })
        .map(|attempt| attempt.attempt_id)
        .collect::<std::collections::BTreeSet<_>>();
    if stale.is_empty() {
        return Ok(());
    }
    infrastructure_pending_mut(&mut replica.durable)?.retain(|row| {
        !row.pointer("/jTxs/0/data/runtimeSubmitAttempt/attemptId")
            .and_then(Value::as_str)
            .is_some_and(|id| stale.contains(id))
    });
    replica.durable.invalidate_infrastructure_digest();
    Ok(())
}

#[cfg(test)]
#[path = "prepared_lifecycle_tests.rs"]
mod tests;
