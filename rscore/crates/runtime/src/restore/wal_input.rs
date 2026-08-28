//! Exact canonical RuntimeInput decoder shared by replay and native restart.

use serde_json::{Map, Value};
use thiserror::Error;

use crate::{
    RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, RuntimeMempool, RuntimeTx,
    canonical_value_from_tagged_json, decode_entity_deterministic_context,
};

use super::{ConcreteWalSource, DecodedRuntimeWalFrame};

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

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), ConcreteWalDecodeError> {
    let missing = expected.iter().find(|field| !value.contains_key(**field));
    let extra = value
        .keys()
        .find(|field| !expected.contains(&field.as_str()));
    if missing.is_some() || extra.is_some() {
        return Err(invalid(format!(
            "FIELDS:{path}:missing={}:extra={}",
            missing.copied().unwrap_or("none"),
            extra.map(String::as_str).unwrap_or("none")
        )));
    }
    Ok(())
}

fn address(value: &Value, path: &str) -> Result<String, ConcreteWalDecodeError> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid(format!("ADDRESS:{path}")))?;
    let body = text.strip_prefix("0x").filter(|body| body.len() == 40);
    if !body.is_some_and(|body| body.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(invalid(format!("ADDRESS:{path}")));
    }
    Ok(text.to_owned())
}

fn decode_runtime_tx(value: &Value, index: usize) -> Result<RuntimeTx, ConcreteWalDecodeError> {
    let path = format!("runtimeTxs[{index}]");
    let tx = object(value, &path)?;
    exact_fields(tx, &["type", "data"], &path)?;
    let kind = tx["type"]
        .as_str()
        .ok_or_else(|| invalid(format!("STRING:{path}.type")))?;
    if kind != "advanceJWatcherCursor" {
        return Err(invalid(format!("RUNTIME_TX_UNSUPPORTED:{index}:{kind}")));
    }
    let data_path = format!("{path}.data");
    let data = object(&tx["data"], &data_path)?;
    exact_fields(
        data,
        &["depositoryAddress", "chainId", "blockNumber"],
        &data_path,
    )?;
    let chain_id = safe_unsigned(&data["chainId"], &format!("{data_path}.chainId"))?;
    if chain_id == 0 {
        return Err(invalid(format!("UNSIGNED:{data_path}.chainId")));
    }
    Ok(RuntimeTx::AdvanceJWatcherCursor {
        depository_address: address(
            &data["depositoryAddress"],
            &format!("{data_path}.depositoryAddress"),
        )?,
        chain_id,
        block_number: safe_unsigned(&data["blockNumber"], &format!("{data_path}.blockNumber"))?,
    })
}

