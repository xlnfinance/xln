//! Independent canonical evidence extracted from the TypeScript recording
//! and a replay report produced by the canonical TypeScript transition.
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
    canonical_state_hash: [u8; 32],
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
    entity_events: BTreeMap<u64, EntityEffectExpectation>,
    local_continuations: BTreeMap<u64, Vec<Value>>,
}

fn local_continuation_expectations(report: &Value) -> Result<BTreeMap<u64, Vec<Value>>, String> {
    let expectations = field(report, "authorityExpectations", "tsParityReport")?;
    let rows = array(
        field(
            expectations,
            "localContinuations",
            "tsParityReport.authorityExpectations",
        )?,
        "tsParityReport.authorityExpectations.localContinuations",
    )?;
    let mut output = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = format!("tsParityReport.authorityExpectations.localContinuations[{index}]");
        let row_object = object(row, &path)?;
        if row_object.len() != 2
            || !row_object.contains_key("runtimeHeight")
            || !row_object.contains_key("inputs")
        {
            return Err(format!(
                "RUNTIME_REPLAY_EXPECTED_LOCAL_CONTINUATION_KEYS:{path}"
            ));
        }
        let height = unsigned(
            field(row, "runtimeHeight", &path)?,
            &format!("{path}.runtimeHeight"),
        )?;
        let inputs = array(field(row, "inputs", &path)?, &format!("{path}.inputs"))?;
        let mut canonical = Vec::with_capacity(inputs.len());
        for (input_index, input) in inputs.iter().enumerate() {
            let decoded = xln_rscore_runtime::RuntimeEntityInput::decode(input.clone()).map_err(
                |error| {
                    format!(
                        "RUNTIME_REPLAY_EXPECTED_LOCAL_CONTINUATION_INPUT:{path}.inputs[{input_index}]:{error}"
                    )
                },
            )?;
            canonical.push(decoded.canonical().clone());
        }
        if output.insert(height, canonical).is_some() {
            return Err(format!(
                "RUNTIME_REPLAY_EXPECTED_LOCAL_CONTINUATION_DUPLICATE:{height}"
            ));
        }
    }
    Ok(output)
}

fn entity_event_expectations(
    report: &Value,
) -> Result<BTreeMap<u64, EntityEffectExpectation>, String> {
    let expectations = field(report, "authorityExpectations", "tsParityReport")?;
    let rows = array(
        field(
            expectations,
            "entityFrameEvents",
            "tsParityReport.authorityExpectations",
        )?,
        "tsParityReport.authorityExpectations.entityFrameEvents",
    )?;
    let mut output = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = format!("tsParityReport.authorityExpectations.entityFrameEvents[{index}]");
        let height = unsigned(
            field(row, "runtimeHeight", &path)?,
            &format!("{path}.runtimeHeight"),
        )?;
        let expectation = EntityEffectExpectation {
            count: unsigned(
                field(row, "eventCount", &path)?,
                &format!("{path}.eventCount"),
            )?,
            digest: digest(
                field(row, "orderedEventDigest", &path)?,
                &format!("{path}.orderedEventDigest"),
            )?,
        };
        if output.insert(height, expectation).is_some() {
            return Err(format!("RUNTIME_REPLAY_EXPECTED_EVENT_DUPLICATE:{height}"));
        }
    }
    Ok(output)
}

