//! Deterministic three-frame J-submit lifecycle.
//!
//! Frame A commits the Entity `sentBatch` and schedules `retryJSubmit`. Frame B
//! commits the exact validator-local attempt below. Only its post-fsync copy may
//! cross the RPC boundary. Frame C commits `recordJSubmitResult`. The pending
//! attempt lives in the existing Runtime infrastructure component and is not a
//! network outbox row or a second state root.

use ethabi::ethereum_types::U256;
use std::collections::BTreeSet;

use serde_json::{Map, Number, Value, json};
use sha3::{Digest, Keccak256};
use thiserror::Error;
use xln_rscore_entity_kernel::j_batch::JBatchFeeOverrides;
use xln_rscore_entity_kernel::{
    SealedJBatch, canonical_j_batch, decode_canonical_j_batch, encode_j_batch,
};

use crate::{
    RuntimeDurableEnvelope, RuntimeEntityReplica, RuntimeReplica, tagged_json_from_canonical_value,
};

const RETRY_MS: u64 = 60_000;
const RESULT_FINGERPRINT_LIMIT: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryJSubmitData {
    pub entity_id: String,
    pub signer_id: String,
    pub jurisdiction_name: String,
    pub batch_hash: String,
    pub entity_nonce: u64,
    pub batch_generation: u64,
    pub fee_overrides: Option<JBatchFeeOverrides>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JSubmitResultOutcome {
    Submitted,
    EventBarrier,
    TransientFailure,
    TerminalFailure,
    Reconciled,
}

impl JSubmitResultOutcome {
    fn text(&self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::EventBarrier => "eventBarrier",
            Self::TransientFailure => "transientFailure",
            Self::TerminalFailure => "terminalFailure",
            Self::Reconciled => "reconciled",
        }
    }

    fn parse(value: &str) -> Result<Self, JSubmitLifecycleError> {
        match value {
            "submitted" => Ok(Self::Submitted),
            "eventBarrier" => Ok(Self::EventBarrier),
            "transientFailure" => Ok(Self::TransientFailure),
            "terminalFailure" => Ok(Self::TerminalFailure),
            "reconciled" => Ok(Self::Reconciled),
            _ => Err(error("RESULT_OUTCOME_INVALID")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JAdapterFailure {
    pub category: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JSubmitResultData {
    pub entity_id: String,
    pub signer_id: String,
    pub jurisdiction_name: String,
    pub batch_hash: String,
    pub entity_nonce: u64,
    pub batch_generation: u64,
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
    pub outcome: JSubmitResultOutcome,
    pub message: Option<String>,
    pub adapter_failure: Option<JAdapterFailure>,
    pub transaction_hash: Option<String>,
}

/// Exact post-fsync side-effect payload. Every field is also present in the
/// committed `pendingCommittedJOutbox` row, so restart derives it from state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableJSubmitAttempt {
    pub jurisdiction_name: String,
    pub batch_hash: String,
    pub batch_generation: u64,
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
    pub fee_overrides: Option<JBatchFeeOverrides>,
    pub sealed: SealedJBatch,
}

#[derive(Debug, Error)]
#[error("RSCORE_J_LIFECYCLE:{0}")]
pub struct JSubmitLifecycleError(String);

pub(super) fn error(code: impl Into<String>) -> JSubmitLifecycleError {
    JSubmitLifecycleError(code.into())
}

pub(super) fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn safe_number(value: u64, field: &'static str) -> Result<Value, JSubmitLifecycleError> {
    if value > 9_007_199_254_740_991 {
        return Err(error(format!("{field}_UNSAFE")));
    }
    Ok(Value::Number(Number::from(value)))
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn fixed_hex<const N: usize>(
    value: &str,
    field: &'static str,
) -> Result<[u8; N], JSubmitLifecycleError> {
    let value = normalize(value);
    let bytes = hex::decode(value.strip_prefix("0x").ok_or_else(|| error(field))?)
        .map_err(|_| error(field))?;
    bytes.try_into().map_err(|_| error(field))
}

fn bytes_hex(value: &str, field: &'static str) -> Result<Vec<u8>, JSubmitLifecycleError> {
    let value = normalize(value);
    hex::decode(value.strip_prefix("0x").ok_or_else(|| error(field))?).map_err(|_| error(field))
}

/// TS `safeStringify` sorts object keys recursively. `serde_json::Map` uses a
/// BTreeMap in this crate, yielding the identical UTF-8 JSON byte sequence.
pub(super) fn stable_json(value: &Value) -> Result<String, JSubmitLifecycleError> {
    serde_json::to_string(value).map_err(|_| error("JSON"))
}

pub fn build_j_submit_attempt_id(
    retry: &RetryJSubmitData,
    attempt_number: u64,
) -> Result<String, JSubmitLifecycleError> {
    if attempt_number == 0 || retry.batch_generation == 0 {
        return Err(error("ATTEMPT_NUMBER_INVALID"));
    }
    let jurisdiction_name = normalize(&retry.jurisdiction_name);
    let entity_id = normalize(&retry.entity_id);
    let signer_id = normalize(&retry.signer_id);
    let batch_hash = normalize(&retry.batch_hash);
    if jurisdiction_name.is_empty()
        || entity_id.is_empty()
        || signer_id.is_empty()
        || batch_hash.is_empty()
    {
        return Err(error("ATTEMPT_IDENTITY_MISSING"));
    }
    let value = json!({
        "domain": "xln/j-submit-attempt/v1",
        "jurisdictionName": jurisdiction_name,
        "entityId": entity_id,
        "signerId": signer_id,
        "entityNonce": retry.entity_nonce,
        "batchGeneration": retry.batch_generation,
        "batchHash": batch_hash,
        "attemptNumber": attempt_number,
    });
    Ok(hex(&Keccak256::digest(stable_json(&value)?.as_bytes())))
}

fn batch_size(batch: &xln_rscore_entity_kernel::JBatch) -> usize {
    batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len()
}

fn fee_value(value: &JBatchFeeOverrides) -> Value {
    let mut output = Map::new();
    if let Some(value) = value.gas_bump_bps {
        output.insert("gasBumpBps".into(), Value::Number(Number::from(value)));
    }
    if let Some(value) = &value.max_fee_per_gas_wei {
        output.insert("maxFeePerGasWei".into(), Value::String(value.clone()));
    }
    if let Some(value) = &value.max_priority_fee_per_gas_wei {
        output.insert(
            "maxPriorityFeePerGasWei".into(),
            Value::String(value.clone()),
        );
    }
    Value::Object(output)
}

fn decode_fee_value(value: &Value) -> Result<JBatchFeeOverrides, JSubmitLifecycleError> {
    let fees = value
        .as_object()
        .ok_or_else(|| error("FEE_OVERRIDES_OBJECT"))?;
    let gas_bump_bps = fees
        .get("gasBumpBps")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| error("GAS_BUMP_BPS"))
                .and_then(|value| u32::try_from(value).map_err(|_| error("GAS_BUMP_BPS")))
        })
        .transpose()?;
    let string_field = |name: &'static str| -> Result<Option<String>, JSubmitLifecycleError> {
        fees.get(name)
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| error(name))
            })
            .transpose()
    };
    Ok(JBatchFeeOverrides {
        gas_bump_bps,
        max_fee_per_gas_wei: string_field("maxFeePerGasWei")?,
        max_priority_fee_per_gas_wei: string_field("maxPriorityFeePerGasWei")?,
    })
}

