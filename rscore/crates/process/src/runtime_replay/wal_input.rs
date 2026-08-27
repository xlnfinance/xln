//! Exact conversion of one validated WAL frame plus its authenticated Entity
//! context into the native Runtime transition input.

use serde_json::{Map, Value};
use xln_rscore_runtime::{
    RuntimeEntityInput, RuntimeFrameContext, RuntimeInput, canonical_value_from_tagged_json,
    decode_entity_deterministic_context,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("RUNTIME_REPLAY_WAL_INPUT_OBJECT:{path}"))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("RUNTIME_REPLAY_WAL_INPUT_ARRAY:{path}"))
}

fn field<'a>(value: &'a Value, name: &str, path: &str) -> Result<&'a Value, String> {
    object(value, path)?
        .get(name)
        .ok_or_else(|| format!("RUNTIME_REPLAY_WAL_INPUT_FIELD:{path}.{name}"))
}

fn safe_unsigned(value: &Value, path: &str) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| format!("RUNTIME_REPLAY_WAL_INPUT_UNSIGNED:{path}"))
}

fn exact_runtime_input_fields(value: &Map<String, Value>) -> Result<(), String> {
    for field in value.keys() {
        if !matches!(
            field.as_str(),
            "runtimeTxs" | "entityInputs" | "jInputs" | "timestamp" | "queuedAt"
        ) {
            return Err(format!(
                "RUNTIME_REPLAY_WAL_INPUT_FIELD_UNSUPPORTED:{field}"
            ));
        }
    }
    for field in ["runtimeTxs", "entityInputs"] {
        if !value.contains_key(field) {
            return Err(format!(
                "RUNTIME_REPLAY_WAL_INPUT_FIELD:runtimeInput.{field}"
            ));
        }
    }
    for field in ["timestamp", "queuedAt"] {
        if let Some(value) = value.get(field) {
            safe_unsigned(value, &format!("runtimeInput.{field}"))?;
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

/// Decode only currently native RRS inputs. Runtime/J transactions are not
/// silently carried: a non-empty lane fails on its first exact kind so replay
/// coverage can never be mistaken for execution parity.
pub(super) fn decode_wal_runtime_input(
    frame: &Value,
    entity_context: &Value,
    context_policy: &Value,
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
) -> Result<RuntimeInput, String> {
    let height = safe_unsigned(field(frame, "height", "frame")?, "frame.height")?;
    let timestamp = safe_unsigned(field(frame, "timestamp", "frame")?, "frame.timestamp")?;
    let runtime_input = field(frame, "runtimeInput", "frame")?;
    let runtime_input_object = object(runtime_input, "frame.runtimeInput")?;
    exact_runtime_input_fields(runtime_input_object)?;

    let runtime_txs = array(
        field(runtime_input, "runtimeTxs", "frame.runtimeInput")?,
        "frame.runtimeInput.runtimeTxs",
    )?;
    if let Some((index, tx)) = runtime_txs.iter().enumerate().next() {
        return Err(format!(
            "RUNTIME_REPLAY_RUNTIME_TX_UNSUPPORTED:{height}:{index}:{}",
            unsupported_kind(tx, "runtimeTxs", index)
        ));
    }
    if let Some(j_inputs) = runtime_input_object.get("jInputs") {
        let j_inputs = array(j_inputs, "frame.runtimeInput.jInputs")?;
        if let Some((index, input)) = j_inputs.iter().enumerate().next() {
            return Err(format!(
                "RUNTIME_REPLAY_J_INPUT_UNSUPPORTED:{height}:{index}:{}",
                unsupported_kind(input, "jInputs", index)
            ));
        }
    }
    let entity_inputs = array(
        field(runtime_input, "entityInputs", "frame.runtimeInput")?,
        "frame.runtimeInput.entityInputs",
    )?
    .iter()
    .enumerate()
    .map(|(index, input)| {
        RuntimeEntityInput::decode(input.clone())
            .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_INPUT:{height}:{index}:{error}"))
    })
    .collect::<Result<Vec<_>, _>>()?;
    let canonical_entity_context = canonical_value_from_tagged_json(entity_context)
        .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_CONTEXT_VALUE:{height}:{error}"))?;
    let entity_context = decode_entity_deterministic_context(context_policy, entity_context)
        .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_CONTEXT:{height}:{error}"))?;
    Ok(RuntimeInput {
        runtime_txs: Vec::new(),
        entity_inputs,
        frame: RuntimeFrameContext {
            timestamp,
            finalized_j_height,
            hub_rebalance_has_pending_work,
            entity_context,
            canonical_entity_context,
        },
    })
}

/// A WAL RuntimeInput is the exact batch selected by TypeScript, not a second
/// copy of new ingress. Native execution may already hold locally-derived work
/// from the preceding frame. Remove one recorded occurrence for each identical
/// resident occurrence before enqueueing; unmatched duplicates remain real
/// inputs and are never globally de-duplicated.
pub(super) fn reconcile_recorded_input_with_resident_queue<'a>(
    input: &mut RuntimeInput,
    resident: impl Iterator<Item = &'a Value>,
) -> usize {
    let mut resident = resident.collect::<Vec<_>>();
    let mut reused = 0_usize;
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn context() -> Value {
        let entity = format!("0x{}", "11".repeat(32));
        let signer = format!("0x{}", "22".repeat(20));
        json!({
            "version": 1,
            "proposerReplicaId": format!("{entity}:{signer}"),
            "entityId": entity,
            "proposerSignerId": signer,
            "parentFrameHash": format!("0x{}", "00".repeat(32)),
            "height": 1,
            "gossipProfiles": [],
            "peerAssertions": [],
            "htlc": { "version": 1, "entries": [], "originated": [] },
        })
    }

    fn policy() -> Value {
        json!({
            "minimumTradeSize": "0",
            "swapTakerFeeBps": 0,
            "jurisdictionId": null,
            "pairPolicies": [],
        })
    }

    #[test]
    fn exact_empty_wal_input_decodes_without_an_execution_oracle() {
        let decoded = decode_wal_runtime_input(
            &json!({
                "height": 7,
                "timestamp": 9,
                "runtimeInput": { "runtimeTxs": [], "entityInputs": [] },
            }),
            &context(),
            &policy(),
            3,
            false,
        )
        .expect("exact Runtime input");
        assert_eq!(decoded.frame.timestamp, 9);
        assert_eq!(decoded.frame.finalized_j_height, 3);
        assert!(decoded.runtime_txs.is_empty());
        assert!(decoded.entity_inputs.is_empty());
    }

    #[test]
    fn unsupported_runtime_lane_is_loud_before_execution() {
        let error = decode_wal_runtime_input(
            &json!({
                "height": 7,
                "timestamp": 9,
                "runtimeInput": {
                    "runtimeTxs": [{ "type": "importReplica" }],
                    "entityInputs": [],
                },
            }),
            &context(),
            &policy(),
            3,
            false,
        )
        .expect_err("unsupported Runtime tx");
        assert_eq!(
            error,
            "RUNTIME_REPLAY_RUNTIME_TX_UNSUPPORTED:7:0:importReplica"
        );
    }

    #[test]
    fn recorded_input_reuses_each_resident_occurrence_exactly_once() {
        let entity_id = format!("0x{}", "11".repeat(32));
        let signer_id = format!("0x{}", "22".repeat(20));
        let trigger = json!({
            "entityId": entity_id,
            "signerId": signer_id,
            "entityTxs": [],
        });
        let fresh = json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": format!("0x{}", "22".repeat(20)),
            "entityTxs": [],
            "from": format!("0x{}", "33".repeat(20)),
            "runtimeId": format!("0x{}", "44".repeat(20)),
            "sourceRuntimeFrame": { "height": 6, "timestamp": 9 },
        });
        let mut decoded = decode_wal_runtime_input(
            &json!({
                "height": 7,
                "timestamp": 10,
                "runtimeInput": {
                    "runtimeTxs": [],
                    "entityInputs": [fresh.clone(), trigger.clone(), trigger.clone()],
                },
            }),
            &context(),
            &policy(),
            3,
            false,
        )
        .expect("exact Runtime input");

        let reused =
            reconcile_recorded_input_with_resident_queue(&mut decoded, std::iter::once(&trigger));

        assert_eq!(reused, 1);
        assert_eq!(decoded.entity_inputs.len(), 2);
        assert_eq!(decoded.entity_inputs[0].canonical(), &fresh);
        assert_eq!(decoded.entity_inputs[1].canonical(), &trigger);
    }
}