fn entity_effect_expectations(
    report: &Value,
) -> Result<BTreeMap<u64, EntityEffectExpectation>, String> {
    let expectations = field(report, "authorityExpectations", "tsParityReport")?;
    let rows = array(
        field(
            expectations,
            "entityEffects",
            "tsParityReport.authorityExpectations",
        )?,
        "tsParityReport.authorityExpectations.entityEffects",
    )?;
    let mut output = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = format!("tsParityReport.authorityExpectations.entityEffects[{index}]");
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
    let authority = field(root, "authorityEvidence", "recordingRoot")?;
    let expectations = field(authority, "expectations", "authorityEvidence")?;
    let frames = array(
        field(
            expectations,
            "runtimeFrames",
            "authorityEvidence.expectations",
        )?,
        "authorityEvidence.expectations.runtimeFrames",
    )?;
    let effects = array(
        field(expectations, "effects", "authorityEvidence.expectations")?,
        "authorityEvidence.expectations.effects",
    )?;
    if frames.len() != effects.len() {
        return Err(format!(
            "RUNTIME_REPLAY_EXPECTED_FRAME_EFFECT_COUNT:{}:{}",
            frames.len(),
            effects.len()
        ));
    }
    let mut grouped = BTreeMap::new();
    for (index, (frame, effect)) in frames.iter().zip(effects).enumerate() {
        let path = format!("authorityEvidence.expectations.runtimeFrames[{index}]");
        let effect_path = format!("authorityEvidence.expectations.effects[{index}]");
        let height = unsigned(field(frame, "height", &path)?, &format!("{path}.height"))?;
        let effect_height = unsigned(
            field(effect, "runtimeHeight", &effect_path)?,
            &format!("{effect_path}.runtimeHeight"),
        )?;
        if effect_height != height {
            return Err(format!(
                "RUNTIME_REPLAY_EXPECTED_FRAME_EFFECT_HEIGHT:{height}:{effect_height}"
            ));
        }
        let canonical_state_hash = digest(
            field(frame, "canonicalStateHash", &path)?,
            &format!("{path}.canonicalStateHash"),
        )?;
        let expected = RuntimeFrameExpectation {
            timestamp: unsigned(
                field(frame, "timestamp", &path)?,
                &format!("{path}.timestamp"),
            )?,
            post_state_hash: digest(
                field(frame, "postStateHash", &path)?,
                &format!("{path}.postStateHash"),
            )?,
            canonical_state_hash,
            output_count: unsigned(
                field(effect, "outputCount", &effect_path)?,
                &format!("{effect_path}.outputCount"),
            )?,
            output_digest: digest(
                field(effect, "orderedOutputDigest", &effect_path)?,
                &format!("{effect_path}.orderedOutputDigest"),
            )?,
        };
        if grouped.insert(height, expected).is_some() {
            return Err(format!("RUNTIME_REPLAY_EXPECTED_FRAME_DUPLICATE:{height}"));
        }
    }
    Ok(grouped)
}

fn exact_string<'a>(value: &'a Value, path: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_STRING:{path}"))
}

fn source_binding(value: &Value, path: &str) -> Result<([u8; 32], [u8; 32]), String> {
    let binding = object(value, path)?;
    if binding.len() != 3
        || !binding.contains_key("algorithm")
        || !binding.contains_key("runtimeSeedHash")
        || !binding.contains_key("walTreeHash")
    {
        return Err(format!("RUNTIME_REPLAY_SOURCE_BINDING_KEYS:{path}"));
    }
    let algorithm = exact_string(
        field(value, "algorithm", path)?,
        &format!("{path}.algorithm"),
    )?;
    if algorithm != "sha256" {
        return Err(format!(
            "RUNTIME_REPLAY_SOURCE_BINDING_ALGORITHM:{path}:{algorithm}"
        ));
    }
    Ok((
        digest(
            field(value, "runtimeSeedHash", path)?,
            &format!("{path}.runtimeSeedHash"),
        )?,
        digest(
            field(value, "walTreeHash", path)?,
            &format!("{path}.walTreeHash"),
        )?,
    ))
}

