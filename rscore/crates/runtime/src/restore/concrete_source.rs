//! Exact processor/storage contract consumed by concrete Runtime restore.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use thiserror::Error;

use crate::storage::native::{ValidatedRuntimeFrame, validate_runtime_frame};
use crate::{
    RuntimeMachineGraphError, StorageMessagePackError, decode_storage_payload,
    rebuild_runtime_machine_graph,
};

/// A materialized checkpoint has two independent row families. Runtime-machine
/// leaves are height-scoped 0x16 rows and authenticate the Runtime envelope;
/// state rows are permanent 0x17-0x38 paths that hydrate Entity/Account data.
#[derive(Debug)]
pub struct ConcreteCheckpointSource {
    pub height: u64,
    /// Exact canonical RuntimeFrame bytes that selected this checkpoint.  The
    /// frame hash becomes the restored durable lineage; a caller may not
    /// substitute the previous frame hash or a transcript-side value.
    pub frame_bytes: Vec<u8>,
    pub root_hash: [u8; 32],
    pub leaf_count: usize,
    /// Exact 0x16 leaf rows with `[tag|height]` already stripped from the key.
    pub runtime_machine_leaves: Vec<(Vec<u8>, Vec<u8>)>,
    pub state_rows: BTreeMap<Vec<u8>, Vec<u8>>,
}

/// One context reconstructed by the canonical 0x14 page reader. The digest is
/// the manifest-row SHA-256 committed in RuntimeFrame.entityContextRefs.
pub struct VerifiedEntityContext {
    pub commitment: [u8; 32],
    pub value: Value,
}

/// One exact Runtime WAL row after native framing/outbox validation. Contexts
/// are explicit because frame bytes contain only authenticated references.
pub struct ConcreteWalSource {
    pub height: u64,
    pub frame_bytes: Vec<u8>,
    pub entity_contexts: BTreeMap<String, VerifiedEntityContext>,
    pub outputs: Vec<Vec<u8>>,
}

#[derive(Debug, Error)]
pub enum ConcreteRestoreSourceError {
    #[error("RRS_RESTORE_SOURCE:{0}")]
    Invalid(String),
    #[error(transparent)]
    Graph(#[from] RuntimeMachineGraphError),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
    #[error("RRS_RESTORE_SOURCE_FRAME:{0}")]
    Frame(String),
}

fn invalid(detail: impl Into<String>) -> ConcreteRestoreSourceError {
    ConcreteRestoreSourceError::Invalid(detail.into())
}

fn hex(bytes: &[u8; 32]) -> String {
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, ConcreteRestoreSourceError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn digest(value: &Value, path: &str) -> Result<[u8; 32], ConcreteRestoreSourceError> {
    let payload = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid(format!("DIGEST:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("DIGEST:{path}")))?;
    }
    Ok(output)
}

fn checkpoint_machine_root(
    frame: &Map<String, Value>,
) -> Result<([u8; 32], usize), ConcreteRestoreSourceError> {
    let root = object(
        frame
            .get("runtimeMachineRoot")
            .ok_or_else(|| invalid("MACHINE_ROOT_MISSING"))?,
        "runtimeMachineRoot",
    )?;
    if root.len() != 2 {
        return Err(invalid("MACHINE_ROOT_FIELDS"));
    }
    let root_hash = digest(
        root.get("rootHash")
            .ok_or_else(|| invalid("MACHINE_ROOT_HASH"))?,
        "runtimeMachineRoot.rootHash",
    )?;
    let leaf_count = root
        .get("leafCount")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991_usize)
        .ok_or_else(|| invalid("MACHINE_ROOT_LEAF_COUNT"))?;
    Ok((root_hash, leaf_count))
}

pub(super) fn verified_checkpoint_frame(
    source: &ConcreteCheckpointSource,
) -> Result<(Value, ValidatedRuntimeFrame), ConcreteRestoreSourceError> {
    let validated = validate_runtime_frame(&source.frame_bytes)
        .map_err(|error| ConcreteRestoreSourceError::Frame(error.to_string()))?;
    if validated.height != source.height {
        return Err(invalid(format!(
            "CHECKPOINT_FRAME_HEIGHT:expected={}:actual={}",
            source.height, validated.height,
        )));
    }
    let frame = decode_storage_payload(&source.frame_bytes)?;
    let object = object(&frame, "frame")?;
    if object.get("materializedState").and_then(Value::as_bool) != Some(true) {
        return Err(invalid("CHECKPOINT_FRAME_NOT_MATERIALIZED"));
    }
    if object.contains_key("pendingRuntimeInput") {
        return Err(invalid("CHECKPOINT_FRAME_PENDING_RUNTIME_INPUT"));
    }
    let (root_hash, leaf_count) = checkpoint_machine_root(object)?;
    if root_hash != source.root_hash || leaf_count != source.leaf_count {
        return Err(invalid("CHECKPOINT_FRAME_MACHINE_ROOT"));
    }
    Ok((frame, validated))
}

pub(crate) fn context_refs(
    frame: &Map<String, Value>,
) -> Result<BTreeMap<String, [u8; 32]>, ConcreteRestoreSourceError> {
    let Some(value) = frame.get("entityContextRefs") else {
        return Ok(BTreeMap::new());
    };
    let value = object(value, "entityContextRefs")?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(invalid("CONTEXT_REFS_MAP"));
    }
    let rows = value
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("CONTEXT_REFS_ROWS"))?;
    let mut output = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("CONTEXT_REF_ROW:{index}")))?;
        let replica = row[0]
            .as_str()
            .filter(|value| !value.is_empty() && *value == value.to_lowercase())
            .ok_or_else(|| invalid(format!("CONTEXT_REF_REPLICA:{index}")))?
            .to_owned();
        let commitment = digest(&row[1], "entityContextRefs.digest")?;
        if output.insert(replica.clone(), commitment).is_some() {
            return Err(invalid(format!("CONTEXT_REF_DUPLICATE:{replica}")));
        }
    }
    Ok(output)
}