fn expected_entity_root(frame: &Value) -> Result<Option<[u8; 32]>, ConcreteWalDecodeError> {
    let Some(value) = object(frame, "frame")?.get("canonicalEntityHashes") else {
        return Ok(None);
    };
    let rows = array(value, "frame.canonicalEntityHashes")?;
    if rows.len() != 1 {
        return Err(invalid(format!("ENTITY_HASH_COUNT:{}", rows.len())));
    }
    digest(
        field(&rows[0], "hash", "frame.canonicalEntityHashes[0]")?,
        "entityRoot",
    )
    .map(Some)
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
    let frame = source.frame();
    let height = safe_unsigned(field(&frame, "height", "frame")?, "frame.height")?;
    let timestamp = safe_unsigned(field(&frame, "timestamp", "frame")?, "frame.timestamp")?;
    let runtime_input = field(&frame, "runtimeInput", "frame")?;
    let runtime_input_object = object(runtime_input, "frame.runtimeInput")?;
    validate_runtime_input_fields(runtime_input_object)?;
    let runtime_txs = array(
        field(runtime_input, "runtimeTxs", "frame.runtimeInput")?,
        "runtimeTxs",
    )?;
    let runtime_txs = runtime_txs
        .iter()
        .enumerate()
        .map(|(index, tx)| {
            decode_runtime_tx(tx, index)
                .map_err(|error| invalid(format!("RUNTIME_TX:{height}:{index}:{error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(j_inputs) = runtime_input_object.get("jInputs") {
        let rows = array(j_inputs, "frame.runtimeInput.jInputs")?;
        if let Some((index, input)) = rows.iter().enumerate().next() {
            return Err(invalid(format!(
                "J_INPUT_UNSUPPORTED:{height}:{index}:{}",
                unsupported_kind(input, "jInputs", index)
            )));
        }
    }
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
    let entity_context_required = !entity_inputs.is_empty();
    if source.entity_contexts().len() > 1
        || (entity_context_required && source.entity_contexts().len() != 1)
    {
        return Err(invalid(format!(
            "ENTITY_CONTEXT_COUNT:{height}:{}",
            source.entity_contexts().len()
        )));
    }
    let (entity_context, canonical_entity_context) = match source.entity_contexts().values().next()
    {
        Some(context) => (
            decode_entity_deterministic_context(context_policy, &context.value)
                .map_err(|error| invalid(format!("ENTITY_CONTEXT:{height}:{error}")))?,
            canonical_value_from_tagged_json(&context.value)
                .map_err(|error| invalid(format!("ENTITY_CONTEXT_VALUE:{height}:{error}")))?,
        ),
        None => (
            xln_rscore_entity_kernel::DeterministicContext::hlt_default(),
            xln_rscore_protocol::CanonicalValue::Object(Vec::new()),
        ),
    };
    let validated = source.validated();
    Ok(DecodedRuntimeWalFrame {
        height,
        timestamp,
        input: RuntimeInput {
            runtime_txs,
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
        canonical_state_hash: validated.canonical_state_hash,
    })
}

/// Remove one resident occurrence for each byte-identical recorded input.
///
/// Exact replay must execute the recorded `RuntimeInput` in its original
/// causal order. A locally generated continuation is therefore consumed from
/// the RAM-only queue and replaced by its recorded occurrence at that exact
/// position. Removing the recorded row instead would move every resident row
/// ahead of newly recorded rows and change the Runtime frame hash.
pub fn reconcile_runtime_input_with_resident_queue(
    input: &RuntimeInput,
    resident: &mut RuntimeMempool,
) -> usize {
    let mut reused = 0;
    for candidate in &input.entity_inputs {
        let Some(index) = resident
            .entity_inputs
            .iter()
            .position(|queued| queued.canonical() == candidate.canonical())
        else {
            continue;
        };
        resident.entity_inputs.remove(index);
        reused += 1;
    }
    if resident.is_empty() {
        resident.queued_at = None;
    }
    reused
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use serde_json::json;
    use xln_rscore_entity_kernel::DeterministicContext;
    use xln_rscore_protocol::CanonicalValue;

    use super::*;

    fn entity_input(signer_id: &str) -> RuntimeEntityInput {
        RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": signer_id,
            "entityTxs": [],
        }))
        .expect("fixture input")
    }

    #[test]
    fn resident_occurrence_is_replaced_at_its_recorded_causal_position() {
        let first = entity_input("first");
        let resident_row = entity_input("resident");
        let expected = vec![first.canonical().clone(), resident_row.canonical().clone()];
        let mut input = RuntimeInput::empty_frame(
            7,
            0,
            DeterministicContext::hlt_default(),
            CanonicalValue::Object(Vec::new()),
        );
        input.entity_inputs = vec![first, resident_row.clone()];
        let mut resident = RuntimeMempool {
            runtime_txs: VecDeque::new(),
            entity_inputs: VecDeque::from([resident_row]),
            queued_at: Some(6),
        };

        assert_eq!(
            reconcile_runtime_input_with_resident_queue(&input, &mut resident),
            1
        );
        assert!(resident.entity_inputs.is_empty());
        assert_eq!(resident.queued_at, None);
        assert_eq!(
            input
                .entity_inputs
                .iter()
                .map(RuntimeEntityInput::canonical)
                .cloned()
                .collect::<Vec<_>>(),
            expected
        );
    }
}
