use ethabi::ethereum_types::U256;
use serde_json::{Map, Number, Value, json};
use sha3::{Digest, Keccak256};
use xln_rscore_entity_kernel::{
    EntityProviderActionIntent, EntityProviderActionPayload,
    canonical_entity_provider_action_intent, decode_canonical_entity_provider_action_intent,
};

use crate::{RuntimeReplica, tagged_json_from_canonical_value};

use super::lifecycle::{
    JAdapterFailure, JSubmitLifecycleError, error, hanko_for_kind, infrastructure_pending_mut,
    metadata_object, normalize, pending_tx_type, stable_json,
};

const RETRY_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryEntityProviderActionData {
    pub entity_id: String,
    pub signer_id: String,
    pub jurisdiction_name: String,
    pub action_hash: String,
    pub action_nonce: U256,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableEntityProviderActionAttempt {
    pub jurisdiction_name: String,
    pub intent: EntityProviderActionIntent,
    pub signer_id: [u8; 20],
    pub hanko: Vec<u8>,
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityProviderActionResultOutcome {
    Submitted,
    TransientFailure,
    TerminalFailure,
    Reconciled,
}

impl EntityProviderActionResultOutcome {
    fn text(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::TransientFailure => "transientFailure",
            Self::TerminalFailure => "terminalFailure",
            Self::Reconciled => "reconciled",
        }
    }

    fn parse(value: &str) -> Result<Self, JSubmitLifecycleError> {
        match value {
            "submitted" => Ok(Self::Submitted),
            "transientFailure" => Ok(Self::TransientFailure),
            "terminalFailure" => Ok(Self::TerminalFailure),
            "reconciled" => Ok(Self::Reconciled),
            _ => Err(error("PROVIDER_RESULT_OUTCOME")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProviderActionResultData {
    pub entity_id: String,
    pub signer_id: String,
    pub jurisdiction_name: String,
    pub action_hash: String,
    pub action_nonce: U256,
    pub generation: u64,
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
    pub outcome: EntityProviderActionResultOutcome,
    pub message: Option<String>,
    pub adapter_failure: Option<JAdapterFailure>,
    pub transaction_hash: Option<String>,
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn fixed_hex<const N: usize>(value: &str, field: &str) -> Result<[u8; N], JSubmitLifecycleError> {
    let normalized = normalize(value);
    let bytes = hex::decode(normalized.strip_prefix("0x").ok_or_else(|| error(field))?)
        .map_err(|_| error(field))?;
    bytes.try_into().map_err(|_| error(field))
}

fn safe_number(value: u64, field: &str) -> Result<Value, JSubmitLifecycleError> {
    if value > 9_007_199_254_740_991 {
        return Err(error(format!("{field}_UNSAFE")));
    }
    Ok(Value::Number(Number::from(value)))
}

fn u256_value(value: U256) -> Value {
    json!({"__xlnType":"BigInt", "value":value.to_string()})
}

fn action_type(payload: &EntityProviderActionPayload) -> &'static str {
    match payload {
        EntityProviderActionPayload::Transfer { .. } => "entityProviderTransfer",
        EntityProviderActionPayload::ReleaseControlShares { .. } => {
            "entityProviderReleaseControlShares"
        }
        EntityProviderActionPayload::Cancel { .. } => "entityProviderCancelAction",
    }
}

pub fn build_entity_provider_action_attempt_id(
    retry: &RetryEntityProviderActionData,
    attempt_number: u64,
) -> Result<String, JSubmitLifecycleError> {
    if retry.generation == 0 || attempt_number == 0 || retry.action_nonce.is_zero() {
        return Err(error("ENTITY_PROVIDER_ACTION_ATTEMPT_IDENTITY_INVALID"));
    }
    let action_hash = normalize(&retry.action_hash);
    fixed_hex::<32>(&action_hash, "ENTITY_PROVIDER_ACTION_HASH")?;
    let value = json!({
        "domain":"xln/entity-provider-action-submit-attempt/v1",
        "jurisdictionName":normalize(&retry.jurisdiction_name),
        "entityId":normalize(&retry.entity_id),
        "signerId":normalize(&retry.signer_id),
        "actionHash":action_hash,
        "actionNonce":u256_value(retry.action_nonce),
        "generation":retry.generation,
        "attemptNumber":attempt_number,
    });
    Ok(hex(&Keccak256::digest(stable_json(&value)?.as_bytes())))
}

fn attempt_value(
    attempt: &DurableEntityProviderActionAttempt,
) -> Result<Value, JSubmitLifecycleError> {
    let intent = tagged_json_from_canonical_value(
        &canonical_entity_provider_action_intent(&attempt.intent)
            .map_err(|reason| error(reason.to_string()))?,
    )
    .map_err(|reason| error(reason.to_string()))?;
    Ok(json!({
        "jurisdictionName":attempt.jurisdiction_name,
        "jTxs":[{
            "type":action_type(&attempt.intent.payload),
            "entityId":attempt.intent.entity_id,
            "data":{
                "intent":intent,
                "signerId":hex(&attempt.signer_id),
                "hankoSignature":hex(&attempt.hanko),
                "runtimeSubmitAttempt":{
                    "attemptId":attempt.attempt_id,
                    "attemptNumber":attempt.attempt_number,
                    "attemptedAt":attempt.attempted_at,
                    "generation":attempt.intent.generation,
                }
            },
            "timestamp":attempt.attempted_at,
        }]
    }))
}

fn parse_attempt(
    value: &Value,
) -> Result<DurableEntityProviderActionAttempt, JSubmitLifecycleError> {
    let input = value
        .as_object()
        .ok_or_else(|| error("PROVIDER_PENDING_INPUT"))?;
    let jurisdiction_name = input
        .get("jurisdictionName")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PROVIDER_PENDING_JURISDICTION"))?
        .to_string();
    let tx = input
        .get("jTxs")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
        .ok_or_else(|| error("PROVIDER_PENDING_TX"))?;
    let kind = tx
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PROVIDER_PENDING_TYPE"))?;
    let entity_id = tx
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| error("PROVIDER_PENDING_ENTITY"))?;
    let data = tx
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| error("PROVIDER_PENDING_DATA"))?;
    let canonical = crate::canonical_value_from_tagged_json(
        data.get("intent")
            .ok_or_else(|| error("PROVIDER_PENDING_INTENT"))?,
    )
    .map_err(|reason| error(reason.to_string()))?;
    let intent = decode_canonical_entity_provider_action_intent(&canonical)
        .map_err(|reason| error(reason.to_string()))?;
    if normalize(entity_id) != normalize(&intent.entity_id) || kind != action_type(&intent.payload)
    {
        return Err(error("PROVIDER_PENDING_INTENT_BINDING"));
    }
    let metadata = data
        .get("runtimeSubmitAttempt")
        .and_then(Value::as_object)
        .ok_or_else(|| error("PROVIDER_PENDING_ATTEMPT"))?;
    let read_u64 = |source: &Map<String, Value>, field: &str| {
        source
            .get(field)
            .and_then(Value::as_u64)
            .ok_or_else(|| error(format!("PROVIDER_PENDING_{field}")))
    };
    let attempt = DurableEntityProviderActionAttempt {
        jurisdiction_name,
        intent,
        signer_id: fixed_hex(
            data.get("signerId")
                .and_then(Value::as_str)
                .ok_or_else(|| error("PROVIDER_PENDING_SIGNER"))?,
            "PROVIDER_PENDING_SIGNER",
        )?,
        hanko: hex::decode(
            normalize(
                data.get("hankoSignature")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PROVIDER_PENDING_HANKO"))?,
            )
            .strip_prefix("0x")
            .ok_or_else(|| error("PROVIDER_PENDING_HANKO"))?,
        )
        .map_err(|_| error("PROVIDER_PENDING_HANKO"))?,
        attempt_id: metadata
            .get("attemptId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("PROVIDER_PENDING_ATTEMPT_ID"))?
            .to_string(),
        attempt_number: read_u64(metadata, "attemptNumber")?,
        attempted_at: read_u64(metadata, "attemptedAt")?,
    };
    if read_u64(metadata, "generation")? != attempt.intent.generation {
        return Err(error("PROVIDER_PENDING_GENERATION"));
    }
    let retry = RetryEntityProviderActionData {
        entity_id: attempt.intent.entity_id.clone(),
        signer_id: hex(&attempt.signer_id),
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        action_hash: hex(&attempt.intent.action_hash),
        action_nonce: attempt.intent.action_nonce,
        generation: attempt.intent.generation,
    };
    if attempt.attempt_id
        != build_entity_provider_action_attempt_id(&retry, attempt.attempt_number)?
    {
        return Err(error("PROVIDER_PENDING_ATTEMPT_ID_MISMATCH"));
    }
    Ok(attempt)
}

pub fn decode_pending_entity_provider_attempts(
    infrastructure: &Value,
) -> Result<Vec<DurableEntityProviderActionAttempt>, JSubmitLifecycleError> {
    let Some(rows) = infrastructure
        .as_object()
        .and_then(|value| value.get("pendingCommittedJOutbox"))
    else {
        return Ok(Vec::new());
    };
    rows.as_array()
        .ok_or_else(|| error("PENDING_ARRAY"))?
        .iter()
        .filter_map(|value| match pending_tx_type(value) {
            Ok(
                "entityProviderTransfer"
                | "entityProviderReleaseControlShares"
                | "entityProviderCancelAction",
            ) => Some(parse_attempt(value)),
            Ok(_) => None,
            Err(reason) => Some(Err(reason)),
        })
        .collect()
}

fn prior_state(replica: &crate::RuntimeEntityReplica) -> Option<Map<String, Value>> {
    replica
        .replica_metadata()
        .as_object()?
        .get("entityProviderActionSubmitState")?
        .as_object()
        .cloned()
}

pub fn apply_entity_provider_action_retry(
    replica: &mut RuntimeReplica,
    retry: &RetryEntityProviderActionData,
    timestamp: u64,
) -> Result<Option<DurableEntityProviderActionAttempt>, JSubmitLifecycleError> {
    let entity_id = fixed_hex(&retry.entity_id, "PROVIDER_ENTITY")?;
    let (state, live) = replica
        .entity_slot(&entity_id, &retry.signer_id)
        .ok_or_else(|| error("PROVIDER_LOCAL_REPLICA_MISSING"))?;
    if normalize(
        &live
            .entity_consensus
            .state
            .authority
            .leader_state
            .active_validator_id,
    ) != normalize(&retry.signer_id)
    {
        return Err(error("PROVIDER_NOT_ACTIVE_LEADER"));
    }
    let Some(intent) = state
        .entity
        .entity_provider_action_state
        .as_ref()
        .and_then(|value| value.pending.as_ref())
    else {
        return Ok(None);
    };
    if normalize(&intent.entity_id) != normalize(&retry.entity_id)
        || hex(&intent.action_hash) != normalize(&retry.action_hash)
        || intent.action_nonce != retry.action_nonce
        || intent.generation != retry.generation
    {
        return Ok(None);
    }
    let signer_id = fixed_hex(&retry.signer_id, "PROVIDER_SIGNER")?;
    if decode_pending_entity_provider_attempts(replica.durable.infrastructure())?
        .iter()
        .any(|attempt| {
            normalize(&attempt.jurisdiction_name) == normalize(&retry.jurisdiction_name)
                && normalize(&attempt.intent.entity_id) == normalize(&retry.entity_id)
                && attempt.signer_id == signer_id
                && attempt.intent.action_hash == intent.action_hash
                && attempt.intent.action_nonce == retry.action_nonce
                && attempt.intent.generation == retry.generation
        })
    {
        return Ok(None);
    }
    let previous = prior_state(live).filter(|value| {
        value
            .get("actionHash")
            .and_then(Value::as_str)
            .map(normalize)
            == Some(normalize(&retry.action_hash))
            && value.get("generation").and_then(Value::as_u64) == Some(retry.generation)
    });
    if previous
        .as_ref()
        .and_then(|value| value.get("terminalFailure"))
        .is_some()
    {
        return Ok(None);
    }
    let attempts = previous
        .as_ref()
        .and_then(|value| value.get("submitAttempts"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let last = previous
        .as_ref()
        .and_then(|value| value.get("lastSubmittedAt"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if attempts > 0 && timestamp < last.saturating_add(RETRY_MS) {
        return Ok(None);
    }
    let attempt_number = attempts
        .checked_add(1)
        .ok_or_else(|| error("PROVIDER_ATTEMPT_OVERFLOW"))?;
    let attempt = DurableEntityProviderActionAttempt {
        jurisdiction_name: retry.jurisdiction_name.clone(),
        intent: intent.clone(),
        signer_id,
        hanko: hanko_for_kind(live, &retry.action_hash, "entityProviderAction")?,
        attempt_id: build_entity_provider_action_attempt_id(retry, attempt_number)?,
        attempt_number,
        attempted_at: timestamp,
    };
    infrastructure_pending_mut(&mut replica.durable)?.push(attempt_value(&attempt)?);
    replica.durable.invalidate_infrastructure_digest();
    let mut local = previous.unwrap_or_default();
    local.insert(
        "jurisdictionName".into(),
        Value::String(retry.jurisdiction_name.clone()),
    );
    local.insert(
        "actionHash".into(),
        Value::String(normalize(&retry.action_hash)),
    );
    local.insert("actionNonce".into(), u256_value(retry.action_nonce));
    local.insert(
        "generation".into(),
        safe_number(retry.generation, "PROVIDER_GENERATION")?,
    );
    local.insert(
        "submitAttempts".into(),
        safe_number(attempt_number, "PROVIDER_ATTEMPT")?,
    );
    local.insert(
        "lastSubmittedAt".into(),
        safe_number(timestamp, "PROVIDER_TIMESTAMP")?,
    );
    let (_, live) = replica
        .entity_slot_mut(&entity_id, &retry.signer_id)
        .ok_or_else(|| error("PROVIDER_LOCAL_REPLICA_MISSING"))?;
    metadata_object(live)?.insert(
        "entityProviderActionSubmitState".into(),
        Value::Object(local),
    );
    Ok(Some(attempt))
}

pub fn encode_retry_entity_provider_action(
    value: &RetryEntityProviderActionData,
) -> Result<Value, JSubmitLifecycleError> {
    Ok(json!({
        "type":"retryEntityProviderAction",
        "data":{
            "entityId":normalize(&value.entity_id), "signerId":normalize(&value.signer_id),
            "jurisdictionName":value.jurisdiction_name, "actionHash":normalize(&value.action_hash),
            "actionNonce":u256_value(value.action_nonce), "generation":value.generation,
        }
    }))
}

fn decode_u256(value: &Value, field: &str) -> Result<U256, JSubmitLifecycleError> {
    let tagged = value.as_object().ok_or_else(|| error(field))?;
    if tagged.len() != 2 || tagged.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(error(field));
    }
    U256::from_dec_str(
        tagged
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| error(field))?,
    )
    .map_err(|_| error(field))
}

pub(crate) fn decode_retry_entity_provider_action(
    value: &Value,
) -> Result<RetryEntityProviderActionData, JSubmitLifecycleError> {
    let data = value
        .as_object()
        .ok_or_else(|| error("PROVIDER_RETRY_OBJECT"))?;
    const FIELDS: &[&str] = &[
        "entityId",
        "signerId",
        "jurisdictionName",
        "actionHash",
        "actionNonce",
        "generation",
    ];
    if data.len() != FIELDS.len() || data.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(error("PROVIDER_RETRY_FIELDS"));
    }
    let string = |name: &str| {
        data.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| error(format!("PROVIDER_RETRY_{name}")))
    };
    let decoded = RetryEntityProviderActionData {
        entity_id: string("entityId")?,
        signer_id: string("signerId")?,
        jurisdiction_name: string("jurisdictionName")?,
        action_hash: string("actionHash")?,
        action_nonce: decode_u256(
            data.get("actionNonce")
                .ok_or_else(|| error("PROVIDER_RETRY_NONCE"))?,
            "PROVIDER_RETRY_NONCE",
        )?,
        generation: data
            .get("generation")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
            .ok_or_else(|| error("PROVIDER_RETRY_GENERATION"))?,
    };
    fixed_hex::<32>(&decoded.entity_id, "PROVIDER_RETRY_ENTITY")?;
    fixed_hex::<20>(&decoded.signer_id, "PROVIDER_RETRY_SIGNER")?;
    fixed_hex::<32>(&decoded.action_hash, "PROVIDER_RETRY_HASH")?;
    if decoded.action_nonce.is_zero() {
        return Err(error("PROVIDER_RETRY_NONCE"));
    }
    Ok(decoded)
}

fn result_value(result: &EntityProviderActionResultData) -> Result<Value, JSubmitLifecycleError> {
    let mut data = Map::from_iter([
        (
            "entityId".into(),
            Value::String(normalize(&result.entity_id)),
        ),
        (
            "signerId".into(),
            Value::String(normalize(&result.signer_id)),
        ),
        (
            "jurisdictionName".into(),
            Value::String(result.jurisdiction_name.clone()),
        ),
        (
            "actionHash".into(),
            Value::String(normalize(&result.action_hash)),
        ),
        ("actionNonce".into(), u256_value(result.action_nonce)),
        (
            "generation".into(),
            safe_number(result.generation, "PROVIDER_RESULT_GENERATION")?,
        ),
        ("attemptId".into(), Value::String(result.attempt_id.clone())),
        (
            "attemptNumber".into(),
            safe_number(result.attempt_number, "PROVIDER_RESULT_ATTEMPT")?,
        ),
        (
            "attemptedAt".into(),
            safe_number(result.attempted_at, "PROVIDER_RESULT_TIME")?,
        ),
        (
            "outcome".into(),
            Value::String(result.outcome.text().into()),
        ),
    ]);
    if let Some(message) = &result.message {
        data.insert("message".into(), Value::String(message.clone()));
    }
    if let Some(hash) = &result.transaction_hash {
        data.insert("txHash".into(), Value::String(normalize(hash)));
    }
    if let Some(failure) = &result.adapter_failure {
        data.insert(
            "adapterFailure".into(),
            json!({
                "category":failure.category, "code":failure.code, "message":failure.message,
            }),
        );
    }
    Ok(Value::Object(data))
}

pub fn encode_entity_provider_action_result(
    result: &EntityProviderActionResultData,
) -> Result<Value, JSubmitLifecycleError> {
    Ok(json!({"type":"recordEntityProviderActionSubmitResult", "data":result_value(result)?}))
}

pub(crate) fn decode_entity_provider_action_result(
    value: &Value,
) -> Result<EntityProviderActionResultData, JSubmitLifecycleError> {
    let data = value
        .as_object()
        .ok_or_else(|| error("PROVIDER_RESULT_OBJECT"))?;
    let string = |name: &str| {
        data.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| error(format!("PROVIDER_RESULT_{name}")))
    };
    let number = |name: &str| {
        data.get(name)
            .and_then(Value::as_u64)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| error(format!("PROVIDER_RESULT_{name}")))
    };
    let adapter_failure = data
        .get("adapterFailure")
        .map(|value| {
            let value = value
                .as_object()
                .ok_or_else(|| error("PROVIDER_RESULT_FAILURE"))?;
            Ok(JAdapterFailure {
                category: value
                    .get("category")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PROVIDER_RESULT_FAILURE_CATEGORY"))?
                    .into(),
                code: value
                    .get("code")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PROVIDER_RESULT_FAILURE_CODE"))?
                    .into(),
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("PROVIDER_RESULT_FAILURE_MESSAGE"))?
                    .into(),
            })
        })
        .transpose()?;
    Ok(EntityProviderActionResultData {
        entity_id: string("entityId")?,
        signer_id: string("signerId")?,
        jurisdiction_name: string("jurisdictionName")?,
        action_hash: string("actionHash")?,
        action_nonce: decode_u256(
            data.get("actionNonce")
                .ok_or_else(|| error("PROVIDER_RESULT_NONCE"))?,
            "PROVIDER_RESULT_NONCE",
        )?,
        generation: number("generation")?,
        attempt_id: string("attemptId")?,
        attempt_number: number("attemptNumber")?,
        attempted_at: number("attemptedAt")?,
        outcome: EntityProviderActionResultOutcome::parse(&string("outcome")?)?,
        message: data
            .get("message")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| error("PROVIDER_RESULT_MESSAGE"))
            })
            .transpose()?,
        adapter_failure,
        transaction_hash: data
            .get("txHash")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| error("PROVIDER_RESULT_TX_HASH"))
            })
            .transpose()?,
    })
}