/// Verify the existing TS Runtime-machine root and return the exact restored
/// envelope. Branch rows are deliberately unnecessary: leaves deterministically
/// rebuild them and therefore detect corrupt/truncated branch caches.
pub fn verify_checkpoint_source(
    source: &ConcreteCheckpointSource,
) -> Result<Value, ConcreteRestoreSourceError> {
    if source.height == 0 || source.leaf_count == 0 {
        return Err(invalid("CHECKPOINT_HEIGHT_OR_LEAVES"));
    }
    if source.state_rows.is_empty() {
        return Err(invalid("CHECKPOINT_STATE_ROWS_EMPTY"));
    }
    verified_checkpoint_frame(source)?;
    rebuild_runtime_machine_graph(
        source.runtime_machine_leaves.clone(),
        &hex(&source.root_hash),
        source.leaf_count,
    )
    .map_err(Into::into)
}

/// Validate framing plus the exact set of authenticated 0x14 contexts. The
/// processor may not omit an unused-looking context or attach a newer value.
pub fn verify_wal_source(source: &ConcreteWalSource) -> Result<Value, ConcreteRestoreSourceError> {
    let validated = crate::storage::native::validate_runtime_frame(&source.frame_bytes)
        .map_err(|error| ConcreteRestoreSourceError::Frame(error.to_string()))?;
    if validated.height != source.height || validated.output_count != source.outputs.len() {
        return Err(invalid("WAL_HEADER"));
    }
    let frame = decode_storage_payload(&source.frame_bytes)?;
    let expected = context_refs(object(&frame, "frame")?)?;
    let actual = source
        .entity_contexts
        .iter()
        .map(|(replica, context)| (replica.clone(), context.commitment))
        .collect::<BTreeMap<_, _>>();
    if expected != actual {
        let expected_keys = expected.keys().cloned().collect::<BTreeSet<_>>();
        let actual_keys = actual.keys().cloned().collect::<BTreeSet<_>>();
        return Err(invalid(format!(
            "CONTEXT_SET:missing={:?}:extra={:?}",
            expected_keys.difference(&actual_keys).collect::<Vec<_>>(),
            actual_keys.difference(&expected_keys).collect::<Vec<_>>(),
        )));
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use sha2::{Digest as _, Sha256};
    use xln_rscore_protocol::{CanonicalValue, PersistentRadixMap};

    use super::*;

    fn encoded(value: CanonicalValue) -> Vec<u8> {
        crate::encode_storage_payload(&value).expect("fixture value")
    }

    fn graph_fixture_with_pending(pending: bool) -> ConcreteCheckpointSource {
        let rows = vec![
            (
                encoded(CanonicalValue::Array(Vec::new())),
                encoded(CanonicalValue::Object(vec![
                    ("kind".into(), CanonicalValue::String("container".into())),
                    ("container".into(), CanonicalValue::String("object".into())),
                ])),
            ),
            (
                encoded(CanonicalValue::Array(vec![CanonicalValue::Object(vec![
                    ("kind".into(), CanonicalValue::String("property".into())),
                    ("name".into(), CanonicalValue::String("runtimeId".into())),
                ])])),
                encoded(CanonicalValue::Object(vec![
                    ("kind".into(), CanonicalValue::String("atom".into())),
                    ("value".into(), CanonicalValue::String("h1".into())),
                ])),
            ),
        ];
        let mut radix = PersistentRadixMap::empty();
        for (key, value) in &rows {
            let decoded = crate::decode_storage_payload(value).expect("decode fixture");
            radix = radix
                .updated(key.clone(), decoded, Sha256::digest(value).into())
                .expect("fixture radix");
        }
        let root_hash = radix.root_hash();
        let frame_bytes = crate::storage::native::build_runtime_frame_commit(
            crate::storage::native::CanonicalRuntimeFrameDraft {
                height: 100,
                timestamp: 1_000,
                prev_frame_hash: [0; 32],
                replica_meta_digest: [1; 32],
                runtime_component_digests: vec![],
                materialized_state: true,
                canonical_state: Some(crate::storage::native::CanonicalStateCommitment {
                    state_hash: [2; 32],
                    entity_hashes: vec![crate::storage::native::RuntimeFrameEntityHash {
                        entity_id: format!("0x{}", "11".repeat(32)),
                        hash: [3; 32],
                        cell_count: 1,
                    }],
                }),
                runtime_input: serde_json::json!({"runtimeTxs": [], "entityInputs": []}),
                pending_runtime_input: pending
                    .then(|| serde_json::json!({"runtimeTxs": [], "entityInputs": []})),
                runtime_machine_root: Some(crate::storage::native::RuntimeMachineGraphRoot {
                    root_hash,
                    leaf_count: rows.len() as u64,
                }),
                account_authority_checkpoints: vec![],
                touched_entities: vec![],
                touched_accounts: vec![],
                touched_book_entities: vec![],
            },
            crate::storage::native::EntityContextPayloadRows::empty(),
            vec![],
            None,
        )
        .expect("checkpoint frame")
        .commit
        .frame_bytes;
        ConcreteCheckpointSource {
            height: 100,
            frame_bytes,
            root_hash,
            leaf_count: rows.len(),
            runtime_machine_leaves: rows,
            state_rows: BTreeMap::from([(vec![0x21; 33], vec![0x03, 0x80])]),
        }
    }

    fn graph_fixture() -> ConcreteCheckpointSource {
        graph_fixture_with_pending(false)
    }

    #[test]
    fn runtime_machine_leaves_rebuild_the_committed_root() {
        let source = graph_fixture();
        let restored = verify_checkpoint_source(&source).expect("verified graph");
        assert_eq!(restored["runtimeId"], Value::String("h1".into()));
    }

    #[test]
    fn truncated_runtime_machine_graph_is_rejected() {
        let mut source = graph_fixture();
        source.runtime_machine_leaves.pop();
        assert!(matches!(
            verify_checkpoint_source(&source),
            Err(ConcreteRestoreSourceError::Graph(
                RuntimeMachineGraphError::LeafCount { .. }
            ))
        ));
    }

    #[test]
    fn pending_runtime_input_checkpoint_is_rejected_instead_of_dropped() {
        let source = graph_fixture_with_pending(true);
        let error = verify_checkpoint_source(&source).expect_err("pending FIFO must be explicit");
        assert!(
            error
                .to_string()
                .contains("CHECKPOINT_FRAME_PENDING_RUNTIME_INPUT")
        );
    }
}
