use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::{RuntimeComponentDigest, RuntimePostStateCommitment, compute_storage_post_state_hash};

use super::super::codec::output_digest;
use super::super::{CheckpointGraph, EntityContextPayloadRows, RuntimeFrameCommit};
use super::rows::{
    canonical_entity_hashes, checkpoint_refs, context_refs, sorted_strings, touched_accounts,
};
use super::types::{
    CanonicalRuntimeFrameDraft, Digest, EncodedRuntimeFrame, RuntimeFrameCodecError,
};
use super::value::{encode, encode_frame_record, format_hash, number, object, parse_hash, text};
use super::{FRAME_DOMAIN, MAX_SAFE_INTEGER};

fn validate_runtime_input(
    value: &Value,
    field: &'static str,
) -> Result<(), RuntimeFrameCodecError> {
    if !value.is_object() {
        return Err(RuntimeFrameCodecError::RuntimeInputObject(field));
    }
    Ok(())
}

fn post_state_hash(
    draft: &CanonicalRuntimeFrameDraft,
    output_count: usize,
    outputs_digest: &Digest,
) -> Result<Digest, RuntimeFrameCodecError> {
    let count = u64::try_from(output_count).map_err(|_| RuntimeFrameCodecError::UnsafeNumber {
        field: "runtimeOutputCount",
        value: u64::MAX,
    })?;
    let mut components = draft.runtime_component_digests.clone();
    components.sort_by(|left, right| left.key.cmp(&right.key));
    if components.windows(2).any(|pair| pair[0].key == pair[1].key) {
        return Err(RuntimeFrameCodecError::Field("runtimeComponentDigests"));
    }
    validate_component_digests(&components)?;
    parse_hash(&compute_storage_post_state_hash(
        &RuntimePostStateCommitment {
            height: draft.height,
            timestamp: draft.timestamp,
            replica_meta_digest: format_hash(&draft.replica_meta_digest),
            runtime_component_digests: components,
            runtime_output_count: count,
            runtime_outputs_digest: format_hash(outputs_digest),
        },
    )?)
}

fn validate_component_digests(
    entries: &[RuntimeComponentDigest],
) -> Result<(), RuntimeFrameCodecError> {
    for entry in entries {
        parse_hash(&entry.value_hash)
            .map_err(|_| RuntimeFrameCodecError::Field("runtimeComponentDigests.valueHash"))?;
    }
    Ok(())
}

fn validate_draft(draft: &CanonicalRuntimeFrameDraft) -> Result<(), RuntimeFrameCodecError> {
    if draft.height == 0 || draft.height > MAX_SAFE_INTEGER {
        return Err(RuntimeFrameCodecError::UnsafeNumber {
            field: "height",
            value: draft.height,
        });
    }
    if draft.timestamp > MAX_SAFE_INTEGER {
        return Err(RuntimeFrameCodecError::UnsafeNumber {
            field: "timestamp",
            value: draft.timestamp,
        });
    }
    validate_runtime_input(&draft.runtime_input, "runtimeInput")?;
    if let Some(pending) = &draft.pending_runtime_input {
        validate_runtime_input(pending, "pendingRuntimeInput")?;
    }
    if draft.materialized_state && draft.canonical_state.is_none() {
        return Err(RuntimeFrameCodecError::MaterializedRootsRequired);
    }
    if (draft.materialized_state || draft.canonical_state.is_some())
        && draft.runtime_machine_root.is_none()
    {
        return Err(RuntimeFrameCodecError::MachineRootRequired);
    }
    Ok(())
}

