//! First-divergence evidence for native Runtime replay.
//!
//! Replay compares the exact Runtime WAL frame and flat outbox. It never reads
//! Account or Entity history. Current native state is attached only after a
//! mismatch as one-sided diagnostics.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use xln_rscore_runtime::decode_storage_payload;
use xln_rscore_runtime::restore::ConcreteWalSource;
use xln_rscore_runtime::storage::native::RecoveredWalFrame;
use xln_rscore_runtime::{AccountCommitEvidence, AccountCommitSource, RuntimeDurableCommitments};

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
    pub actual_replica_meta: &'a Value,
    pub actual_entity_sections: &'a Value,
    pub actual_commitments: &'a RuntimeDurableCommitments,
    pub actual_account_commits: &'a [AccountCommitEvidence],
}

pub fn write_runtime_replay_diff(
    input: RuntimeReplayDiffInput<'_>,
) -> Result<RuntimeReplayDiff, String> {
    let expected_value = replay_value(
        &input.expected.frame_bytes,
        &input.expected.outputs,
        "expected",
    )?;
    let actual_value = replay_value(&input.actual.frame_bytes, &input.actual.outputs, "actual")?;
    let mut differences = Vec::new();
    collect_differences(&expected_value, &actual_value, "$", &mut differences);
    if differences.is_empty() {
        differences.push(difference(
            "$bytes",
            "canonical-bytes-mismatch",
            &Value::String(bytes_digest(&input.expected.frame_bytes)),
            &Value::String(bytes_digest(&input.actual.frame_bytes)),
        ));
    }
    let first_difference = compact_difference(&differences[0]);
    let artifact = Value::Object(Map::from_iter([
        ("height".into(), Value::from(input.height)),
        ("firstDifference".into(), differences[0].clone()),
        ("differences".into(), Value::Array(differences)),
        ("expected".into(), expected_value),
        ("actual".into(), actual_value),
        (
            "actualDiagnostics".into(),
            Value::Object(Map::from_iter([
                (
                    "entityHead".into(),
                    input
                        .actual_replica_meta
                        .get("certifiedFrameHead")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                (
                    "entitySections".into(),
                    input.actual_entity_sections.clone(),
                ),
                (
                    "commitments".into(),
                    commitment_value(input.actual_commitments),
                ),
                (
                    "accountCommits".into(),
                    Value::Array(
                        input
                            .actual_account_commits
                            .iter()
                            .map(account_commit_value)
                            .collect(),
                    ),
                ),
                ("replicaMeta".into(), input.actual_replica_meta.clone()),
            ])),
        ),
    ]));

    fs::create_dir_all(input.directory).map_err(|error| error.to_string())?;
    let path = input
        .directory
        .join(format!("first-divergence-h{}.json", input.height));
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

fn replay_value(frame: &[u8], outputs: &[Vec<u8>], label: &str) -> Result<Value, String> {
    let frame = decode_storage_payload(frame).map_err(|error| format!("{label}-frame:{error}"))?;
    let outputs = outputs
        .iter()
        .enumerate()
        .map(|(index, row)| {
            decode_storage_payload(row).map_err(|error| format!("{label}-output:{index}:{error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Object(Map::from_iter([
        ("frame".into(), frame),
        ("outbox".into(), Value::Array(outputs)),
    ])))
}

fn account_commit_value(commit: &AccountCommitEvidence) -> Value {
    Value::Object(Map::from_iter([
        (
            "accountId".into(),
            Value::String(hex_digest(commit.account_id.as_bytes())),
        ),
        (
            "source".into(),
            Value::String(
                match commit.source {
                    AccountCommitSource::AckCommit => "ackCommit",
                    AccountCommitSource::PeerCommit => "peerCommit",
                }
                .into(),
            ),
        ),
        ("frameHeight".into(), Value::from(commit.frame_height)),
        (
            "stateHash".into(),
            Value::String(hex_digest(&commit.state_hash)),
        ),
        (
            "accountStateRoot".into(),
            Value::String(hex_digest(&commit.account_state_root)),
        ),
    ]))
}

fn commitment_value(commitments: &RuntimeDurableCommitments) -> Value {
    Value::Object(Map::from_iter([
        (
            "accountsRoot".into(),
            Value::String(hex_digest(&commitments.accounts_root)),
        ),
        (
            "entityStateRoot".into(),
            Value::String(hex_digest(&commitments.entity_state_root)),
        ),
        (
            "entityAuthorityRoot".into(),
            Value::String(hex_digest(&commitments.entity_authority_root)),
        ),
        (
            "entityEffectCount".into(),
            Value::from(commitments.entity_effect_count),
        ),
        (
            "entityEffectsDigest".into(),
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
    hex_digest(&Sha256::digest(bytes))
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
    use super::collect_differences;
    use serde_json::{Value, json};

    #[test]
    fn first_difference_names_the_exact_runtime_path() {
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
}
