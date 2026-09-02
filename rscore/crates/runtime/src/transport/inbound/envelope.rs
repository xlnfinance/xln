use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};

use crate::{RuntimeEntityInput, RuntimeFrameContext, RuntimeInput};

use super::super::RuntimeTransportError;
use super::super::msgpack::decode_transport;
use super::super::routing::normalize_runtime_id;

const MAX_ENTITY_INPUTS: usize = 10_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct InboundEntityInputs {
    pub peer_runtime_id: String,
    pub message_id: String,
    pub source_runtime_height: u64,
    pub source_runtime_timestamp: u64,
    pub ingress_timestamp: Option<u64>,
    pub entity_tx_count: u64,
    pub entity_inputs: Vec<RuntimeEntityInput>,
}

impl InboundEntityInputs {
    /// Move one authenticated transport batch into the single Runtime writer.
    /// Peer/message coordinates remain transport diagnostics; authenticated
    /// provenance is already embedded into each exact canonical EntityInput.
    pub fn into_runtime_input(self, frame: RuntimeFrameContext) -> RuntimeInput {
        RuntimeInput {
            runtime_txs: Vec::new(),
            entity_inputs: self.entity_inputs,
            frame,
        }
    }
}

pub(in crate::transport) fn typed_array(value: &Value) -> Result<Vec<u8>, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::MessagePack("typed-array-object".into()))?;
    exact_fields(object, &["__xlnType", "kind", "value"], &[], "typed-array")?;
    if object.get("__xlnType").and_then(Value::as_str) != Some("TypedArray")
        || object.get("kind").and_then(Value::as_str) != Some("Uint8Array")
    {
        return Err(RuntimeTransportError::MessagePack(
            "typed-array-kind".into(),
        ));
    }
    BASE64
        .decode(
            object
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| RuntimeTransportError::MessagePack("typed-array-value".into()))?,
        )
        .map_err(|_| RuntimeTransportError::MessagePack("typed-array-base64".into()))
}

pub(in crate::transport) fn decode_envelope(
    plaintext: &[u8],
    peer_runtime_id: &str,
    local_runtime_id: &str,
    message_id: String,
    ingress_timestamp: Option<u64>,
) -> Result<InboundEntityInputs, RuntimeTransportError> {
    let Value::Object(mut envelope) = decode_transport(plaintext)? else {
        return Err(RuntimeTransportError::Inbound("envelope-object".into()));
    };
    exact_fields(
        &envelope,
        &[
            "sourceRuntimeId",
            "sourceRuntimeHeight",
            "sourceRuntimeTimestamp",
            "entityInputs",
        ],
        &["sourceSignature", "atomicCrossJurisdictionPair"],
        "envelope",
    )?;
    let source_runtime_id = normalize_runtime_id(text(&envelope, "sourceRuntimeId")?)?;
    if source_runtime_id != peer_runtime_id {
        return Err(RuntimeTransportError::Inbound("source-runtime".into()));
    }
    if let Some(signature) = envelope.get("sourceSignature") {
        let signature = signature
            .as_str()
            .ok_or_else(|| RuntimeTransportError::Inbound("source-signature".into()))?;
        if signature.len() != 132
            || !signature.starts_with("0x")
            || !signature[2..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(RuntimeTransportError::Inbound("source-signature".into()));
        }
    }
    let source_runtime_height = safe_u64(&envelope, "sourceRuntimeHeight")?;
    let source_runtime_timestamp = safe_u64(&envelope, "sourceRuntimeTimestamp")?;
    let rows = envelope
        .remove("entityInputs")
        .and_then(|value| match value {
            Value::Array(rows) => Some(rows),
            _ => None,
        })
        .ok_or_else(|| RuntimeTransportError::Inbound("entity-inputs-array".into()))?;
    if rows.is_empty() || rows.len() > MAX_ENTITY_INPUTS {
        return Err(RuntimeTransportError::Inbound(format!(
            "entity-input-count:{}",
            rows.len()
        )));
    }
    let atomic_pair = decode_atomic_pair(&envelope, rows.len())?;
    let mut entity_inputs = Vec::with_capacity(rows.len());
    let mut entity_tx_count = 0_u64;
    for (index, row) in rows.into_iter().enumerate() {
        let Value::Object(mut row) = row else {
            return Err(RuntimeTransportError::Inbound(format!(
                "entity-input:{index}"
            )));
        };
        let row_tx_count =
            row.get("entityTxs")
                .map(|value| {
                    value.as_array().map(Vec::len).ok_or_else(|| {
                        RuntimeTransportError::Inbound(format!("entity-txs:{index}"))
                    })
                })
                .transpose()?
                .unwrap_or(0);
        entity_tx_count = entity_tx_count
            .checked_add(
                u64::try_from(row_tx_count)
                    .map_err(|_| RuntimeTransportError::Inbound("entity-tx-count".into()))?,
            )
            .ok_or_else(|| RuntimeTransportError::Inbound("entity-tx-count".into()))?;
        let target =
            normalize_runtime_id(row.get("runtimeId").and_then(Value::as_str).ok_or_else(
                || RuntimeTransportError::Inbound(format!("entity-target:{index}")),
            )?)?;
        if target != local_runtime_id {
            return Err(RuntimeTransportError::Inbound(format!(
                "entity-target:{index}"
            )));
        }
        row.insert("from".into(), Value::String(peer_runtime_id.into()));
        row.insert(
            "sourceRuntimeFrame".into(),
            Value::Object(Map::from_iter([
                ("height".into(), Value::from(source_runtime_height)),
                ("timestamp".into(), Value::from(source_runtime_timestamp)),
            ])),
        );
        if let Some(pair) = atomic_pair.as_ref() {
            row.insert("atomicCrossJurisdictionPair".into(), pair.clone());
        }
        entity_inputs.push(
            RuntimeEntityInput::decode(Value::Object(row)).map_err(|error| {
                RuntimeTransportError::Inbound(format!("entity-input:{index}:{error}"))
            })?,
        );
    }
    Ok(InboundEntityInputs {
        peer_runtime_id: peer_runtime_id.into(),
        message_id,
        source_runtime_height,
        source_runtime_timestamp,
        ingress_timestamp,
        entity_tx_count,
        entity_inputs,
    })
}

