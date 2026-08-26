use serde_json::{Map, Value};
use thiserror::Error;

use crate::{
    RuntimeComponentDigest, RuntimePostStateCommitment, TaggedJsonError,
    canonical_value_from_tagged_json, compute_runtime_component_digest,
    compute_storage_post_state_hash,
};

const DURABLE_INFRASTRUCTURE_KEYS: &[&str] = &[
    "maxEntityInputsPerFrame",
    "maxEntityTxsPerFrame",
    "runtimeAdapterCommandFrontiers",
    "pendingCommittedJOutbox",
    "pendingJurisdictionImports",
    "numberedRegistrationIntents",
    "certifiedRegistrationEvidence",
    "entityEncryptionSeeds",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordingPostStateCheck {
    pub height: u64,
    pub expected: String,
    pub actual: String,
}

impl RecordingPostStateCheck {
    pub fn matches(&self) -> bool {
        self.expected == self.actual
    }
}

#[derive(Debug, Error)]
pub enum RuntimeRecordingError {
    #[error("RUNTIME_RECORDING_FIELD_MISSING:{0}")]
    Missing(&'static str),
    #[error("RUNTIME_RECORDING_FIELD_INVALID:{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    TaggedJson(#[from] TaggedJsonError),
    #[error(transparent)]
    Commitment(#[from] crate::RuntimeCommitmentError),
}

fn field<'a>(value: &'a Value, name: &'static str) -> Result<&'a Value, RuntimeRecordingError> {
    value.get(name).ok_or(RuntimeRecordingError::Missing(name))
}

fn object<'a>(
    value: &'a Value,
    name: &'static str,
) -> Result<&'a Map<String, Value>, RuntimeRecordingError> {
    value
        .as_object()
        .ok_or(RuntimeRecordingError::Invalid(name))
}

fn unsigned(value: &Value, name: &'static str) -> Result<u64, RuntimeRecordingError> {
    value.as_u64().ok_or(RuntimeRecordingError::Invalid(name))
}

fn string(value: &Value, name: &'static str) -> Result<String, RuntimeRecordingError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or(RuntimeRecordingError::Invalid(name))
}

fn has_durable_entries(value: &Value) -> bool {
    match value {
        Value::Array(values) => !values.is_empty(),
        Value::Object(object) => object
            .get("__xlnType")
            .and_then(Value::as_str)
            .filter(|tag| matches!(*tag, "Map" | "Set"))
            .and_then(|_| object.get("value"))
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty()),
        _ => false,
    }
}

fn project_infrastructure(checkpoint: &Value) -> Result<Option<Value>, RuntimeRecordingError> {
    let Some(source) = checkpoint.get("infrastructure") else {
        return Ok(None);
    };
    let source = object(source, "checkpoint.infrastructure")?;
    let mut projected = Map::new();
    for key in DURABLE_INFRASTRUCTURE_KEYS {
        let Some(value) = source.get(*key) else {
            continue;
        };
        let scalar_limit = matches!(*key, "maxEntityInputsPerFrame" | "maxEntityTxsPerFrame");
        if scalar_limit || has_durable_entries(value) {
            projected.insert((*key).to_string(), value.clone());
        }
    }
    Ok((!projected.is_empty()).then_some(Value::Object(projected)))
}

fn project_j_replicas(checkpoint: &Value) -> Result<Value, RuntimeRecordingError> {
    let rows = field(checkpoint, "jReplicas")?
        .as_array()
        .ok_or(RuntimeRecordingError::Invalid("checkpoint.jReplicas"))?;
    let mut projected = Vec::with_capacity(rows.len());
    for row in rows {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(RuntimeRecordingError::Invalid("checkpoint.jReplicas.row"))?;
        let mut replica = object(&pair[1], "checkpoint.jReplicas.replica")?.clone();
        replica.insert("lastBlockTimestamp".to_string(), Value::from(0));
        projected.push(Value::Array(vec![pair[0].clone(), Value::Object(replica)]));
    }
    Ok(Value::Array(projected))
}