fn attempt_value(attempt: &DurableJSubmitAttempt) -> Result<Value, JSubmitLifecycleError> {
    let batch = tagged_json_from_canonical_value(
        &canonical_j_batch(&attempt.sealed.batch).map_err(|e| error(e.to_string()))?,
    )
    .map_err(|e| error(e.to_string()))?;
    let encoded = encode_j_batch(&attempt.sealed.batch).map_err(|e| error(e.to_string()))?;
    let mut data = Map::from_iter([
        ("batch".into(), batch),
        (
            "batchHash".into(),
            Value::String(attempt.batch_hash.clone()),
        ),
        ("encodedBatch".into(), Value::String(hex(&encoded))),
        (
            "entityNonce".into(),
            safe_number(attempt.sealed.nonce.low_u64(), "ENTITY_NONCE")?,
        ),
        (
            "batchGeneration".into(),
            safe_number(attempt.batch_generation, "BATCH_GENERATION")?,
        ),
        (
            "hankoSignature".into(),
            Value::String(hex(&attempt.sealed.hanko)),
        ),
        (
            "batchSize".into(),
            safe_number(batch_size(&attempt.sealed.batch) as u64, "BATCH_SIZE")?,
        ),
        (
            "signerId".into(),
            Value::String(hex(&attempt.sealed.signer_id)),
        ),
        (
            "runtimeSubmitAttempt".into(),
            json!({
                "attemptId": attempt.attempt_id,
                "attemptNumber": attempt.attempt_number,
                "attemptedAt": attempt.attempted_at,
                "batchGeneration": attempt.batch_generation,
            }),
        ),
    ]);
    if let Some(fees) = &attempt.fee_overrides {
        data.insert("feeOverrides".into(), fee_value(fees));
    }
    Ok(json!({
        "jurisdictionName": attempt.jurisdiction_name,
        "jTxs": [{
            "type": "batch",
            "entityId": hex(&attempt.sealed.entity_id),
            "data": Value::Object(data),
            "timestamp": attempt.attempted_at,
        }],
    }))
}

pub(super) fn infrastructure_pending_mut(
    durable: &mut RuntimeDurableEnvelope,
) -> Result<&mut Vec<Value>, JSubmitLifecycleError> {
    let infrastructure = durable
        .infrastructure_mut()
        .as_object_mut()
        .ok_or_else(|| error("INFRASTRUCTURE_OBJECT"))?;
    let value = infrastructure
        .entry("pendingCommittedJOutbox")
        .or_insert_with(|| Value::Array(Vec::new()));
    value.as_array_mut().ok_or_else(|| error("PENDING_ARRAY"))
}

pub(super) fn metadata_object(
    replica: &mut RuntimeEntityReplica,
) -> Result<&mut Map<String, Value>, JSubmitLifecycleError> {
    replica
        .replica_metadata
        .as_object_mut()
        .ok_or_else(|| error("REPLICA_META_OBJECT"))
}

pub(super) fn hanko_for_kind(
    replica: &RuntimeEntityReplica,
    committed_hash: &str,
    expected_kind: &str,
) -> Result<Vec<u8>, JSubmitLifecycleError> {
    let metadata = replica
        .replica_metadata
        .as_object()
        .ok_or_else(|| error("REPLICA_META_OBJECT"))?;
    let rows = metadata
        .get("hankoWitness")
        .and_then(Value::as_object)
        .and_then(|tag| {
            (tag.get("__xlnType").and_then(Value::as_str) == Some("Map")).then(|| tag.get("value"))
        })
        .flatten()
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(format!(
                "HANKO_WITNESS_MISSING:{}",
                normalize(committed_hash)
            ))
        })?;
    let wanted = normalize(committed_hash);
    let entry = rows
        .iter()
        .find_map(|row| {
            let row = row.as_array()?;
            (row.len() == 2 && row[0].as_str().map(normalize).as_deref() == Some(wanted.as_str()))
                .then(|| row[1].as_object())
                .flatten()
        })
        .ok_or_else(|| error(format!("HANKO_WITNESS_MISSING:{wanted}")))?;
    if entry.get("type").and_then(Value::as_str) != Some(expected_kind) {
        return Err(error(format!("HANKO_WITNESS_TYPE:{wanted}")));
    }
    bytes_hex(
        entry
            .get("hanko")
            .and_then(Value::as_str)
            .ok_or_else(|| error("HANKO_WITNESS_BYTES"))?,
        "HANKO_WITNESS_BYTES",
    )
}

