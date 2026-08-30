//! Independent canonical evidence extracted from the TypeScript recording.
//!
//! These values are consulted only after native execution. They never select
//! work, supply a carried root, or repair Rust state.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use xln_rscore_runtime::RuntimeDurableCommitments;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeFrameExpectation {
    timestamp: u64,
    post_state_hash: [u8; 32],
    runtime_state_hash: Option<[u8; 32]>,
    output_count: u64,
    output_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EntityEffectExpectation {
    count: u64,
    digest: [u8; 32],
}

pub(super) struct ReplayExpectations {
    runtime_frames: BTreeMap<u64, RuntimeFrameExpectation>,
    entity_effects: BTreeMap<u64, EntityEffectExpectation>,
}

fn entity_effect_expectations(
    root: &Value,
) -> Result<BTreeMap<u64, EntityEffectExpectation>, String> {
    let authority = field(root, "authorityEvidence", "recordingRoot")?;
    let expectations = field(authority, "expectations", "authorityEvidence")?;
    let rows = array(
        field(
            expectations,
            "entityEffects",
            "authorityEvidence.expectations",
        )?,
        "authorityEvidence.expectations.entityEffects",
    )?;
    let mut output = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = format!("authorityEvidence.expectations.entityEffects[{index}]");
        let height = unsigned(
            field(row, "runtimeHeight", &path)?,
            &format!("{path}.runtimeHeight"),
        )?;
        let expectation = EntityEffectExpectation {
            count: unsigned(
                field(row, "effectCount", &path)?,
                &format!("{path}.effectCount"),
            )?,
            digest: digest(
                field(row, "orderedEffectDigest", &path)?,
                &format!("{path}.orderedEffectDigest"),
            )?,
        };
        if output.insert(height, expectation).is_some() {
            return Err(format!("RUNTIME_REPLAY_EXPECTED_EFFECT_DUPLICATE:{height}"));
        }
    }
    Ok(output)
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_OBJECT:{path}"))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_ARRAY:{path}"))
}

fn field<'a>(value: &'a Value, name: &str, path: &str) -> Result<&'a Value, String> {
    object(value, path)?
        .get(name)
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_FIELD:{path}.{name}"))
}

fn unsigned(value: &Value, path: &str) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_UNSIGNED:{path}"))
}

fn digest(value: &Value, path: &str) -> Result<[u8; 32], String> {
    let body = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_DIGEST:{path}"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("RUNTIME_REPLAY_EXPECTED_DIGEST:{path}"))?;
    }
    Ok(output)
}

fn runtime_expectations(root: &Value) -> Result<BTreeMap<u64, RuntimeFrameExpectation>, String> {
    let recording = field(root, "recording", "recordingRoot")?;
    let bundles = array(
        field(recording, "bundles", "recording")?,
        "recording.bundles",
    )?;
    let mut grouped = BTreeMap::new();
    for (bundle_index, bundle) in bundles.iter().enumerate() {
        let bundle_path = format!("recording.bundles[{bundle_index}]");
        if field(bundle, "kind", &bundle_path)?.as_str() != Some("journal_tail") {
            continue;
        }
        let frames = array(
            field(bundle, "frames", &bundle_path)?,
            &format!("{bundle_path}.frames"),
        )?;
        for (index, frame) in frames.iter().enumerate() {
            let path = format!("{bundle_path}.frames[{index}]");
            let height = unsigned(field(frame, "height", &path)?, &format!("{path}.height"))?;
            let runtime_state_hash = match object(frame, &path)?.get("runtimeStateHash") {
                None | Some(Value::Null) => None,
                Some(value) => Some(digest(value, &format!("{path}.runtimeStateHash"))?),
            };
            let expected = RuntimeFrameExpectation {
                timestamp: unsigned(
                    field(frame, "timestamp", &path)?,
                    &format!("{path}.timestamp"),
                )?,
                post_state_hash: digest(
                    field(frame, "postStateHash", &path)?,
                    &format!("{path}.postStateHash"),
                )?,
                runtime_state_hash,
                output_count: unsigned(
                    field(frame, "runtimeOutputCount", &path)?,
                    &format!("{path}.runtimeOutputCount"),
                )?,
                output_digest: digest(
                    field(frame, "runtimeOutputsDigest", &path)?,
                    &format!("{path}.runtimeOutputsDigest"),
                )?,
            };
            if grouped.insert(height, expected).is_some() {
                return Err(format!("RUNTIME_REPLAY_EXPECTED_FRAME_DUPLICATE:{height}"));
            }
        }
    }
    Ok(grouped)
}

impl ReplayExpectations {
    pub(super) fn from_recording(root: &Value) -> Result<Self, String> {
        Ok(Self {
            runtime_frames: runtime_expectations(root)?,
            entity_effects: entity_effect_expectations(root)?,
        })
    }