fn assert_ts_parity_report_binding(
    recording: &Value,
    report: &Value,
    expected_manifest_hash: &str,
) -> Result<(), String> {
    let schema = exact_string(
        field(report, "schema", "tsParityReport")?,
        "tsParityReport.schema",
    )?;
    if schema != "xln-hlt-hub-replay-report-v1" {
        return Err(format!("RUNTIME_REPLAY_TS_PARITY_REPORT_SCHEMA:{schema}"));
    }
    let recording_binding = source_binding(
        field(
            field(recording, "source", "recordingRoot")?,
            "binding",
            "recordingRoot.source",
        )?,
        "recordingRoot.source.binding",
    )?;
    let report_binding = source_binding(
        field(report, "recordingSourceBinding", "tsParityReport")?,
        "tsParityReport.recordingSourceBinding",
    )?;
    if report_binding != recording_binding {
        return Err(format!(
            "RUNTIME_REPLAY_TS_PARITY_REPORT_BINDING:recordingSeed={}:reportSeed={}:recordingWal={}:reportWal={}",
            hex(&recording_binding.0),
            hex(&report_binding.0),
            hex(&recording_binding.1),
            hex(&report_binding.1),
        ));
    }
    let expected_manifest_value = Value::String(expected_manifest_hash.to_string());
    let expected_manifest = digest(&expected_manifest_value, "recordingManifestHashArgument")?;
    let report_manifest = digest(
        field(report, "recordingManifestHash", "tsParityReport")?,
        "tsParityReport.recordingManifestHash",
    )?;
    if report_manifest != expected_manifest {
        return Err(format!(
            "RUNTIME_REPLAY_TS_PARITY_REPORT_MANIFEST_HASH:expected={}:actual={}",
            hex(&expected_manifest),
            hex(&report_manifest),
        ));
    }
    Ok(())
}