/// The batch Hanko as the chain receives it: the certified envelope, compacted
/// to the 65-byte form when it is one EOA proving its own lazy entity (parity:
/// `compactHankoForChain` at `rpc-submission.ts`).
fn hanko_for(
    replica: &RuntimeEntityReplica,
    batch_hash: &str,
) -> Result<Vec<u8>, JSubmitLifecycleError> {
    let hanko = hanko_for_kind(replica, batch_hash, "jBatch")?;
    let digest: [u8; 32] = fixed_hex(batch_hash, "BATCH_HASH")?;
    xln_rscore_hanko::compact_hanko_for_chain(&hanko, &digest)
        .map_err(|cause| error(format!("BATCH_HANKO_SHAPE:{cause}")))
}

pub(super) fn pending_tx_type(value: &Value) -> Result<&str, JSubmitLifecycleError> {
    let input = value
        .as_object()
        .ok_or_else(|| error("PENDING_INPUT_OBJECT"))?;
    let rows = input
        .get("jTxs")
        .and_then(Value::as_array)
        .ok_or_else(|| error("PENDING_TXS"))?;
    if rows.len() != 1 {
        return Err(error("PENDING_TX_COUNT"));
    }
    rows[0]
        .as_object()
        .and_then(|tx| tx.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| error("PENDING_TX_TYPE"))
}

fn prior_submit_state(replica: &RuntimeEntityReplica) -> Option<&Map<String, Value>> {
    replica
        .replica_metadata
        .as_object()?
        .get("jSubmitState")?
        .as_object()
}

fn submit_state_matches_retry(
    state: &Map<String, Value>,
    retry: &RetryJSubmitData,
) -> Result<bool, JSubmitLifecycleError> {
    Ok(
        normalize(&string(state, "jurisdictionName")?) == normalize(&retry.jurisdiction_name)
            && normalize(&string(state, "batchHash")?) == normalize(&retry.batch_hash)
            && field_u64(state, "entityNonce")? == retry.entity_nonce
            && field_u64(state, "batchGeneration")? == retry.batch_generation,
    )
}

fn field_u64(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<u64, JSubmitLifecycleError> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| error(field))
}

fn pending_has_identity(
    replica: &RuntimeReplica,
    retry: &RetryJSubmitData,
) -> Result<bool, JSubmitLifecycleError> {
    Ok(
        decode_pending_j_submit_attempts(replica.durable.infrastructure())?
            .iter()
            .any(|attempt| {
                normalize(&attempt.jurisdiction_name) == normalize(&retry.jurisdiction_name)
                    && hex(&attempt.sealed.entity_id) == normalize(&retry.entity_id)
                    && hex(&attempt.sealed.signer_id) == normalize(&retry.signer_id)
                    && attempt.batch_hash == normalize(&retry.batch_hash)
                    && attempt.sealed.nonce == U256::from(retry.entity_nonce)
                    && attempt.batch_generation == retry.batch_generation
            }),
    )
}