fn digest(value: &Value) -> Result<String, RuntimeRecordingError> {
    Ok(compute_runtime_component_digest(
        &canonical_value_from_tagged_json(value)?,
    )?)
}

fn base_component_digests(
    checkpoint: &Value,
) -> Result<Vec<RuntimeComponentDigest>, RuntimeRecordingError> {
    let mut rows = Vec::with_capacity(3);
    if let Some(infrastructure) = project_infrastructure(checkpoint)? {
        rows.push(RuntimeComponentDigest {
            key: "infrastructure".to_string(),
            value_hash: digest(&infrastructure)?,
        });
    }
    rows.push(RuntimeComponentDigest {
        key: "jReplicas".to_string(),
        value_hash: digest(&project_j_replicas(checkpoint)?)?,
    });
    rows.push(RuntimeComponentDigest {
        key: "runtimeId".to_string(),
        value_hash: digest(field(checkpoint, "runtimeId")?)?,
    });
    rows.sort_unstable_by(|left, right| left.key.cmp(&right.key));
    Ok(rows)
}

/// Verify the Runtime-machine portion of canonical WAL frame commitments.
/// This does not execute Entity or Account transitions; it proves that Rust
/// hashes the same durable Runtime values before the execution layer is added.
pub fn verify_recording_post_state_hashes(
    root: &Value,
    through_height: Option<u64>,
) -> Result<Vec<RecordingPostStateCheck>, RuntimeRecordingError> {
    let bundles = field(field(root, "recording")?, "bundles")?
        .as_array()
        .ok_or(RuntimeRecordingError::Invalid("recording.bundles"))?;
    let snapshot = bundles
        .iter()
        .find(|bundle| bundle.get("kind").and_then(Value::as_str) == Some("snapshot"))
        .ok_or(RuntimeRecordingError::Missing("recording.snapshot"))?;
    let journal = bundles
        .iter()
        .find(|bundle| bundle.get("kind").and_then(Value::as_str) == Some("journal_tail"))
        .ok_or(RuntimeRecordingError::Missing("recording.journal_tail"))?;
    let checkpoint = field(snapshot, "checkpoint")?;
    let base = base_component_digests(checkpoint)?;
    let frames = field(journal, "frames")?
        .as_array()
        .ok_or(RuntimeRecordingError::Invalid("recording.frames"))?;
    let mut checks = Vec::new();
    for frame in frames {
        let height = unsigned(field(frame, "height")?, "frame.height")?;
        if through_height.is_some_and(|maximum| height > maximum) {
            break;
        }
        let mut components = base.clone();
        components.push(RuntimeComponentDigest {
            key: "runtimeInput".to_string(),
            value_hash: digest(field(frame, "pendingRuntimeInput")?)?,
        });
        components.sort_unstable_by(|left, right| left.key.cmp(&right.key));
        let output_refs = field(frame, "runtimeOutputRefs")?
            .as_array()
            .ok_or(RuntimeRecordingError::Invalid("frame.runtimeOutputRefs"))?
            .iter()
            .map(|value| string(value, "frame.runtimeOutputRef"))
            .collect::<Result<Vec<_>, _>>()?;
        let actual = compute_storage_post_state_hash(&RuntimePostStateCommitment {
            height,
            timestamp: unsigned(field(frame, "timestamp")?, "frame.timestamp")?,
            replica_meta_digest: string(
                field(frame, "replicaMetaDigest")?,
                "frame.replicaMetaDigest",
            )?,
            runtime_component_digests: components,
            runtime_output_refs: output_refs,
        })?;
        checks.push(RecordingPostStateCheck {
            height,
            expected: string(field(frame, "postStateHash")?, "frame.postStateHash")?,
            actual,
        });
    }
    Ok(checks)
}