impl ReplayExpectations {
    pub(super) fn from_sources(
        recording: &Value,
        ts_parity_report: &Value,
        expected_manifest_hash: &str,
    ) -> Result<Self, String> {
        assert_ts_parity_report_binding(recording, ts_parity_report, expected_manifest_hash)?;
        Ok(Self {
            runtime_frames: runtime_expectations(recording)?,
            entity_effects: entity_effect_expectations(ts_parity_report)?,
            entity_events: entity_event_expectations(ts_parity_report)?,
            local_continuations: local_continuation_expectations(ts_parity_report)?,
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
        let entity_events = self.entity_events.range(from..=to).count();
        let local_continuations = self.local_continuations.range(from..=to).count();
        if runtime_frames != expected
            || entity_effects != expected
            || entity_events != expected
            || local_continuations != expected
        {
            return Err(format!(
                "RUNTIME_REPLAY_EXPECTED_RANGE_MISMATCH:from={from}:to={to}:frames={runtime_frames}:effects={entity_effects}:events={entity_events}:localContinuations={local_continuations}",
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

    pub(super) fn assert_events(
        &self,
        height: u64,
        commitments: &RuntimeDurableCommitments,
    ) -> Result<(), String> {
        let expected = self
            .entity_events
            .get(&height)
            .ok_or_else(|| format!("RUNTIME_REPLAY_EXPECTED_EVENTS_MISSING:{height}"))?;
        if expected.count == commitments.entity_event_count
            && expected.digest == commitments.events_parity_digest
        {
            Ok(())
        } else {
            Err(format!(
                "RUNTIME_REPLAY_ENTITY_EVENTS_MISMATCH:{height}:expectedCount={}:actualCount={}:expectedDigest={}:actualDigest={}",
                expected.count,
                commitments.entity_event_count,
                hex(&expected.digest),
                hex(&commitments.events_parity_digest),
            ))
        }
    }

    pub(super) fn assert_local_continuations(
        &self,
        height: u64,
        actual: &[Value],
    ) -> Result<(), String> {
        let expected = self.local_continuations.get(&height).ok_or_else(|| {
            format!("RUNTIME_REPLAY_EXPECTED_LOCAL_CONTINUATIONS_MISSING:{height}")
        })?;
        if expected.as_slice() == actual {
            return Ok(());
        }
        Err(format!(
            "RUNTIME_REPLAY_LOCAL_CONTINUATIONS_MISMATCH:{height}:expected={expected:?}:actual={actual:?}"
        ))
    }

    pub(super) fn expected_canonical_state_hash(&self, height: u64) -> Result<[u8; 32], String> {
        Ok(self.runtime_frame(height)?.canonical_state_hash)
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

    fn recording_fixture() -> Value {
        json!({
            "source": {
                "binding": {
                    "algorithm": "sha256",
                    "runtimeSeedHash": format!("0x{}", "aa".repeat(32)),
                    "walTreeHash": format!("0x{}", "bb".repeat(32)),
                },
            },
            "authorityEvidence": {
                "expectations": {
                    "runtimeFrames": [{
                        "height": 7,
                        "timestamp": 9,
                        "postStateHash": format!("0x{}", "55".repeat(32)),
                        "canonicalStateHash": format!("0x{}", "77".repeat(32)),
                    }],
                    "effects": [{
                        "runtimeHeight": 7,
                        "outputCount": 0,
                        "orderedOutputDigest": format!("0x{}", "66".repeat(32)),
                    }],
                },
            },
            "tail": {
                "kind": "journal_tail",
            },
        })
    }

    fn parity_report_fixture() -> Value {
        json!({
            "schema": "xln-hlt-hub-replay-report-v1",
            "recordingManifestHash": recording_manifest_hash(),
            "recordingSourceBinding": {
                "algorithm": "sha256",
                "runtimeSeedHash": format!("0x{}", "aa".repeat(32)),
                "walTreeHash": format!("0x{}", "bb".repeat(32)),
            },
            "authorityExpectations": {
                "entityEffects": [{
                    "runtimeHeight": 7,
                    "effectCount": 0,
                    "orderedEffectDigest": format!("0x{}", "88".repeat(32)),
                }],
                "entityFrameEvents": [{
                    "runtimeHeight": 7,
                    "eventCount": 0,
                    "orderedEventDigest": format!("0x{}", "99".repeat(32)),
                }],
                "localContinuations": [{
                    "runtimeHeight": 7,
                    "inputs": [{
                        "entityId": format!("0x{}", "11".repeat(32)),
                        "signerId": "local-signer",
                        "entityTxs": [],
                    }],
                }],
            },
        })
    }

    fn recording_manifest_hash() -> String {
        format!("0x{}", "dd".repeat(32))
    }

    #[test]
    fn missing_runtime_height_is_loud() {
        let expectations = ReplayExpectations::from_sources(
            &recording_fixture(),
            &parity_report_fixture(),
            &recording_manifest_hash(),
        )
        .expect("fixture");
        assert_eq!(
            expectations.expected_canonical_state_hash(7).unwrap(),
            [0x77; 32]
        );
        assert!(
            expectations
                .assert_exact_range(8, 8)
                .unwrap_err()
                .contains("EXPECTED_RANGE_MISMATCH")
        );
    }

    #[test]
    fn legacy_recording_event_and_effect_rows_are_not_used_as_the_oracle() {
        let expectations = ReplayExpectations::from_sources(
            &recording_fixture(),
            &parity_report_fixture(),
            &recording_manifest_hash(),
        )
        .expect("fixture");
        assert_eq!(
            expectations.entity_effects.get(&7).expect("effect").count,
            0
        );
        assert_eq!(expectations.entity_events.get(&7).expect("event").count, 0);
    }

    #[test]
    fn local_continuation_parity_is_exact_and_fail_closed() {
        let expectations = ReplayExpectations::from_sources(
            &recording_fixture(),
            &parity_report_fixture(),
            &recording_manifest_hash(),
        )
        .expect("fixture");
        let exact = vec![json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": "local-signer",
            "entityTxs": [],
        })];
        expectations
            .assert_local_continuations(7, &exact)
            .expect("exact continuation must pass");
        assert!(
            expectations
                .assert_local_continuations(7, &[])
                .unwrap_err()
                .contains("LOCAL_CONTINUATIONS_MISMATCH")
        );
        let different = vec![json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": "different-signer",
            "entityTxs": [],
        })];
        assert!(
            expectations
                .assert_local_continuations(7, &different)
                .unwrap_err()
                .contains("LOCAL_CONTINUATIONS_MISMATCH")
        );
    }

    #[test]
    fn canonical_root_and_matching_effect_height_are_required() {
        let mut missing = recording_fixture();
        missing["authorityEvidence"]["expectations"]["runtimeFrames"][0]
            .as_object_mut()
            .expect("frame")
            .remove("canonicalStateHash");
        assert!(
            ReplayExpectations::from_sources(
                &missing,
                &parity_report_fixture(),
                &recording_manifest_hash(),
            )
            .err()
            .expect("missing canonical root must fail")
            .contains("EXPECTED_FIELD")
        );

        let mut null = recording_fixture();
        null["authorityEvidence"]["expectations"]["runtimeFrames"][0]["canonicalStateHash"] =
            Value::Null;
        assert!(
            ReplayExpectations::from_sources(
                &null,
                &parity_report_fixture(),
                &recording_manifest_hash(),
            )
            .err()
            .expect("null canonical root must fail")
            .contains("EXPECTED_DIGEST")
        );
        let mut mismatched = recording_fixture();
        mismatched["authorityEvidence"]["expectations"]["effects"][0]["runtimeHeight"] =
            Value::from(8);
        assert!(
            ReplayExpectations::from_sources(
                &mismatched,
                &parity_report_fixture(),
                &recording_manifest_hash(),
            )
            .err()
            .expect("mismatched effect height must fail")
            .contains("FRAME_EFFECT_HEIGHT")
        );
    }

    #[test]
    fn runtime_and_effect_digest_are_independent_required_evidence() {
        let expectations = ReplayExpectations::from_sources(
            &recording_fixture(),
            &parity_report_fixture(),
            &recording_manifest_hash(),
        )
        .expect("fixture");
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
        assert!(
            expectations
                .assert_events(7, &commitments)
                .unwrap_err()
                .contains("ENTITY_EVENTS_MISMATCH")
        );
    }

    #[test]
    fn ts_report_is_required_and_bound_to_the_recording() {
        let mut wrong = parity_report_fixture();
        wrong["recordingSourceBinding"]["walTreeHash"] =
            Value::String(format!("0x{}", "cc".repeat(32)));
        assert!(
            ReplayExpectations::from_sources(
                &recording_fixture(),
                &wrong,
                &recording_manifest_hash(),
            )
            .err()
            .expect("wrong report binding must fail")
            .contains("TS_PARITY_REPORT_BINDING")
        );

        let mut stale = parity_report_fixture();
        stale["recordingManifestHash"] = Value::String(format!("0x{}", "cc".repeat(32)));
        assert!(
            ReplayExpectations::from_sources(
                &recording_fixture(),
                &stale,
                &recording_manifest_hash(),
            )
            .err()
            .expect("stale report manifest must fail")
            .contains("TS_PARITY_REPORT_MANIFEST_HASH")
        );

        let mut tampered = parity_report_fixture();
        tampered["recordingManifestHash"] = Value::String("not-a-hash".into());
        assert!(
            ReplayExpectations::from_sources(
                &recording_fixture(),
                &tampered,
                &recording_manifest_hash(),
            )
            .err()
            .expect("tampered report manifest must fail")
            .contains("EXPECTED_DIGEST:tsParityReport.recordingManifestHash")
        );

        let missing = json!({
            "schema": "xln-hlt-hub-replay-report-v1",
            "recordingManifestHash": recording_manifest_hash(),
            "recordingSourceBinding": {
                "algorithm": "sha256",
                "runtimeSeedHash": format!("0x{}", "aa".repeat(32)),
                "walTreeHash": format!("0x{}", "bb".repeat(32)),
            },
        });
        assert!(
            ReplayExpectations::from_sources(
                &recording_fixture(),
                &missing,
                &recording_manifest_hash(),
            )
            .err()
            .expect("missing report oracle must fail")
            .contains("authorityExpectations")
        );
    }
}