fn required_fields(
    draft: &CanonicalRuntimeFrameDraft,
    output_count: usize,
    outputs_digest: &Digest,
) -> Result<Map<String, Value>, RuntimeFrameCodecError> {
    let count = u64::try_from(output_count).map_err(|_| RuntimeFrameCodecError::UnsafeNumber {
        field: "runtimeOutputCount",
        value: u64::MAX,
    })?;
    let post_hash = post_state_hash(draft, output_count, outputs_digest)?;
    Ok(Map::from_iter([
        ("height".into(), number("height", draft.height)?),
        ("timestamp".into(), number("timestamp", draft.timestamp)?),
        (
            "prevFrameHash".into(),
            text(format_hash(&draft.prev_frame_hash)),
        ),
        (
            "replicaMetaDigest".into(),
            text(format_hash(&draft.replica_meta_digest)),
        ),
        ("postStateHash".into(), text(format_hash(&post_hash))),
        (
            "materializedState".into(),
            Value::Bool(draft.materialized_state),
        ),
        ("runtimeInput".into(), draft.runtime_input.clone()),
        (
            "runtimeOutputCount".into(),
            number("runtimeOutputCount", count)?,
        ),
        (
            "runtimeOutputsDigest".into(),
            text(format_hash(outputs_digest)),
        ),
        (
            "touchedEntities".into(),
            sorted_strings(&draft.touched_entities),
        ),
        (
            "touchedAccounts".into(),
            touched_accounts(&draft.touched_accounts),
        ),
        (
            "touchedBookEntities".into(),
            sorted_strings(&draft.touched_book_entities),
        ),
    ]))
}

fn add_optional_fields(
    fields: &mut Map<String, Value>,
    draft: &CanonicalRuntimeFrameDraft,
    entity_contexts: &EntityContextPayloadRows,
) -> Result<(), RuntimeFrameCodecError> {
    if let Some(state) = &draft.canonical_state {
        fields.insert(
            "canonicalStateHash".into(),
            text(format_hash(&state.state_hash)),
        );
        fields.insert(
            "canonicalEntityHashes".into(),
            canonical_entity_hashes(&state.entity_hashes)?,
        );
        fields.insert(
            "runtimeStateHash".into(),
            text(format_hash(&state.state_hash)),
        );
    }
    if let Some(value) = context_refs(entity_contexts.frame_refs())? {
        fields.insert("entityContextRefs".into(), value);
    }
    if let Some(value) = &draft.pending_runtime_input {
        fields.insert("pendingRuntimeInput".into(), value.clone());
    }
    if let Some(root) = &draft.runtime_machine_root {
        fields.insert(
            "runtimeMachineRoot".into(),
            object(vec![
                ("rootHash", text(format_hash(&root.root_hash))),
                (
                    "leafCount",
                    number("runtimeMachineRoot.leafCount", root.leaf_count)?,
                ),
            ]),
        );
    }
    if let Some(value) = checkpoint_refs(&draft.account_authority_checkpoints)? {
        fields.insert("accountAuthorityCheckpoints".into(), value);
    }
    Ok(())
}

fn compute_frame_hash(fields: &Map<String, Value>) -> Result<Digest, RuntimeFrameCodecError> {
    let mut committed = fields.clone();
    committed.insert("kind".into(), text(FRAME_DOMAIN));
    committed
        .entry("canonicalEntityHashes")
        .or_insert_with(|| Value::Array(vec![]));
    Ok(Sha256::digest(encode(&Value::Object(committed))?).into())
}

pub fn build_runtime_frame_commit(
    draft: CanonicalRuntimeFrameDraft,
    entity_contexts: EntityContextPayloadRows,
    outputs: Vec<Vec<u8>>,
    checkpoint: Option<CheckpointGraph>,
) -> Result<EncodedRuntimeFrame, RuntimeFrameCodecError> {
    validate_draft(&draft)?;
    let digest = output_digest(&outputs)
        .map_err(|_| RuntimeFrameCodecError::Field("runtimeOutputsDigest"))?;
    let post_state_hash = post_state_hash(&draft, outputs.len(), &digest)?;
    let mut fields = required_fields(&draft, outputs.len(), &digest)?;
    add_optional_fields(&mut fields, &draft, &entity_contexts)?;
    let frame_hash = compute_frame_hash(&fields)?;
    fields.insert("frameHash".into(), text(format_hash(&frame_hash)));
    let frame_bytes = encode_frame_record(&Value::Object(fields))?;
    Ok(EncodedRuntimeFrame {
        frame_hash,
        post_state_hash,
        output_digest: digest,
        commit: RuntimeFrameCommit {
            height: draft.height,
            frame_bytes,
            outputs,
            entity_contexts,
            watcher_cursor_changes: Vec::new(),
            checkpoint,
        },
    })
}
