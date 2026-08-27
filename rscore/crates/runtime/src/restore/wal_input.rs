//! Exact canonical RuntimeInput decoder shared by replay and native restart.

use serde_json::{Map, Value};
use thiserror::Error;

use crate::{
    RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, canonical_value_from_tagged_json,
    decode_entity_deterministic_context,
};

use super::{ConcreteWalSource, DecodedRuntimeWalFrame, verify_wal_source};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum ConcreteWalDecodeError {
    #[error("RRS_RESTORE_WAL_DECODE:{0}")]
    Invalid(String),
}

fn invalid(detail: impl Into<String>) -> ConcreteWalDecodeError {
    ConcreteWalDecodeError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, ConcreteWalDecodeError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], ConcreteWalDecodeError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("ARRAY:{path}")))
}

fn field<'a>(
    value: &'a Value,
    name: &str,
    path: &str,
) -> Result<&'a Value, ConcreteWalDecodeError> {
    object(value, path)?
        .get(name)
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn safe_unsigned(value: &Value, path: &str) -> Result<u64, ConcreteWalDecodeError> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn digest(value: &Value, path: &str) -> Result<[u8; 32], ConcreteWalDecodeError> {
    let raw = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| invalid(format!("DIGEST:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("DIGEST:{path}")))?;
    }
    Ok(output)
}

fn validate_runtime_input_fields(value: &Map<String, Value>) -> Result<(), ConcreteWalDecodeError> {
    for name in value.keys() {
        if !matches!(
            name.as_str(),
            "runtimeTxs" | "entityInputs" | "jInputs" | "timestamp" | "queuedAt"
        ) {
            return Err(invalid(format!("RUNTIME_INPUT_FIELD:{name}")));
        }
    }
    for name in ["runtimeTxs", "entityInputs"] {
        if !value.contains_key(name) {
            return Err(invalid(format!("RUNTIME_INPUT_FIELD_MISSING:{name}")));
        }
    }
    Ok(())
}

fn unsupported_kind(value: &Value, lane: &str, index: usize) -> String {
    value
        .as_object()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{lane}[{index}]"))
}

fn expected_entity_root(frame: &Value) -> Result<[u8; 32], ConcreteWalDecodeError> {
    let rows = array(
        field(frame, "canonicalEntityHashes", "frame")?,
        "frame.canonicalEntityHashes",
    )?;
    if rows.len() != 1 {
        return Err(invalid(format!("ENTITY_HASH_COUNT:{}", rows.len())));
    }
    digest(
        field(&rows[0], "hash", "frame.canonicalEntityHashes[0]")?,
        "entityRoot",
    )
}

/// Decode one authenticated frame/context pair without consulting TypeScript
/// or an execution oracle. Invalid Runtime/J lanes fail loudly until their
/// native transitions exist; they are never carried through as opaque state.
pub fn decode_concrete_runtime_wal_frame(
    source: &ConcreteWalSource,
    context_policy: &Value,
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
) -> Result<DecodedRuntimeWalFrame, ConcreteWalDecodeError> {
    let frame = verify_wal_source(source).map_err(|error| invalid(error.to_string()))?;
    let height = safe_unsigned(field(&frame, "height", "frame")?, "frame.height")?;
    let timestamp = safe_unsigned(field(&frame, "timestamp", "frame")?, "frame.timestamp")?;
    let runtime_input = field(&frame, "runtimeInput", "frame")?;
    let runtime_input_object = object(runtime_input, "frame.runtimeInput")?;
    validate_runtime_input_fields(runtime_input_object)?;
    let runtime_txs = array(
        field(runtime_input, "runtimeTxs", "frame.runtimeInput")?,
        "runtimeTxs",
    )?;
    if let Some((index, tx)) = runtime_txs.iter().enumerate().next() {
        return Err(invalid(format!(
            "RUNTIME_TX_UNSUPPORTED:{height}:{index}:{}",
            unsupported_kind(tx, "runtimeTxs", index)
        )));
    }
    if let Some(j_inputs) = runtime_input_object.get("jInputs") {
        let rows = array(j_inputs, "frame.runtimeInput.jInputs")?;
        if let Some((index, input)) = rows.iter().enumerate().next() {
            return Err(invalid(format!(
                "J_INPUT_UNSUPPORTED:{height}:{index}:{}",
                unsupported_kind(input, "jInputs", index)
            )));
        }
    }
    if source.entity_contexts.len() != 1 {
        return Err(invalid(format!(
            "ENTITY_CONTEXT_COUNT:{height}:{}",
            source.entity_contexts.len()
        )));
    }
    let context = &source
        .entity_contexts
        .values()
        .next()
        .ok_or_else(|| invalid("ENTITY_CONTEXT_MISSING"))?
        .value;
    let entity_inputs = array(
        field(runtime_input, "entityInputs", "frame.runtimeInput")?,
        "entityInputs",
    )?
    .iter()
    .enumerate()
    .map(|(index, input)| {
        RuntimeEntityInput::decode(input.clone())
            .map_err(|error| invalid(format!("ENTITY_INPUT:{height}:{index}:{error}")))
    })
    .collect::<Result<Vec<_>, _>>()?;
    let canonical_entity_context = canonical_value_from_tagged_json(context)
        .map_err(|error| invalid(format!("ENTITY_CONTEXT_VALUE:{height}:{error}")))?;
    let entity_context = decode_entity_deterministic_context(context_policy, context)
        .map_err(|error| invalid(format!("ENTITY_CONTEXT:{height}:{error}")))?;
    let validated = crate::storage::native::validate_runtime_frame(&source.frame_bytes)
        .map_err(|error| invalid(error.to_string()))?;
    Ok(DecodedRuntimeWalFrame {
        height,
        timestamp,
        input: RuntimeInput {
            runtime_txs: Vec::new(),
            entity_inputs,
            frame: RuntimeFrameContext {
                timestamp,
                finalized_j_height,
                hub_rebalance_has_pending_work,
                entity_context,
                canonical_entity_context,
            },
        },
        expected_accounts_root: None,
        expected_entity_root: expected_entity_root(&frame)?,
        expected_previous_frame_hash: validated.prev_frame_hash,
        expected_frame_hash: validated.frame_hash,
    })
}

/// Remove one recorded occurrence for each identical input already resident
/// from a locally-generated continuation. Unmatched duplicates remain real.
pub fn reconcile_runtime_input_with_resident_queue<'a>(
    input: &mut RuntimeInput,
    resident: impl Iterator<Item = &'a Value>,
) -> usize {
    let mut resident = resident.collect::<Vec<_>>();
    let mut reused = 0;
    input.entity_inputs.retain(|candidate| {
        let Some(index) = resident
            .iter()
            .position(|queued| **queued == *candidate.canonical())
        else {
            return true;
        };
        resident.remove(index);
        reused += 1;
        false
    });
    reused
}
