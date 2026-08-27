//! First-divergence evidence for native replay.
//!
//! The successful path never calls this module. On the first mismatch it
//! reads the one frame already fsynced by the native store, decodes both
//! canonical frames and their flat outboxes, and writes one bounded JSON file.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use xln_rscore_runtime::RuntimeDurableCommitments;
use xln_rscore_runtime::decode_storage_payload;
use xln_rscore_runtime::restore::ConcreteWalSource;
use xln_rscore_runtime::storage::native::RecoveredWalFrame;

const MAX_DIFFERENCES: usize = 32;
const MAX_VALUE_CHARS: usize = 512;

pub struct RuntimeReplayDiff {
    pub path: PathBuf,
    pub first_difference: String,
}

pub struct RuntimeReplayDiffInput<'a> {
    pub directory: &'a Path,
    pub height: u64,
    pub expected: &'a ConcreteWalSource,
    pub actual: &'a RecoveredWalFrame,
    pub recording: &'a Value,
    pub expected_entity_link: &'a Value,
    pub actual_replica_meta: &'a Value,
    pub actual_entity_sections: &'a Value,
    pub actual_commitments: &'a RuntimeDurableCommitments,
}

pub fn write_runtime_replay_diff(
    input: RuntimeReplayDiffInput<'_>,
) -> Result<RuntimeReplayDiff, String> {
    let RuntimeReplayDiffInput {
        directory,
        height,
        expected,
        actual,
        recording,
        expected_entity_link,
        actual_replica_meta,
        actual_entity_sections,
        actual_commitments,
    } = input;
    let expected_frame = decode_storage_payload(&expected.frame_bytes)
        .map_err(|error| format!("expected-frame:{error}"))?;
    let actual_frame = decode_storage_payload(&actual.frame_bytes)
        .map_err(|error| format!("actual-frame:{error}"))?;
    let expected_outputs = decode_rows(&expected.outputs, "expected-output")?;
    let actual_outputs = decode_rows(&actual.outputs, "actual-output")?;

    let expected_value = Value::Object(Map::from_iter([
        ("frame".into(), expected_frame),
        ("outbox".into(), Value::Array(expected_outputs)),
    ]));
    let actual_value = Value::Object(Map::from_iter([
        ("frame".into(), actual_frame),
        ("outbox".into(), Value::Array(actual_outputs)),
    ]));
    let mut differences = Vec::new();
    collect_differences(&expected_value, &actual_value, "$", &mut differences);
    if differences.is_empty() {
        differences.push(difference(
            "$bytes",
            "canonical-bytes-mismatch",
            &Value::String(bytes_digest(&expected.frame_bytes)),
            &Value::String(bytes_digest(&actual.frame_bytes)),
        ));
    }
    let expected_entity_frame = nested_field(expected_entity_link, &["frame"]);
    let actual_entity_head = nested_field(actual_replica_meta, &["certifiedFrameHead"]);
    let actual_entity_frame = actual_entity_head.and_then(|head| nested_field(head, &["frame"]));
    let mut layer_differences = Vec::new();
    if let (Some(expected_frame), Some(actual_frame)) = (expected_entity_frame, actual_entity_frame)
    {
        collect_entity_frame_differences(expected_frame, actual_frame, &mut layer_differences);
    }
    let expected_entity_oracle = oracle_rows(recording, "entityFrames", height);
    let expected_account_oracle = oracle_rows(recording, "accountFrames", height);
    let actual_commitment_value = commitment_value(actual_commitments);
    if let Some(expected_entity) = expected_entity_oracle
        .as_array()
        .and_then(|rows| rows.first())
    {
        collect_section_differences(
            expected_entity,
            actual_entity_sections,
            &mut layer_differences,
        );
        if let (Some(expected_frame), Some(actual_frame)) =
            (expected_entity_frame, actual_entity_frame)
        {
            collect_entity_frame_derived_differences(
                expected_frame,
                actual_frame,
                &mut layer_differences,
            );
        }
        collect_commitment_differences(
            expected_entity,
            &actual_commitment_value,
            &mut layer_differences,
        );
    }
    let first = layer_differences.first().unwrap_or(&differences[0]);
    let first_difference = compact_difference(first);
    let artifact = Value::Object(Map::from_iter([
        ("height".into(), Value::from(height)),
        ("firstDifference".into(), first.clone()),
        ("layerDifferences".into(), Value::Array(layer_differences)),
        ("differences".into(), Value::Array(differences)),
        ("expected".into(), redact(expected_value)),
        ("actual".into(), redact(actual_value)),
        (
            "layerDiagnostics".into(),
            Value::Object(Map::from_iter([
                (
                    "expectedEntityLink".into(),
                    redact(expected_entity_link.clone()),
                ),
                (
                    "actualEntityHead".into(),
                    redact(actual_entity_head.cloned().unwrap_or(Value::Null)),
                ),
                (
                    "expectedEntityOracle".into(),
                    redact(expected_entity_oracle),
                ),
                (
                    "expectedAccountOracle".into(),
                    redact(expected_account_oracle),
                ),
                (
                    "actualEntitySections".into(),
                    redact(actual_entity_sections.clone()),
                ),
                ("actualCommitments".into(), actual_commitment_value),
                (
                    "actualReplicaMeta".into(),
                    redact(actual_replica_meta.clone()),
                ),
            ])),
        ),
    ]));

    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("first-divergence-h{height}.json"));
    let bytes = serde_json::to_vec_pretty(&artifact).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(RuntimeReplayDiff {
        path,
        first_difference,
    })
}

