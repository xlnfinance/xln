//! Replacement changes only the exact signed wire of the existing batch attempt.
use super::native_replacement::{
    exact, raw_hex, text, validate_evidence, validate_native_replacement,
};
use super::{
    DurableJSubmitAttempt,
    lifecycle::{
        JSubmitLifecycleError, attempt_value, error, infrastructure_pending_mut, parse_attempt,
        prepared_attempt_completed,
    },
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JPreparedReplacement(Value);
impl JPreparedReplacement {
    pub(crate) fn encode(&self) -> Value {
        self.0.clone()
    }
}
pub(crate) fn decode_replacement(
    value: &Value,
) -> Result<JPreparedReplacement, JSubmitLifecycleError> {
    let validate = || -> Result<(), String> {
        exact(
            value,
            &[
                "jurisdictionName",
                "attemptId",
                "previousTransactionHash",
                "rawTransaction",
                "evidence",
            ],
        )?;
        if text(value, "jurisdictionName")?.is_empty() {
            return Err("J_REPLACEMENT_JURISDICTION".into());
        }
        raw_hex(text(value, "attemptId")?, Some(32))?;
        raw_hex(text(value, "previousTransactionHash")?, Some(32))?;
        raw_hex(text(value, "rawTransaction")?, None)?;
        validate_evidence(&value["evidence"])
    };
    validate().map_err(error)?;
    Ok(JPreparedReplacement(value.clone()))
}
pub fn apply_j_prepared_replacement(
    replica: &mut crate::RuntimeReplica,
    data: &JPreparedReplacement,
) -> Result<Option<DurableJSubmitAttempt>, JSubmitLifecycleError> {
    let value = &data.0;
    let jurisdiction = value["jurisdictionName"]
        .as_str()
        .expect("decoded jurisdiction");
    let id = value["attemptId"].as_str().expect("decoded attempt");
    let pending = super::decode_pending_j_submit_attempts(replica.durable.infrastructure())?;
    let matches = pending
        .into_iter()
        .filter(|attempt| attempt.attempt_id == id && attempt.jurisdiction_name == jurisdiction)
        .collect::<Vec<_>>();
    let mut attempt = match matches.as_slice() {
        [attempt] => attempt.clone(),
        [] => return Ok(None), // Authenticated watcher retirement can win this race.
        _ => return Err(error("PENDING_ATTEMPT_DUPLICATED")),
    };
    let row = replica
        .durable
        .j_replicas()
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row[0].as_str() == Some(jurisdiction))
        })
        .map(|row| &row[1])
        .ok_or_else(|| error("REPLACEMENT_JURISDICTION"))?;
    if row["watcherReceiptCommitment"] != "tron-rpc-attested" {
        return Err(error("REPLACEMENT_NATIVE_REQUIRED"));
    }
    let raw = value["rawTransaction"].as_str().expect("decoded raw");
    super::prepared_lifecycle::validate_wire(replica, &attempt, raw)?;
    let old = attempt
        .raw_transaction
        .as_deref()
        .ok_or_else(|| error("REPLACEMENT_PREPARED_MISSING"))?;
    if validate_native_replacement(
        old,
        raw,
        value["previousTransactionHash"]
            .as_str()
            .expect("decoded hash"),
        &value["evidence"],
    )
    .map_err(error)?
    {
        return Ok(None);
    }
    if prepared_attempt_completed(replica, &attempt) {
        return Err(error("REPLACEMENT_ATTEMPT_COMPLETED"));
    }
    attempt.raw_transaction = Some(raw.into());
    let rows = infrastructure_pending_mut(&mut replica.durable)?;
    let index = rows
        .iter()
        .position(|row| {
            parse_attempt(row)
                .is_ok_and(|row| row.attempt_id == id && row.jurisdiction_name == jurisdiction)
        })
        .ok_or_else(|| error("REPLACEMENT_PENDING_MISSING"))?;
    rows[index] = attempt_value(&attempt)?;
    replica.durable.invalidate_infrastructure_digest();
    Ok(Some(attempt))
}

#[cfg(test)]
#[path = "financial_replacement_tests.rs"]
mod tests;