    pub(super) fn assert_exact_range(&self, from: u64, to: u64) -> Result<(), String> {
        if to < from {
            return Err("RUNTIME_REPLAY_EXPECTED_RANGE".into());
        }
        let expected = usize::try_from(to - from + 1)
            .map_err(|_| "RUNTIME_REPLAY_EXPECTED_RANGE".to_string())?;
        let runtime_frames = self.runtime_frames.range(from..=to).count();
        let entity_effects = self.entity_effects.range(from..=to).count();
        if runtime_frames != expected || entity_effects != expected {
            return Err(format!(
                "RUNTIME_REPLAY_EXPECTED_RANGE_MISMATCH:from={from}:to={to}:frames={runtime_frames}:effects={entity_effects}",
            ));
        }
        Ok(())
    }

    pub(super) fn assert_effects(
        &self,
        height: u64,
        commitments: &RuntimeDurableCommitments,
    ) -> Result<(), String> {
        let expected = self
            .entity_effects
            .get(&height)
            .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_EFFECTS_MISSING:{height}"))?;
        if expected.count == commitments.entity_effect_count
            && expected.digest == commitments.entity_effects_parity_digest
        {
            Ok(())
        } else {
            Err(format!(
                "RUNTIME_REPLAY_ENTITY_EFFECTS_MISMATCH:{height}:expectedCount={}:actualCount={}:expectedDigest={}:actualDigest={}",
                expected.count,
                commitments.entity_effect_count,
                hex(&expected.digest),
                hex(&commitments.entity_effects_parity_digest),
            ))
        }
    }

    pub(super) fn expected_runtime_state_hash(
        &self,
        height: u64,
    ) -> Result<Option<[u8; 32]>, String> {
        Ok(self.runtime_frame(height)?.runtime_state_hash)
    }

    pub(super) fn assert_durable(
        &self,
        height: u64,
        commitments: &RuntimeDurableCommitments,
    ) -> Result<(), String> {
        let expected = self.runtime_frame(height)?;
        if commitments.height != height
            || commitments.post_state_hash != expected.post_state_hash
            || commitments.runtime_output_count != expected.output_count
            || commitments.runtime_outputs_digest != expected.output_digest
        {
            return Err(format!(
                "RUNTIME_REPLAY_DURABLE_MISMATCH:{height}:expectedPost={}:actualPost={}:expectedOut={}/{}:actualOut={}/{}",
                hex(&expected.post_state_hash),
                hex(&commitments.post_state_hash),
                expected.output_count,
                hex(&expected.output_digest),
                commitments.runtime_output_count,
                hex(&commitments.runtime_outputs_digest),
            ));
        }
        Ok(())
    }

    pub(super) fn assert_timestamp(&self, height: u64, timestamp: u64) -> Result<(), String> {
        let expected = self.runtime_frame(height)?.timestamp;
        if expected == timestamp {
            Ok(())
        } else {
            Err(format!(
                "RUNTIME_REPLAY_TIMESTAMP_MISMATCH:{height}:expected={expected}:actual={timestamp}"
            ))
        }
    }

    fn runtime_frame(&self, height: u64) -> Result<&RuntimeFrameExpectation, String> {
        self.runtime_frames
            .get(&height)
            .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_RUNTIME_FRAME_MISSING:{height}"))
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture() -> Value {
        json!({
            "authorityEvidence": {
                "expectations": {
                    "entityEffects": [{
                        "runtimeHeight": 7,
                        "effectCount": 0,
                        "orderedEffectDigest": format!("0x{}", "88".repeat(32)),
                    }],
                },
            },
            "recording": {
                "bundles": [{
                    "kind": "journal_tail",
                    "frames": [{
                        "height": 7,
                        "timestamp": 9,
                        "postStateHash": format!("0x{}", "55".repeat(32)),
                        "runtimeStateHash": null,
                        "runtimeOutputCount": 0,
                        "runtimeOutputsDigest": format!("0x{}", "66".repeat(32)),
                    }],
                }],
            },
        })
    }

    #[test]
    fn missing_runtime_evidence_is_loud() {
        let expectations = ReplayExpectations::from_recording(&fixture()).expect("fixture");
        assert_eq!(expectations.expected_runtime_state_hash(7).unwrap(), None);
        assert!(
            expectations
                .assert_exact_range(8, 8)
                .unwrap_err()
                .contains("EXPECTED_RANGE_MISMATCH")
        );
    }

    #[test]
    fn runtime_and_effect_digest_are_independent_required_evidence() {
        let expectations = ReplayExpectations::from_recording(&fixture()).expect("fixture");
        let commitments = RuntimeDurableCommitments {
            height: 7,
            runtime_frame_hash: [0; 32],
            post_state_hash: [0x55; 32],
            entities: vec![xln_rscore_runtime::RuntimeDurableEntityCommitment {
                entity_id: [0x11; 32],
                certified_frame_hash: [0x22; 32],
                state_root: [0x33; 32],
                authority_root: [0x44; 32],
                accounts_root: [0; 32],
            }],
            entity_event_count: 0,
            events_parity_digest: [0; 32],
            entity_effect_count: 0,
            entity_effects_parity_digest: [0; 32],
            runtime_output_count: 0,
            runtime_outputs_digest: [0x66; 32],
        };
        assert!(
            expectations
                .assert_effects(7, &commitments)
                .unwrap_err()
                .contains("ENTITY_EFFECTS_MISMATCH")
        );
    }
}