fn nested_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, field| current.get(field))
}

fn oracle_rows(recording: &Value, field: &str, height: u64) -> Value {
    nested_field(recording, &["authorityFrameOracle", field])
        .and_then(Value::as_array)
        .map(|rows| {
            Value::Array(
                rows.iter()
                    .filter(|row| row.get("runtimeHeight").and_then(Value::as_u64) == Some(height))
                    .cloned()
                    .collect(),
            )
        })
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn commitment_value(commitments: &RuntimeDurableCommitments) -> Value {
    Value::Object(Map::from_iter([
        (
            "frameHash".into(),
            Value::String(hex_digest(&commitments.certified_entity_frame_hash)),
        ),
        (
            "stateRoot".into(),
            Value::String(hex_digest(&commitments.entity_state_root)),
        ),
        (
            "authorityRoot".into(),
            Value::String(hex_digest(&commitments.entity_authority_root)),
        ),
        (
            "accountsRoot".into(),
            Value::String(hex_digest(&commitments.accounts_root)),
        ),
        (
            "eventCount".into(),
            Value::from(commitments.entity_event_count),
        ),
        (
            "eventDigest".into(),
            Value::String(hex_digest(&commitments.events_parity_digest)),
        ),
        (
            "effectCount".into(),
            Value::from(commitments.entity_effect_count),
        ),
        (
            "effectDigest".into(),
            Value::String(hex_digest(&commitments.entity_effects_parity_digest)),
        ),
        (
            "outboxCount".into(),
            Value::from(commitments.runtime_output_count),
        ),
        (
            "outboxDigest".into(),
            Value::String(hex_digest(&commitments.runtime_outputs_digest)),
        ),
    ]))
}

/// Compare semantic inputs before derived roots, signatures and frame hashes.
/// This makes the first path actionable instead of reporting the first hash
/// that necessarily changed downstream.
fn collect_entity_frame_differences(expected: &Value, actual: &Value, output: &mut Vec<Value>) {
    for field in [
        "height",
        "parentFrameHash",
        "timestamp",
        "txs",
        "events",
        "entityContext",
        "authorityRoot",
    ] {
        if output.len() >= MAX_DIFFERENCES {
            return;
        }
        let path = format!("$.layers.entity.frame.{field}");
        match (expected.get(field), actual.get(field)) {
            (Some(left), Some(right)) => collect_differences(left, right, &path, output),
            (Some(left), None) => output.push(difference(
                &path,
                "missing-actual",
                left,
                &Value::String("<missing>".into()),
            )),
            (None, Some(right)) => output.push(difference(
                &path,
                "missing-expected",
                &Value::String("<missing>".into()),
                right,
            )),
            (None, None) => {}
        }
    }
}

fn collect_entity_frame_derived_differences(
    expected: &Value,
    actual: &Value,
    output: &mut Vec<Value>,
) {
    for field in ["stateRoot", "hash"] {
        if output.len() >= MAX_DIFFERENCES {
            return;
        }
        let path = format!("$.layers.entity.frame.{field}");
        if let (Some(left), Some(right)) = (expected.get(field), actual.get(field)) {
            collect_differences(left, right, &path, output);
        }
    }
}

fn collect_section_differences(expected: &Value, actual: &Value, output: &mut Vec<Value>) {
    let Some(rows) = expected.get("sections").and_then(Value::as_array) else {
        return;
    };
    let expected = Value::Object(Map::from_iter(rows.iter().filter_map(|row| {
        Some((
            row.get("field")?.as_str()?.to_string(),
            row.get("digest")?.clone(),
        ))
    })));
    collect_differences(&expected, actual, "$.layers.entity.sections", output);
}

fn collect_commitment_differences(expected: &Value, actual: &Value, output: &mut Vec<Value>) {
    for field in ["accountsRoot", "authorityRoot", "stateRoot", "frameHash"] {
        if output.len() >= MAX_DIFFERENCES {
            return;
        }
        let path = format!("$.layers.entity.commitments.{field}");
        if let (Some(left), Some(right)) = (expected.get(field), actual.get(field)) {
            collect_differences(left, right, &path, output);
        }
    }
}

fn decode_rows(rows: &[Vec<u8>], label: &str) -> Result<Vec<Value>, String> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            decode_storage_payload(row).map_err(|error| format!("{label}:{index}:{error}"))
        })
        .collect()
}