pub fn apply_j_submit_retry(
    replica: &mut RuntimeReplica,
    retry: &RetryJSubmitData,
    current_timestamp: u64,
) -> Result<Option<DurableJSubmitAttempt>, JSubmitLifecycleError> {
    let entity_id = fixed_hex(&retry.entity_id, "ENTITY_ID")?;
    let (entity_state, entity_replica) = replica
        .entity_slot(&entity_id, &retry.signer_id)
        .ok_or_else(|| error("LOCAL_REPLICA_MISSING"))?;
    let sent = match entity_state
        .entity
        .j_batch_state
        .as_ref()
        .and_then(|state| state.sent_batch.as_ref())
    {
        Some(sent)
            if hex(&sent.batch_hash) == normalize(&retry.batch_hash)
                && sent.entity_nonce == retry.entity_nonce
                && entity_state
                    .entity
                    .j_batch_state
                    .as_ref()
                    .is_some_and(|state| state.broadcast_count == retry.batch_generation) =>
        {
            sent.clone()
        }
        _ => {
            println!(
                "RSCORE_J_RETRY_SKIPPED:sent-batch-mismatch:batch={}:nonce={}:generation={}",
                normalize(&retry.batch_hash),
                retry.entity_nonce,
                retry.batch_generation
            );
            return Ok(None);
        }
    };
    if sent.terminal_failure.is_some() {
        println!(
            "RSCORE_J_RETRY_SKIPPED:terminal-failure:batch={}",
            normalize(&retry.batch_hash)
        );
        return Ok(None);
    }
    if pending_has_identity(replica, retry)? {
        println!(
            "RSCORE_J_RETRY_SKIPPED:pending-attempt:batch={}",
            normalize(&retry.batch_hash)
        );
        return Ok(None);
    }
    // Retry/result state belongs to one exact sealed batch. Carrying a prior
    // batch's `reconciled`, terminal failure, attempt count or retry deadline
    // into a new batch permanently blocks or delays otherwise valid J work.
    let prior = prior_submit_state(entity_replica).cloned();
    let previous = match prior.as_ref() {
        Some(state) if submit_state_matches_retry(state, retry)? => Some(state.clone()),
        _ => None,
    };
    if previous
        .as_ref()
        .and_then(|v| v.get("terminalFailure"))
        .is_some()
        || previous
            .as_ref()
            .and_then(|v| v.get("lastResultOutcome"))
            .and_then(Value::as_str)
            == Some("reconciled")
    {
        println!(
            "RSCORE_J_RETRY_SKIPPED:prior-terminal:batch={}",
            normalize(&retry.batch_hash)
        );
        return Ok(None);
    }
    if let Some(previous) = &previous {
        let attempts = field_u64(previous, "submitAttempts")?;
        let last = field_u64(previous, "lastSubmittedAt")?;
        if attempts > 0
            && previous.get("lastResultOutcome").and_then(Value::as_str) != Some("eventBarrier")
            && current_timestamp < last.saturating_add(RETRY_MS)
        {
            println!(
                "RSCORE_J_RETRY_SKIPPED:retry-window:batch={}:remainingMs={}",
                normalize(&retry.batch_hash),
                last.saturating_add(RETRY_MS)
                    .saturating_sub(current_timestamp)
            );
            return Ok(None);
        }
    }
    let hanko = hanko_for(entity_replica, &retry.batch_hash)?;
    let attempt_number = previous
        .as_ref()
        .map(|v| field_u64(v, "submitAttempts"))
        .transpose()?
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| error("ATTEMPT_OVERFLOW"))?;
    let attempt_id = build_j_submit_attempt_id(retry, attempt_number)?;
    let attempt = DurableJSubmitAttempt {
        jurisdiction_name: retry.jurisdiction_name.clone(),
        batch_hash: normalize(&retry.batch_hash),
        batch_generation: retry.batch_generation,
        attempt_id: attempt_id.clone(),
        attempt_number,
        attempted_at: current_timestamp,
        fee_overrides: retry
            .fee_overrides
            .clone()
            .or_else(|| sent.fee_overrides.clone()),
        sealed: SealedJBatch {
            entity_id: fixed_hex(&retry.entity_id, "ENTITY_ID")?,
            signer_id: fixed_hex(&retry.signer_id, "SIGNER_ID")?,
            nonce: U256::from(retry.entity_nonce),
            batch: sent.batch,
            hanko,
        },
    };
    let fingerprint = stable_json(&attempt_value(&attempt)?)?;
    for known in decode_pending_j_submit_attempts(replica.durable.infrastructure())? {
        if known.attempt_id == attempt.attempt_id {
            if stable_json(&attempt_value(&known)?)? != fingerprint {
                return Err(error(format!(
                    "PENDING_ATTEMPT_CONFLICT:{}",
                    attempt.attempt_id
                )));
            }
            return Ok(None);
        }
    }
    infrastructure_pending_mut(&mut replica.durable)?.push(attempt_value(&attempt)?);
    replica.durable.invalidate_infrastructure_digest();
    let mut state = previous.unwrap_or_else(|| {
        let mut next = Map::new();
        if let Some(prior) = prior {
            for field in ["resultFingerprints", "resultFingerprintOrder"] {
                if let Some(value) = prior.get(field) {
                    next.insert(field.into(), value.clone());
                }
            }
        }
        next
    });
    state.insert(
        "jurisdictionName".into(),
        Value::String(retry.jurisdiction_name.clone()),
    );
    state.insert(
        "batchHash".into(),
        Value::String(normalize(&retry.batch_hash)),
    );
    state.insert(
        "entityNonce".into(),
        safe_number(retry.entity_nonce, "ENTITY_NONCE")?,
    );
    state.insert(
        "batchGeneration".into(),
        safe_number(retry.batch_generation, "BATCH_GENERATION")?,
    );
    state.insert(
        "submitAttempts".into(),
        safe_number(attempt_number, "ATTEMPT_NUMBER")?,
    );
    state.insert(
        "lastSubmittedAt".into(),
        safe_number(current_timestamp, "ATTEMPTED_AT")?,
    );
    let (_, entity_replica) = replica
        .entity_slot_mut(&entity_id, &retry.signer_id)
        .ok_or_else(|| error("LOCAL_REPLICA_MISSING"))?;
    metadata_object(entity_replica)?.insert("jSubmitState".into(), Value::Object(state));
    println!(
        "RSCORE_J_RETRY_ADMITTED:batch={}:nonce={}:generation={}:attempt={}",
        attempt.batch_hash, retry.entity_nonce, retry.batch_generation, attempt_number
    );
    Ok(Some(attempt))
}

fn parse_attempt(value: &Value) -> Result<DurableJSubmitAttempt, JSubmitLifecycleError> {
    let input = value
        .as_object()
        .ok_or_else(|| error("PENDING_INPUT_OBJECT"))?;
    let jurisdiction_name = input
        .get("jurisdictionName")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PENDING_JURISDICTION"))?
        .to_string();
    let rows = input
        .get("jTxs")
        .and_then(Value::as_array)
        .ok_or_else(|| error("PENDING_TXS"))?;
    if rows.len() != 1 {
        return Err(error("PENDING_TX_COUNT"));
    }
    let tx = rows[0].as_object().ok_or_else(|| error("PENDING_TX"))?;
    if tx.get("type").and_then(Value::as_str) != Some("batch") {
        return Err(error("PENDING_TX_TYPE"));
    }
    let entity_id_text = tx
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PENDING_ENTITY"))?;
    let data = tx
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| error("PENDING_DATA"))?;
    let encoded = bytes_hex(
        data.get("encodedBatch")
            .and_then(Value::as_str)
            .ok_or_else(|| error("PENDING_ENCODED"))?,
        "PENDING_ENCODED",
    )?;
    let batch =
        xln_rscore_entity_kernel::decode_j_batch(&encoded).map_err(|e| error(e.to_string()))?;
    let projected_batch = data
        .get("batch")
        .ok_or_else(|| error("PENDING_BATCH"))
        .and_then(|value| {
            crate::canonical_value_from_tagged_json(value).map_err(|e| error(e.to_string()))
        })
        .and_then(|value| decode_canonical_j_batch(&value).map_err(|e| error(e.to_string())))?;
    if projected_batch != batch {
        return Err(error("PENDING_BATCH_ENCODING_MISMATCH"));
    }
    let metadata = data
        .get("runtimeSubmitAttempt")
        .and_then(Value::as_object)
        .ok_or_else(|| error("PENDING_ATTEMPT"))?;
    let fee_overrides = data.get("feeOverrides").map(decode_fee_value).transpose()?;
    let attempt = DurableJSubmitAttempt {
        jurisdiction_name,
        batch_hash: normalize(
            data.get("batchHash")
                .and_then(Value::as_str)
                .ok_or_else(|| error("PENDING_BATCH_HASH"))?,
        ),
        batch_generation: field_u64(data, "batchGeneration")?,
        attempt_id: metadata
            .get("attemptId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("PENDING_ATTEMPT_ID"))?
            .to_string(),
        attempt_number: field_u64(metadata, "attemptNumber")?,
        attempted_at: field_u64(metadata, "attemptedAt")?,
        fee_overrides,
        sealed: SealedJBatch {
            entity_id: fixed_hex(entity_id_text, "PENDING_ENTITY")?,
            signer_id: fixed_hex(
                data.get("signerId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PENDING_SIGNER"))?,
                "PENDING_SIGNER",
            )?,
            nonce: U256::from(field_u64(data, "entityNonce")?),
            batch,
            hanko: bytes_hex(
                data.get("hankoSignature")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PENDING_HANKO"))?,
                "PENDING_HANKO",
            )?,
        },
    };
    let retry = RetryJSubmitData {
        entity_id: hex(&attempt.sealed.entity_id),
        signer_id: hex(&attempt.sealed.signer_id),
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        batch_hash: attempt.batch_hash.clone(),
        entity_nonce: attempt.sealed.nonce.low_u64(),
        batch_generation: attempt.batch_generation,
        fee_overrides: attempt.fee_overrides.clone(),
    };
    if attempt.attempt_id != build_j_submit_attempt_id(&retry, attempt.attempt_number)? {
        return Err(error("PENDING_ATTEMPT_ID_MISMATCH"));
    }
    Ok(attempt)
}

