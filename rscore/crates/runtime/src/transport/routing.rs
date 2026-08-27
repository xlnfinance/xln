use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::RuntimeTransportError;

const RUNTIME_ID_BYTES: usize = 20;
const ENTITY_ID_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectRoute {
    pub target_runtime_id: String,
    pub url: String,
}

#[derive(Clone, Debug, Default)]
pub struct DirectRouteTable(BTreeMap<String, String>);

impl DirectRouteTable {
    pub fn new(
        routes: impl IntoIterator<Item = DirectRoute>,
    ) -> Result<Self, RuntimeTransportError> {
        let mut output = BTreeMap::new();
        for route in routes {
            let target = normalize_runtime_id(&route.target_runtime_id)?;
            if !(route.url.starts_with("ws://") || route.url.starts_with("wss://")) {
                return Err(RuntimeTransportError::Route(format!("url:{}", route.url)));
            }
            if output.insert(target.clone(), route.url).is_some() {
                return Err(RuntimeTransportError::Route(format!("duplicate:{target}")));
            }
        }
        Ok(Self(output))
    }

    pub(super) fn url(&self, target: &str) -> Result<&str, RuntimeTransportError> {
        self.0
            .get(target)
            .map(String::as_str)
            .ok_or_else(|| RuntimeTransportError::Route(format!("missing:{target}")))
    }
}

#[derive(Clone, Debug)]
pub(super) struct OutboundEnvelope {
    pub target_runtime_id: String,
    pub source_height: u64,
    pub source_timestamp: u64,
    pub entity_id: Option<String>,
    pub transaction_count: u64,
    pub value: Value,
    pub row_count: usize,
}

pub(super) struct PreparedEnvelopeBatch {
    pub envelopes: Vec<OutboundEnvelope>,
    pub row_count: usize,
    pub bytes: usize,
}

type GroupKey = (String, u64, u64);

pub(super) fn prepare_envelopes(
    source_runtime_id: &str,
    rows: &[Vec<u8>],
    local_entity_signers: &BTreeMap<String, String>,
    max_rows: usize,
    max_plaintext_bytes: usize,
) -> Result<PreparedEnvelopeBatch, RuntimeTransportError> {
    let source = normalize_runtime_id(source_runtime_id)?;
    let mut groups = BTreeMap::<GroupKey, Vec<(usize, Value)>>::new();
    let mut remote_rows = 0_usize;
    let mut remote_bytes = 0_usize;
    for (index, row) in rows.iter().enumerate() {
        let value = crate::decode_storage_payload(row)
            .map_err(|error| RuntimeTransportError::Outbox(format!("row={index}:{error}")))?;
        let object = value
            .as_object()
            .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:object")))?;
        validate_output(object, index)?;
        if object.contains_key("atomicCrossJurisdictionPair") {
            return Err(RuntimeTransportError::Outbox(format!(
                "row={index}:cross-j-disabled"
            )));
        }
        let entity_id = normalize_entity_id(required_text(object, "entityId", index)?)?;
        let signer_id = required_text(object, "signerId", index)?.to_ascii_lowercase();
        let Some(target) = object.get("runtimeId") else {
            if local_entity_signers.get(&entity_id) != Some(&signer_id) {
                return Err(RuntimeTransportError::Outbox(format!(
                    "row={index}:local-route"
                )));
            }
            continue;
        };
        let target = normalize_runtime_id(
            target
                .as_str()
                .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:runtimeId")))?,
        )?;
        if target == source {
            return Err(RuntimeTransportError::Outbox(format!(
                "row={index}:self-route"
            )));
        }
        let frame = required_object(object, "sourceRuntimeFrame", index)?;
        let height = safe_u64(frame.get("height"), "height", index)?;
        let timestamp = safe_u64(frame.get("timestamp"), "timestamp", index)?;
        let mut deliverable = object.clone();
        deliverable.remove("sourceRuntimeFrame");
        deliverable.remove("atomicCrossJurisdictionPair");
        groups
            .entry((target, height, timestamp))
            .or_default()
            .push((index, Value::Object(deliverable)));
        remote_rows = remote_rows
            .checked_add(1)
            .ok_or_else(|| RuntimeTransportError::Outbox("row-count-overflow".into()))?;
        remote_bytes = remote_bytes
            .checked_add(row.len())
            .ok_or_else(|| RuntimeTransportError::Outbox("byte-overflow".into()))?;
    }

    let mut envelopes = Vec::new();
    for ((target, height, timestamp), values) in groups {
        let mut chunk = Vec::new();
        let mut raw_bytes = 0_usize;
        for (index, value) in values {
            let estimate = rows[index].len();
            if !chunk.is_empty()
                && (chunk.len() == max_rows
                    || raw_bytes.saturating_add(estimate) > max_plaintext_bytes)
            {
                envelopes.push(build_envelope(&source, &target, height, timestamp, chunk)?);
                chunk = Vec::new();
                raw_bytes = 0;
            }
            raw_bytes = raw_bytes
                .checked_add(estimate)
                .ok_or_else(|| RuntimeTransportError::Outbox("byte-overflow".into()))?;
            chunk.push(value);
        }
        if !chunk.is_empty() {
            envelopes.push(build_envelope(&source, &target, height, timestamp, chunk)?);
        }
    }
    Ok(PreparedEnvelopeBatch {
        envelopes,
        row_count: remote_rows,
        bytes: remote_bytes,
    })
}