fn collect_differences(expected: &Value, actual: &Value, path: &str, output: &mut Vec<Value>) {
    if output.len() >= MAX_DIFFERENCES || expected == actual {
        return;
    }
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            let keys = left
                .keys()
                .chain(right.keys())
                .cloned()
                .collect::<BTreeSet<_>>();
            for key in keys {
                if output.len() >= MAX_DIFFERENCES {
                    break;
                }
                let child = format!("{path}.{}", path_key(&key));
                match (left.get(&key), right.get(&key)) {
                    (Some(left), Some(right)) => collect_differences(left, right, &child, output),
                    (Some(left), None) => output.push(difference(
                        &child,
                        "missing-actual",
                        left,
                        &Value::String("<missing>".into()),
                    )),
                    (None, Some(right)) => output.push(difference(
                        &child,
                        "missing-expected",
                        &Value::String("<missing>".into()),
                        right,
                    )),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().max(right.len()) {
                if output.len() >= MAX_DIFFERENCES {
                    break;
                }
                let child = format!("{path}[{index}]");
                match (left.get(index), right.get(index)) {
                    (Some(left), Some(right)) => collect_differences(left, right, &child, output),
                    (Some(left), None) => output.push(difference(
                        &child,
                        "missing-actual",
                        left,
                        &Value::String("<missing>".into()),
                    )),
                    (None, Some(right)) => output.push(difference(
                        &child,
                        "missing-expected",
                        &Value::String("<missing>".into()),
                        right,
                    )),
                    (None, None) => {}
                }
            }
        }
        _ => output.push(difference(path, "value-mismatch", expected, actual)),
    }
}

fn difference(path: &str, reason: &str, expected: &Value, actual: &Value) -> Value {
    Value::Object(Map::from_iter([
        ("path".into(), Value::String(path.into())),
        ("reason".into(), Value::String(reason.into())),
        ("expected".into(), bounded(redact(expected.clone()))),
        ("actual".into(), bounded(redact(actual.clone()))),
    ]))
}

fn bounded(value: Value) -> Value {
    let rendered = serde_json::to_string(&value).unwrap_or_else(|_| "<unprintable>".into());
    if rendered.chars().count() <= MAX_VALUE_CHARS {
        return value;
    }
    Value::String(format!(
        "{}…<{} chars>",
        rendered.chars().take(MAX_VALUE_CHARS).collect::<String>(),
        rendered.chars().count(),
    ))
}

fn compact_difference(value: &Value) -> String {
    let path = value.get("path").and_then(Value::as_str).unwrap_or("$");
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("mismatch");
    format!("{path}:{reason}")
}

fn path_key(key: &str) -> String {
    if key
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_')
    {
        key.to_string()
    } else {
        format!("[{key:?}]")
    }
}

fn redact(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let lowered = key.to_ascii_lowercase();
                    let value = if lowered.contains("secret") || lowered.contains("preimage") {
                        Value::String(format!("<redacted:{}>", value_size(&value)))
                    } else {
                        redact(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact).collect()),
        other => other,
    }
}

fn value_size(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn bytes_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{collect_differences, collect_section_differences};
    use serde_json::{Value, json};

    #[test]
    fn first_difference_is_deterministic_and_names_the_exact_path() {
        let expected =
            json!({"frame":{"runtimeInput":{"entityInputs":[{"kind":"a"}]}},"outbox":[]});
        let actual = json!({"frame":{"runtimeInput":{"entityInputs":[{"kind":"b"}]}},"outbox":[1]});
        let mut differences = Vec::<Value>::new();
        collect_differences(&expected, &actual, "$", &mut differences);
        assert_eq!(
            differences[0].get("path").and_then(Value::as_str),
            Some("$.frame.runtimeInput.entityInputs[0].kind"),
        );
        assert_eq!(
            differences[1].get("path").and_then(Value::as_str),
            Some("$.outbox[0]"),
        );
    }

    #[test]
    fn entity_section_is_reported_before_derived_root_noise() {
        let expected = json!({
            "sections": [
                {"field":"accounts", "digest":"0xaa"},
                {"field":"orderbookExt", "digest":"0xbb"}
            ]
        });
        let actual = json!({"accounts":"0xaa", "orderbookExt":"0xcc"});
        let mut differences = Vec::<Value>::new();

        collect_section_differences(&expected, &actual, &mut differences);

        assert_eq!(differences.len(), 1);
        assert_eq!(
            differences[0].get("path").and_then(Value::as_str),
            Some("$.layers.entity.sections.orderbookExt"),
        );
    }
}