pub fn decode_pending_j_submit_attempts(
    infrastructure: &Value,
) -> Result<Vec<DurableJSubmitAttempt>, JSubmitLifecycleError> {
    let Some(rows) = infrastructure
        .as_object()
        .and_then(|v| v.get("pendingCommittedJOutbox"))
    else {
        return Ok(Vec::new());
    };
    rows.as_array()
        .ok_or_else(|| error("PENDING_ARRAY"))?
        .iter()
        .filter_map(|value| match pending_tx_type(value) {
            Ok("batch") => Some(parse_attempt(value)),
            Ok(
                "entityProviderTransfer"
                | "entityProviderReleaseControlShares"
                | "entityProviderCancelAction"
                | "entityProviderProposeControlBoard",
            ) => None,
            Ok(kind) => Some(Err(error(format!("PENDING_TX_TYPE:{kind}")))),
            Err(reason) => Some(Err(reason)),
        })
        .collect()
}

fn remove_pending_attempt(
    replica: &mut RuntimeReplica,
    attempt_id: &str,
) -> Result<bool, JSubmitLifecycleError> {
    let rows = infrastructure_pending_mut(&mut replica.durable)?;
    let matches = rows
        .iter()
        .enumerate()
        .filter_map(|(index, value)| match pending_tx_type(value) {
            Ok("batch") => Some(parse_attempt(value).map(|attempt| (index, attempt))),
            Ok(_) => None,
            Err(reason) => Some(Err(reason)),
        })
        .filter_map(|row: Result<_, JSubmitLifecycleError>| match row {
            Ok((index, attempt)) if attempt.attempt_id == attempt_id => Some(Ok(index)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let [index] = matches.as_slice() else {
        return if matches.is_empty() {
            Ok(false)
        } else {
            Err(error("PENDING_ATTEMPT_DUPLICATED"))
        };
    };
    rows.remove(*index);
    replica.durable.invalidate_infrastructure_digest();
    Ok(true)
}

fn build_result_journal(
    state: &Map<String, Value>,
    pending: &[DurableJSubmitAttempt],
    result: &JSubmitResultData,
    fingerprint: String,
) -> Result<(Map<String, Value>, Vec<Value>), JSubmitLifecycleError> {
    let mut journal = state
        .get("resultFingerprints")
        .map(|value| {
            value
                .as_object()
                .cloned()
                .ok_or_else(|| error("RESULT_JOURNAL_OBJECT"))
        })
        .transpose()?
        .unwrap_or_default();
    let mut order = state
        .get("resultFingerprintOrder")
        .map(|value| {
            value
                .as_array()
                .cloned()
                .ok_or_else(|| error("RESULT_JOURNAL_ORDER_ARRAY"))
        })
        .transpose()?
        .unwrap_or_else(|| journal.keys().cloned().map(Value::String).collect());
    let mut seen = BTreeSet::new();
    for attempt_id in &order {
        let attempt_id = attempt_id
            .as_str()
            .ok_or_else(|| error("RESULT_JOURNAL_ORDER_ID"))?;
        if !seen.insert(attempt_id.to_string()) {
            return Err(error("RESULT_JOURNAL_ORDER_DUPLICATE"));
        }
        if !journal.contains_key(attempt_id) {
            return Err(error("RESULT_JOURNAL_ORDER_UNKNOWN"));
        }
    }
    if seen.len() != journal.len() {
        return Err(error("RESULT_JOURNAL_ORDER_INCOMPLETE"));
    }
    order.retain(|value| value.as_str() != Some(result.attempt_id.as_str()));
    order.push(Value::String(result.attempt_id.clone()));
    journal.insert(result.attempt_id.clone(), Value::String(fingerprint));
    let wanted_entity = normalize(&result.entity_id);
    let wanted_signer = normalize(&result.signer_id);
    let mut retained = pending
        .iter()
        .filter(|attempt| {
            hex(&attempt.sealed.entity_id) == wanted_entity
                && hex(&attempt.sealed.signer_id) == wanted_signer
        })
        .map(|attempt| attempt.attempt_id.clone())
        .collect::<BTreeSet<_>>();
    if retained.len() > RESULT_FINGERPRINT_LIMIT {
        return Err(error("ACTIVE_ATTEMPT_CAPACITY_EXCEEDED"));
    }
    for attempt_id in order.iter().rev().filter_map(Value::as_str) {
        if retained.len() >= RESULT_FINGERPRINT_LIMIT {
            break;
        }
        retained.insert(attempt_id.to_string());
    }
    order.retain(|attempt_id| {
        attempt_id
            .as_str()
            .is_some_and(|attempt_id| retained.contains(attempt_id))
    });
    journal.retain(|attempt_id, _| retained.contains(attempt_id));
    Ok((journal, order))
}

pub fn apply_j_submit_result(
    replica: &mut RuntimeReplica,
    result: &JSubmitResultData,
    current_timestamp: u64,
) -> Result<(), JSubmitLifecycleError> {
    let retry = RetryJSubmitData {
        entity_id: result.entity_id.clone(),
        signer_id: result.signer_id.clone(),
        jurisdiction_name: result.jurisdiction_name.clone(),
        batch_hash: result.batch_hash.clone(),
        entity_nonce: result.entity_nonce,
        batch_generation: result.batch_generation,
        fee_overrides: None,
    };
    if result.attempt_id != build_j_submit_attempt_id(&retry, result.attempt_number)? {
        return Err(error("RESULT_ATTEMPT_ID_MISMATCH"));
    }
    if let Some(failure) = &result.adapter_failure {
        let expected = match failure.category.as_str() {
            "transient" => JSubmitResultOutcome::TransientFailure,
            "terminal" => JSubmitResultOutcome::TerminalFailure,
            _ => return Err(error("ADAPTER_FAILURE_CATEGORY")),
        };
        if result.outcome != expected
            || result.message.as_deref() != Some(failure.message.as_str())
            || failure.code.trim().is_empty()
        {
            return Err(error("ADAPTER_FAILURE_MISMATCH"));
        }
    }
    let result_value = result_data_value(result)?;
    let fingerprint = stable_json(&result_value)?;
    let entity_id = fixed_hex(&result.entity_id, "ENTITY_ID")?;
    let (entity_state, entity_replica) = replica
        .entity_slot(&entity_id, &result.signer_id)
        .ok_or_else(|| error("LOCAL_REPLICA_MISSING"))?;
    let mut state = entity_replica
        .replica_metadata
        .as_object()
        .and_then(|metadata| metadata.get("jSubmitState"))
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| error("RESULT_STATE_MISSING"))?;
    let existing = state
        .get("resultFingerprints")
        .and_then(Value::as_object)
        .and_then(|v| v.get(&result.attempt_id))
        .and_then(Value::as_str)
        .or_else(|| {
            (state.get("lastResultAttemptId").and_then(Value::as_str)
                == Some(result.attempt_id.as_str()))
            .then(|| state.get("lastResultFingerprint").and_then(Value::as_str))
            .flatten()
        });
    if let Some(existing) = existing {
        return if existing == fingerprint {
            Ok(())
        } else {
            Err(error("RESULT_DUPLICATE_CONFLICT"))
        };
    }
    let pending = decode_pending_j_submit_attempts(replica.durable.infrastructure())?;
    let matched = pending
        .iter()
        .filter(|v| v.attempt_id == result.attempt_id)
        .collect::<Vec<_>>();
    if matched.len() > 1 {
        return Err(error("PENDING_ATTEMPT_DUPLICATED"));
    }
    if let Some(attempt) = matched.first()
        && (normalize(&attempt.jurisdiction_name) != normalize(&result.jurisdiction_name)
            || hex(&attempt.sealed.entity_id) != normalize(&result.entity_id)
            || hex(&attempt.sealed.signer_id) != normalize(&result.signer_id)
            || attempt.batch_hash != normalize(&result.batch_hash)
            || attempt.sealed.nonce != U256::from(result.entity_nonce)
            || attempt.batch_generation != result.batch_generation
            || attempt.attempt_number != result.attempt_number
            || attempt.attempted_at != result.attempted_at)
    {
        return Err(error("RESULT_PENDING_CONFLICT"));
    }
    let sent_matches = entity_state
        .entity
        .j_batch_state
        .as_ref()
        .and_then(|v| v.sent_batch.as_ref())
        .is_some_and(|sent| {
            hex(&sent.batch_hash) == normalize(&result.batch_hash)
                && sent.entity_nonce == result.entity_nonce
        })
        && entity_state
            .entity
            .j_batch_state
            .as_ref()
            .is_some_and(|v| v.broadcast_count == result.batch_generation);
    let local_matches = state.get("jurisdictionName").and_then(Value::as_str)
        == Some(result.jurisdiction_name.as_str())
        && state
            .get("batchHash")
            .and_then(Value::as_str)
            .is_some_and(|hash| normalize(hash) == normalize(&result.batch_hash))
        && state.get("entityNonce").and_then(Value::as_u64) == Some(result.entity_nonce)
        && state.get("batchGeneration").and_then(Value::as_u64) == Some(result.batch_generation);
    let current_attempt = state.get("submitAttempts").and_then(Value::as_u64);
    if !sent_matches
        || (local_matches && current_attempt.is_some_and(|value| result.attempt_number < value))
    {
        remove_pending_attempt(replica, &result.attempt_id)?;
        return Ok(());
    }
    if !local_matches
        || current_attempt != Some(result.attempt_number)
        || state.get("lastSubmittedAt").and_then(Value::as_u64) != Some(result.attempted_at)
    {
        return Err(error("RESULT_ATTEMPT_MISMATCH"));
    }
    if matched.is_empty() {
        return Err(error("PENDING_ATTEMPT_MISSING"));
    }
    state.insert(
        "lastResultAttemptId".into(),
        Value::String(result.attempt_id.clone()),
    );
    state.insert(
        "lastResultAt".into(),
        safe_number(current_timestamp, "RESULT_AT")?,
    );
    state.insert(
        "lastResultOutcome".into(),
        Value::String(result.outcome.text().into()),
    );
    state.insert(
        "lastResultFingerprint".into(),
        Value::String(fingerprint.clone()),
    );
    let (journal, order) = build_result_journal(&state, &pending, result, fingerprint)?;
    state.insert("resultFingerprints".into(), Value::Object(journal));
    state.insert("resultFingerprintOrder".into(), Value::Array(order));
    match result.outcome {
        JSubmitResultOutcome::Submitted => {
            if let Some(hash) = &result.transaction_hash {
                state.insert("txHash".into(), Value::String(hash.clone()));
            }
            state.remove("lastFailure");
        }
        JSubmitResultOutcome::EventBarrier => {
            state.remove("lastFailure");
        }
        JSubmitResultOutcome::TransientFailure | JSubmitResultOutcome::TerminalFailure => {
            let message = result.message.clone().unwrap_or_else(|| "unknown".into());
            let contradiction = result.outcome == JSubmitResultOutcome::TerminalFailure;
            let mut failure = json!({"message":message,"failedAt":current_timestamp,"failure":{"category":if contradiction {"Contradiction"} else {"TransientRace"},"code":if contradiction {"J_SUBMIT_FATAL"} else {"J_SUBMIT_TRANSIENT"},"message":message,"retryable":!contradiction,"fatal":contradiction}});
            if let Some(adapter) = &result.adapter_failure {
                failure.as_object_mut().expect("failure object").insert(
                        "adapterFailure".into(),
                        json!({"category":adapter.category,"code":adapter.code,"message":adapter.message}),
                    );
            }
            state.insert("lastFailure".into(), failure.clone());
            if contradiction {
                state.insert("terminalFailure".into(), failure);
            }
        }
        JSubmitResultOutcome::Reconciled => {}
    }
    let (_, entity_replica) = replica
        .entity_slot_mut(&entity_id, &result.signer_id)
        .ok_or_else(|| error("LOCAL_REPLICA_MISSING"))?;
    metadata_object(entity_replica)?.insert("jSubmitState".into(), Value::Object(state));
    if !remove_pending_attempt(replica, &result.attempt_id)? {
        return Err(error("PENDING_ATTEMPT_MISSING"));
    }
    Ok(())
}

fn result_data_value(result: &JSubmitResultData) -> Result<Value, JSubmitLifecycleError> {
    let mut data = Map::from_iter([
        ("entityId".into(), Value::String(result.entity_id.clone())),
        ("signerId".into(), Value::String(result.signer_id.clone())),
        (
            "jurisdictionName".into(),
            Value::String(result.jurisdiction_name.clone()),
        ),
        ("batchHash".into(), Value::String(result.batch_hash.clone())),
        (
            "entityNonce".into(),
            safe_number(result.entity_nonce, "ENTITY_NONCE")?,
        ),
        (
            "batchGeneration".into(),
            safe_number(result.batch_generation, "BATCH_GENERATION")?,
        ),
        ("attemptId".into(), Value::String(result.attempt_id.clone())),
        (
            "attemptNumber".into(),
            safe_number(result.attempt_number, "ATTEMPT_NUMBER")?,
        ),
        (
            "attemptedAt".into(),
            safe_number(result.attempted_at, "ATTEMPTED_AT")?,
        ),
        (
            "outcome".into(),
            Value::String(result.outcome.text().into()),
        ),
    ]);
    if let Some(v) = &result.message {
        data.insert("message".into(), Value::String(v.clone()));
    }
    if let Some(v) = &result.adapter_failure {
        data.insert(
            "adapterFailure".into(),
            json!({"category":v.category,"code":v.code,"message":v.message}),
        );
    }
    if let Some(v) = &result.transaction_hash {
        data.insert("txHash".into(), Value::String(v.clone()));
    }
    Ok(Value::Object(data))
}

pub fn encode_retry_j_submit(value: &RetryJSubmitData) -> Result<Value, JSubmitLifecycleError> {
    let mut data = Map::from_iter([
        ("entityId".into(), Value::String(value.entity_id.clone())),
        ("signerId".into(), Value::String(value.signer_id.clone())),
        (
            "jurisdictionName".into(),
            Value::String(value.jurisdiction_name.clone()),
        ),
        ("batchHash".into(), Value::String(value.batch_hash.clone())),
        (
            "entityNonce".into(),
            safe_number(value.entity_nonce, "ENTITY_NONCE")?,
        ),
        (
            "batchGeneration".into(),
            safe_number(value.batch_generation, "BATCH_GENERATION")?,
        ),
    ]);
    if let Some(fees) = &value.fee_overrides {
        data.insert("feeOverrides".into(), fee_value(fees));
    }
    Ok(json!({"type":"retryJSubmit","data":Value::Object(data)}))
}

pub fn encode_j_submit_result(value: &JSubmitResultData) -> Result<Value, JSubmitLifecycleError> {
    Ok(json!({"type":"recordJSubmitResult","data":result_data_value(value)?}))
}

pub(crate) fn decode_retry(value: &Value) -> Result<RetryJSubmitData, JSubmitLifecycleError> {
    let data = value.as_object().ok_or_else(|| error("RETRY_DATA"))?;
    Ok(RetryJSubmitData {
        entity_id: string(data, "entityId")?,
        signer_id: string(data, "signerId")?,
        jurisdiction_name: string(data, "jurisdictionName")?,
        batch_hash: string(data, "batchHash")?,
        entity_nonce: field_u64(data, "entityNonce")?,
        batch_generation: field_u64(data, "batchGeneration")?,
        fee_overrides: data.get("feeOverrides").map(decode_fee_value).transpose()?,
    })
}
pub(crate) fn decode_result(value: &Value) -> Result<JSubmitResultData, JSubmitLifecycleError> {
    let data = value.as_object().ok_or_else(|| error("RESULT_DATA"))?;
    Ok(JSubmitResultData {
        entity_id: string(data, "entityId")?,
        signer_id: string(data, "signerId")?,
        jurisdiction_name: string(data, "jurisdictionName")?,
        batch_hash: string(data, "batchHash")?,
        entity_nonce: field_u64(data, "entityNonce")?,
        batch_generation: field_u64(data, "batchGeneration")?,
        attempt_id: string(data, "attemptId")?,
        attempt_number: field_u64(data, "attemptNumber")?,
        attempted_at: field_u64(data, "attemptedAt")?,
        outcome: JSubmitResultOutcome::parse(
            data.get("outcome")
                .and_then(Value::as_str)
                .ok_or_else(|| error("RESULT_OUTCOME"))?,
        )?,
        message: data
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
        adapter_failure: data
            .get("adapterFailure")
            .map(|value| {
                let failure = value
                    .as_object()
                    .ok_or_else(|| error("ADAPTER_FAILURE_OBJECT"))?;
                Ok(JAdapterFailure {
                    category: string(failure, "category")?,
                    code: string(failure, "code")?,
                    message: string(failure, "message")?,
                })
            })
            .transpose()?,
        transaction_hash: data
            .get("txHash")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
fn string(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<String, JSubmitLifecycleError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| error(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attempt_id_matches_typescript_safe_stringify_vector() {
        let retry = RetryJSubmitData {
            entity_id: "0xAA".into(),
            signer_id: "0xBB".into(),
            jurisdiction_name: " SimNet ".into(),
            batch_hash: "0xCC".into(),
            entity_nonce: 7,
            batch_generation: 2,
            fee_overrides: None,
        };
        assert_eq!(
            build_j_submit_attempt_id(&retry, 3).unwrap(),
            "0x2047f3483d082addbfc82718bafd220064fe1eb431f39e4f0337456aaec37889"
        );
    }

    #[test]
    fn reconciled_previous_batch_does_not_block_next_batch() {
        use xln_rscore_entity_kernel::{JBatch, JBatchState, JBatchStatus, SentJBatch};

        let mut replica = crate::machine::tests::replica(crate::RuntimeLimits::default())
            .expect("runtime replica");
        let entity_key = replica
            .e_replicas
            .keys()
            .next()
            .expect("entity key")
            .clone();
        let entity_id = entity_key.entity_id;
        let signer_id = entity_key.signer_id;
        let batch = JBatch::default();
        let encoded_batch = encode_j_batch(&batch).expect("encode batch");
        let batch_hash = [0x44; 32];
        let retry = RetryJSubmitData {
            entity_id: hex(&entity_id),
            signer_id: signer_id.clone(),
            jurisdiction_name: "SimNet".into(),
            batch_hash: hex(&batch_hash),
            entity_nonce: 8,
            batch_generation: 2,
            fee_overrides: None,
        };
        let (entity_state, entity_replica) = replica
            .entity_slot_mut(&entity_id, &signer_id)
            .expect("entity slot");
        entity_state.entity.j_batch_state = Some(JBatchState {
            broadcast_count: retry.batch_generation,
            status: JBatchStatus::Sent,
            sent_batch: Some(SentJBatch {
                batch,
                batch_hash,
                encoded_batch,
                entity_nonce: retry.entity_nonce,
                first_submitted_at: 100,
                last_submitted_at: 100,
                submit_attempts: 1,
                fee_overrides: None,
                transaction_hash: None,
                last_failure: None,
                terminal_failure: None,
            }),
            ..JBatchState::default()
        });
        // A quorum-shaped envelope (2-of-2) is not compacted at submission.
        let witness_hanko = xln_rscore_hanko::build_single_signer_hanko_envelope(
            &entity_id,
            &batch_hash,
            &[7_u8; 32],
            2,
            2,
            xln_rscore_hanko::BoardDelays::default(),
        )
        .expect("witness hanko");
        entity_replica.replica_metadata = json!({
            "entityId": retry.entity_id,
            "signerId": retry.signer_id,
            "isProposer": true,
            "hankoWitness": {
                "__xlnType": "Map",
                "value": [[retry.batch_hash, {
                    "hanko": hex(&witness_hanko),
                    "type": "jBatch",
                    "entityHeight": 1,
                    "createdAt": 100
                }]]
            },
            "jSubmitState": {
                "jurisdictionName": "SimNet",
                "batchHash": hex(&[0x33; 32]),
                "entityNonce": 7,
                "batchGeneration": 1,
                "submitAttempts": 9,
                "lastSubmittedAt": 100,
                "lastResultOutcome": "reconciled",
                "terminalFailure": {"stale": true},
                "resultFingerprints": {"old-attempt": "old-fingerprint"},
                "resultFingerprintOrder": ["old-attempt"]
            }
        });

        let attempt = apply_j_submit_retry(&mut replica, &retry, 101)
            .expect("retry")
            .expect("new batch attempt");
        assert_eq!(attempt.attempt_number, 1);
        assert_eq!(attempt.batch_hash, retry.batch_hash);
        let (_, entity_replica) = replica
            .entity_slot(&entity_id, &signer_id)
            .expect("updated entity slot");
        let submit_state = prior_submit_state(entity_replica).expect("submit state");
        assert_eq!(submit_state.get("lastResultOutcome"), None);
        assert_eq!(submit_state.get("terminalFailure"), None);
        assert_eq!(
            submit_state.get("resultFingerprintOrder"),
            Some(&json!(["old-attempt"]))
        );
        assert_eq!(
            submit_state.get("resultFingerprints"),
            Some(&json!({"old-attempt": "old-fingerprint"}))
        );
        assert_eq!(
            decode_pending_j_submit_attempts(replica.durable.infrastructure())
                .expect("pending attempts"),
            vec![attempt]
        );
    }
}
