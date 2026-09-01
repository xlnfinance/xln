//! Exact canonical RuntimeInput decoder shared by replay and native restart.

use serde_json::{Map, Value};
use thiserror::Error;

use crate::entity_context_json::decode_entity_frame_context;
use crate::{
    RuntimeEntityFrameContext, RuntimeEntityInput, RuntimeEntityKey, RuntimeFrameContext,
    RuntimeInput, RuntimeMempool, RuntimeTx, canonical_value_from_tagged_json,
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
    let data_path = format!("{path}.data");
    let data = object(&tx["data"], &data_path)?;
    if kind == "recordRuntimeAdapterCommand" {
        exact_fields(
            data,
            &[
                "laneId",
                "sequence",
                "commandId",
                "inputHash",
                "expiresAtMs",
            ],
            &data_path,
        )?;
        let normalized_hash = |field: &str| -> Result<String, ConcreteWalDecodeError> {
            let value = data[field]
                .as_str()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .filter(|value| {
                    value.len() == 66
                        && value.starts_with("0x")
                        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| invalid(format!("HASH:{data_path}.{field}")))?;
            Ok(value)
        };
        let command_id = data["commandId"]
            .as_str()
            .map(str::trim)
            .filter(|value| {
                (16..=128).contains(&value.len())
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                    })
            })
            .ok_or_else(|| invalid(format!("COMMAND_ID:{data_path}.commandId")))?
            .to_owned();
        let sequence = safe_unsigned(&data["sequence"], &format!("{data_path}.sequence"))?;
        if sequence == 0 {
            return Err(invalid(format!("UNSIGNED:{data_path}.sequence")));
        }
        let expires_at_ms = match &data["expiresAtMs"] {
            Value::Null => None,
            value => {
                let value = safe_unsigned(value, &format!("{data_path}.expiresAtMs"))?;
                if value == 0 {
                    return Err(invalid(format!("UNSIGNED:{data_path}.expiresAtMs")));
                }
                Some(value)
            }
        };
        return Ok(RuntimeTx::RecordRuntimeAdapterCommand(
            crate::RuntimeAdapterCommandMarker {
                lane_id: normalized_hash("laneId")?,
                sequence,
                command_id,
                input_hash: normalized_hash("inputHash")?,
                expires_at_ms,
            },
        ));
    }
    if kind == "importJ" {
        return crate::j_import::decode_import_request(&tx["data"])
            .map(RuntimeTx::ImportJ)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "completeImportJ" {
        return crate::j_import::decode_import_result(&tx["data"])
            .map(RuntimeTx::CompleteImportJ)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "retryJSubmit" {
        return crate::j_submit::lifecycle::decode_retry(&tx["data"])
            .map(RuntimeTx::RetryJSubmit)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "recordJSubmitResult" {
        return crate::j_submit::lifecycle::decode_result(&tx["data"])
            .map(RuntimeTx::RecordJSubmitResult)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "retryEntityProviderAction" {
        return crate::j_submit::provider_lifecycle::decode_retry_entity_provider_action(
            &tx["data"],
        )
        .map(RuntimeTx::RetryEntityProviderAction)
        .map_err(|error| invalid(error.to_string()));
    }
    if kind == "recordEntityProviderActionSubmitResult" {
        return crate::j_submit::provider_lifecycle::decode_entity_provider_action_result(
            &tx["data"],
        )
        .map(RuntimeTx::RecordEntityProviderActionSubmitResult)
        .map_err(|error| invalid(error.to_string()));
    }
    if kind == "observeJRange" {
        return crate::j_watcher::decode_observe_j_range(&tx["data"])
            .map(RuntimeTx::ObserveJRange)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "recordGovernanceJSubmitResult" {
        return crate::j_submit::decode_governance_result(&tx["data"])
            .map(RuntimeTx::RecordGovernanceJSubmitResult)
            .map_err(|error| invalid(error.to_string()));
    }
    if kind == "rewindJHistory" {
        exact_fields(
            data,
            &[
                "entityId",
                "signerId",
                "jurisdictionRef",
                "conflictingHeight",
                "conflictingBlockHash",
            ],
            &data_path,
        )?;
        let entity = digest(&data["entityId"], &format!("{data_path}.entityId"))?;
        let signer_id = data["signerId"]
            .as_str()
            .filter(|value| !value.is_empty() && value.trim() == *value)
            .ok_or_else(|| invalid(format!("STRING:{data_path}.signerId")))?
            .to_ascii_lowercase();
        let jurisdiction_ref = data["jurisdictionRef"]
            .as_str()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(format!("STRING:{data_path}.jurisdictionRef")))?;
        return Ok(RuntimeTx::RewindJHistory(crate::RewindJHistory {
            entity_id: entity,
            signer_id,
            jurisdiction_ref,
            conflicting_height: {
                let value = safe_unsigned(
                    &data["conflictingHeight"],
                    &format!("{data_path}.conflictingHeight"),
                )?;
                if value == 0 {
                    return Err(invalid(format!("UNSIGNED:{data_path}.conflictingHeight")));
                }
                value
            },
            conflicting_block_hash: digest(
                &data["conflictingBlockHash"],
                &format!("{data_path}.conflictingBlockHash"),
            )?,
        }));
    }
    if kind != "advanceJWatcherCursor" {
        return Err(invalid(format!("RUNTIME_TX_UNSUPPORTED:{index}:{kind}")));
    }
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
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
) -> Result<DecodedRuntimeWalFrame, ConcreteWalDecodeError> {
    let frame = source.frame();
    let height = safe_unsigned(field(frame, "height", "frame")?, "frame.height")?;
    let timestamp = safe_unsigned(field(frame, "timestamp", "frame")?, "frame.timestamp")?;
    let runtime_input = field(frame, "runtimeInput", "frame")?;
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
    let mut entity_contexts =
        std::collections::BTreeMap::<RuntimeEntityKey, Vec<(u64, RuntimeEntityFrameContext)>>::new(
        );
    for (replica_id, context) in source.entity_contexts() {
        // Canonical native WAL always binds one context to one exact Entity
        // frame height. A bare `entity:signer` key collapses multiple frames
        // and is rejected rather than treated as a compatibility format.
        let mut replica_parts = replica_id.split(':');
        let entity_text = replica_parts
            .next()
            .ok_or_else(|| invalid(format!("ENTITY_CONTEXT_REPLICA:{height}:{replica_id}")))?;
        let signer_id = replica_parts
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(format!("ENTITY_CONTEXT_REPLICA:{height}:{replica_id}")))?;
        let entity_height = replica_parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid(format!("ENTITY_CONTEXT_REPLICA:{height}:{replica_id}")))?;
        if replica_parts.next().is_some() {
            return Err(invalid(format!(
                "ENTITY_CONTEXT_REPLICA:{height}:{replica_id}"
            )));
        }
        let entity_id = parse_entity_id(entity_text)
            .ok_or_else(|| invalid(format!("ENTITY_CONTEXT_REPLICA:{height}:{replica_id}")))?;
        let key = RuntimeEntityKey::new(entity_id, signer_id)
            .map_err(|error| invalid(format!("ENTITY_CONTEXT_KEY:{height}:{error}")))?;
        let encoded_height = context
            .value
            .get("height")
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid(format!("ENTITY_CONTEXT_HEIGHT:{height}:{replica_id}")))?;
        if encoded_height != entity_height {
            return Err(invalid(format!(
                "ENTITY_CONTEXT_HEIGHT_BINDING:{height}:{replica_id}:{encoded_height}"
            )));
        }
        let decoded = RuntimeEntityFrameContext {
            execution: decode_entity_frame_context(&context.value)
                .map_err(|error| invalid(format!("ENTITY_CONTEXT:{height}:{error}")))?,
            canonical: canonical_value_from_tagged_json(&context.value)
                .map_err(|error| invalid(format!("ENTITY_CONTEXT_VALUE:{height}:{error}")))?,
        };
        let contexts = entity_contexts.entry(key).or_default();
        if contexts
            .iter()
            .any(|(seen_height, _)| *seen_height == entity_height)
        {
            return Err(invalid(format!(
                "ENTITY_CONTEXT_DUPLICATE:{height}:{entity_text}:{entity_height}"
            )));
        }
        contexts.push((entity_height, decoded));
    }
    // Live Runtime-generated work (scheduler wakes and resident continuations)
    // is persisted as explicit `entityInputs`. Exact replay consumes those WAL
    // inputs and their committed contexts verbatim; it must never derive the
    // same work again from the pre-frame replica.
    let entity_contexts = entity_contexts
        .into_iter()
        .map(|(key, mut contexts)| {
            contexts.sort_by_key(|(entity_height, _)| *entity_height);
            (
                key,
                contexts
                    .into_iter()
                    .map(|(_, context)| context)
                    .collect::<std::collections::VecDeque<_>>(),
            )
        })
        .collect();
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
                entity_contexts,
            },
        },
        expected_accounts_root: None,
        expected_entity_root: expected_entity_root(frame)?,
        expected_previous_frame_hash: validated.prev_frame_hash,
        expected_frame_hash: validated.frame_hash,
        canonical_state_hash: validated.canonical_state_hash,
    })
}

fn parse_entity_id(value: &str) -> Option<[u8; 32]> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 64 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
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
            [0x11; 32],
            "first",
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

    #[test]
    fn runtime_adapter_command_marker_decodes_to_typed_runtime_tx() {
        let value = json!({
            "type": "recordRuntimeAdapterCommand",
            "data": {
                "laneId": format!("0x{}", "AB".repeat(32)),
                "sequence": 1,
                "commandId": "command-id-00001",
                "inputHash": format!("0x{}", "CD".repeat(32)),
                "expiresAtMs": null,
            }
        });
        let RuntimeTx::RecordRuntimeAdapterCommand(marker) =
            decode_runtime_tx(&value, 0).expect("typed marker")
        else {
            panic!("wrong RuntimeTx variant");
        };
        assert_eq!(marker.lane_id, format!("0x{}", "ab".repeat(32)));
        assert_eq!(marker.input_hash, format!("0x{}", "cd".repeat(32)));
        assert_eq!(marker.expires_at_ms, None);
    }
}