fn build_envelope(
    source: &str,
    target: &str,
    height: u64,
    timestamp: u64,
    entity_inputs: Vec<Value>,
) -> Result<OutboundEnvelope, RuntimeTransportError> {
    let row_count = entity_inputs.len();
    let entity_id = (row_count == 1)
        .then(|| {
            entity_inputs[0]
                .get("entityId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    let transaction_count = entity_inputs.iter().try_fold(0_u64, |count, input| {
        let rows = input
            .get("entityTxs")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        count
            .checked_add(rows as u64)
            .ok_or_else(|| RuntimeTransportError::Outbox("tx-count-overflow".into()))
    })?;
    let value = Value::Object(Map::from_iter([
        ("sourceRuntimeId".into(), Value::String(source.to_owned())),
        ("sourceRuntimeHeight".into(), Value::from(height)),
        ("sourceRuntimeTimestamp".into(), Value::from(timestamp)),
        ("entityInputs".into(), Value::Array(entity_inputs)),
    ]));
    Ok(OutboundEnvelope {
        target_runtime_id: target.to_owned(),
        source_height: height,
        source_timestamp: timestamp,
        entity_id,
        transaction_count,
        value,
        row_count,
    })
}

fn validate_output(object: &Map<String, Value>, index: usize) -> Result<(), RuntimeTransportError> {
    required_text(object, "entityId", index)?;
    required_text(object, "signerId", index)?;
    let has_payload = [
        "entityTxs",
        "proposedFrame",
        "hashPrecommits",
        "jPrefixAttestations",
        "leaderTimeoutVote",
    ]
    .iter()
    .any(|field| object.contains_key(*field));
    if !has_payload {
        return Err(RuntimeTransportError::Outbox(format!("row={index}:empty")));
    }
    Ok(())
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<&'a str, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

fn required_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<&'a Map<String, Value>, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

fn safe_u64(
    value: Option<&Value>,
    field: &str,
    index: usize,
) -> Result<u64, RuntimeTransportError> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| RuntimeTransportError::Outbox(format!("row={index}:{field}")))
}

pub(super) fn normalize_runtime_id(value: &str) -> Result<String, RuntimeTransportError> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x").unwrap_or("");
    if body.len() != RUNTIME_ID_BYTES * 2 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RuntimeTransportError::Route(format!("runtime-id:{value}")));
    }
    Ok(normalized)
}

pub(super) fn normalize_entity_id(value: &str) -> Result<String, RuntimeTransportError> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x").unwrap_or("");
    if body.len() != ENTITY_ID_BYTES * 2 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RuntimeTransportError::Route(format!("entity-id:{value}")));
    }
    Ok(normalized)
}