fn remove_pending_provider_attempt(
    replica: &mut RuntimeReplica,
    attempt_id: &str,
) -> Result<bool, JSubmitLifecycleError> {
    let rows = infrastructure_pending_mut(&mut replica.durable)?;
    let matches = rows
        .iter()
        .enumerate()
        .filter_map(|(index, value)| match pending_tx_type(value) {
            Ok(
                "entityProviderTransfer"
                | "entityProviderReleaseControlShares"
                | "entityProviderCancelAction",
            ) => Some(parse_attempt(value).map(|attempt| (index, attempt))),
            Ok(_) => None,
            Err(reason) => Some(Err(reason)),
        })
        .filter_map(|row| match row {
            Ok((index, attempt)) if attempt.attempt_id == attempt_id => Some(Ok(index)),
            Ok(_) => None,
            Err(reason) => Some(Err(reason)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let [index] = matches.as_slice() else {
        return if matches.is_empty() {
            Ok(false)
        } else {
            Err(error("PROVIDER_PENDING_DUPLICATED"))
        };
    };
    rows.remove(*index);
    replica.durable.invalidate_infrastructure_digest();
    Ok(true)
}

pub fn apply_entity_provider_action_result(
    replica: &mut RuntimeReplica,
    result: &EntityProviderActionResultData,
    timestamp: u64,
) -> Result<(), JSubmitLifecycleError> {
    let retry = RetryEntityProviderActionData {
        entity_id: result.entity_id.clone(),
        signer_id: result.signer_id.clone(),
        jurisdiction_name: result.jurisdiction_name.clone(),
        action_hash: result.action_hash.clone(),
        action_nonce: result.action_nonce,
        generation: result.generation,
    };
    if result.attempt_id != build_entity_provider_action_attempt_id(&retry, result.attempt_number)?
    {
        return Err(error("PROVIDER_RESULT_ATTEMPT_ID_MISMATCH"));
    }
    if let Some(failure) = &result.adapter_failure {
        let expected = if failure.category == "transient" {
            EntityProviderActionResultOutcome::TransientFailure
        } else if failure.category == "terminal" {
            EntityProviderActionResultOutcome::TerminalFailure
        } else {
            return Err(error("PROVIDER_RESULT_FAILURE_CATEGORY"));
        };
        if result.outcome != expected
            || result.message.as_deref() != Some(failure.message.as_str())
            || failure.code.is_empty()
        {
            return Err(error("PROVIDER_RESULT_FAILURE_MISMATCH"));
        }
    }
    let fingerprint = stable_json(&result_value(result)?)?;
    let entity_id = fixed_hex(&result.entity_id, "PROVIDER_RESULT_ENTITY")?;
    let (state, live) = replica
        .entity_slot(&entity_id, &result.signer_id)
        .ok_or_else(|| error("PROVIDER_RESULT_LOCAL_REPLICA_MISSING"))?;
    let mut local =
        prior_state(live).ok_or_else(|| error("PROVIDER_RESULT_LOCAL_STATE_MISSING"))?;
    if let Some(existing) = local
        .get("resultFingerprints")
        .and_then(Value::as_object)
        .and_then(|journal| journal.get(&result.attempt_id))
        .and_then(Value::as_str)
    {
        return if existing == fingerprint {
            Ok(())
        } else {
            Err(error("PROVIDER_RESULT_DUPLICATE_CONFLICT"))
        };
    }
    let pending = decode_pending_entity_provider_attempts(replica.durable.infrastructure())?
        .into_iter()
        .filter(|attempt| attempt.attempt_id == result.attempt_id)
        .collect::<Vec<_>>();
    let [pending] = pending.as_slice() else {
        return Err(error(if pending.is_empty() {
            "PROVIDER_RESULT_PENDING_MISSING"
        } else {
            "PROVIDER_RESULT_PENDING_DUPLICATED"
        }));
    };
    if normalize(&pending.jurisdiction_name) != normalize(&result.jurisdiction_name)
        || normalize(&pending.intent.entity_id) != normalize(&result.entity_id)
        || pending.signer_id != fixed_hex(&result.signer_id, "PROVIDER_RESULT_SIGNER")?
        || pending.intent.action_hash != fixed_hex(&result.action_hash, "PROVIDER_RESULT_HASH")?
        || pending.intent.action_nonce != result.action_nonce
        || pending.intent.generation != result.generation
        || pending.attempt_number != result.attempt_number
        || pending.attempted_at != result.attempted_at
    {
        return Err(error("PROVIDER_RESULT_PENDING_CONFLICT"));
    }
    let consensus_matches = state
        .entity
        .entity_provider_action_state
        .as_ref()
        .and_then(|value| value.pending.as_ref())
        .is_some_and(|intent| {
            intent.action_hash == pending.intent.action_hash
                && intent.action_nonce == result.action_nonce
                && intent.generation == result.generation
        });
    if !consensus_matches {
        remove_pending_provider_attempt(replica, &result.attempt_id)?;
        return Ok(());
    }
    if local
        .get("actionHash")
        .and_then(Value::as_str)
        .map(normalize)
        != Some(normalize(&result.action_hash))
        || local.get("generation").and_then(Value::as_u64) != Some(result.generation)
        || local.get("submitAttempts").and_then(Value::as_u64) != Some(result.attempt_number)
        || local.get("lastSubmittedAt").and_then(Value::as_u64) != Some(result.attempted_at)
    {
        return Err(error("PROVIDER_RESULT_ATTEMPT_MISMATCH"));
    }
    let mut journal = local
        .get("resultFingerprints")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut order = local
        .get("resultFingerprintOrder")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    order.retain(|value| value.as_str() != Some(&result.attempt_id));
    order.push(Value::String(result.attempt_id.clone()));
    while order.len() > 256 {
        let removed = order
            .remove(0)
            .as_str()
            .ok_or_else(|| error("PROVIDER_RESULT_JOURNAL_ID"))?
            .to_string();
        journal.remove(&removed);
    }
    journal.insert(
        result.attempt_id.clone(),
        Value::String(fingerprint.clone()),
    );
    local.insert("resultFingerprints".into(), Value::Object(journal));
    local.insert("resultFingerprintOrder".into(), Value::Array(order));
    local.insert(
        "lastResultAttemptId".into(),
        Value::String(result.attempt_id.clone()),
    );
    local.insert(
        "lastResultAt".into(),
        safe_number(timestamp, "PROVIDER_RESULT_AT")?,
    );
    local.insert(
        "lastResultOutcome".into(),
        Value::String(result.outcome.text().into()),
    );
    local.insert("lastResultFingerprint".into(), Value::String(fingerprint));
    match result.outcome {
        EntityProviderActionResultOutcome::Submitted
        | EntityProviderActionResultOutcome::Reconciled => {
            local.remove("lastFailure");
            if let Some(hash) = &result.transaction_hash {
                local.insert("txHash".into(), Value::String(normalize(hash)));
            }
        }
        EntityProviderActionResultOutcome::TransientFailure
        | EntityProviderActionResultOutcome::TerminalFailure => {
            let failure = json!({"message":result.message.as_deref().unwrap_or("unknown"), "failedAt":timestamp,
                "adapterFailure":result.adapter_failure.as_ref().map(|value| json!({"category":value.category,"code":value.code,"message":value.message}))});
            local.insert("lastFailure".into(), failure.clone());
            if result.outcome == EntityProviderActionResultOutcome::TerminalFailure {
                local.insert("terminalFailure".into(), failure);
            }
        }
    }
    remove_pending_provider_attempt(replica, &result.attempt_id)?;
    let (_, live) = replica
        .entity_slot_mut(&entity_id, &result.signer_id)
        .ok_or_else(|| error("PROVIDER_RESULT_LOCAL_REPLICA_MISSING"))?;
    metadata_object(live)?.insert(
        "entityProviderActionSubmitState".into(),
        Value::Object(local),
    );
    Ok(())
}