fn decode_atomic_pair(
    envelope: &Map<String, Value>,
    input_count: usize,
) -> Result<Option<Value>, RuntimeTransportError> {
    let Some(value) = envelope.get("atomicCrossJurisdictionPair") else {
        return Ok(None);
    };
    let pair = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Inbound("atomic-pair-object".into()))?;
    exact_fields(pair, &["phase", "pairKey"], &[], "atomic-pair")?;
    let phase = pair
        .get("phase")
        .and_then(Value::as_str)
        .filter(|phase| matches!(*phase, "proposal" | "ack"));
    let pair_key = pair
        .get("pairKey")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty());
    let (Some(phase), Some(pair_key)) = (phase, pair_key) else {
        return Err(RuntimeTransportError::Inbound("atomic-pair-invalid".into()));
    };
    if input_count != 2 {
        return Err(RuntimeTransportError::Inbound("atomic-pair-invalid".into()));
    }
    Ok(Some(Value::Object(Map::from_iter([
        ("phase".into(), Value::String(phase.to_owned())),
        ("pairKey".into(), Value::String(pair_key.to_owned())),
    ]))))
}

pub(in crate::transport) fn exact_fields(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    context: &str,
) -> Result<(), RuntimeTransportError> {
    for field in required {
        if !object.contains_key(*field) {
            return Err(RuntimeTransportError::Inbound(format!(
                "{context}-field:{field}"
            )));
        }
    }
    for field in object.keys() {
        if !required.contains(&field.as_str()) && !optional.contains(&field.as_str()) {
            return Err(RuntimeTransportError::Inbound(format!(
                "{context}-field:{field}"
            )));
        }
    }
    Ok(())
}

pub(in crate::transport) fn safe_u64(
    object: &Map<String, Value>,
    field: &str,
) -> Result<u64, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| RuntimeTransportError::Inbound(format!("{field}-integer")))
}

pub(in crate::transport) fn text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeTransportError::Inbound(format!("{field}-text")))
}
