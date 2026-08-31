//! Canonical restore sources reconstructed from the native path-keyed store.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::storage::native::{
    EntityContextPayloadError, NativeRuntimeStore, NativeStorageError, RecoveredWalFrame,
    RuntimeFrameCodecError, validate_runtime_frame,
};

use super::{
    ConcreteCheckpointSource, ConcreteRestoreSourceError, ConcreteWalSource, VerifiedEntityContext,
    verify_checkpoint_source,
};

pub struct NativeConcreteRestoreSources {
    pub checkpoint: ConcreteCheckpointSource,
    pub wal: Vec<ConcreteWalSource>,
}

#[derive(Debug, Error)]
pub enum NativeRestoreSourceError {
    #[error("RRS_NATIVE_RESTORE_STORAGE:{0}")]
    Storage(#[from] NativeStorageError),
    #[error("RRS_NATIVE_RESTORE_SOURCE:{0}")]
    Source(#[from] ConcreteRestoreSourceError),
    #[error("RRS_NATIVE_RESTORE_CHECKPOINT_MISSING")]
    CheckpointMissing,
    #[error("RRS_NATIVE_RESTORE_MACHINE_ROOT_MISSING")]
    MachineRootMissing,
    #[error("RRS_NATIVE_RESTORE_CANONICAL_ROOT_MISMATCH")]
    CanonicalRootMismatch,
    #[error("RRS_NATIVE_RESTORE_LEAF_COUNT:{0}")]
    LeafCount(u64),
    #[error("RRS_NATIVE_RESTORE_CONTEXT_SET")]
    ContextSet,
    #[error("RRS_NATIVE_RESTORE_CONTEXT:{0}")]
    EntityContext(#[from] EntityContextPayloadError),
    #[error("RRS_NATIVE_RESTORE_FRAME:{0}")]
    Frame(#[from] RuntimeFrameCodecError),
}

/// Recover one complete checkpoint plus its exact ordered WAL tail. Both TS
/// import and ordinary native restart feed the same concrete decoder; there is
/// no replica sidecar and no alternate native-only state model.
pub fn load_native_restore_sources(
    store: &mut NativeRuntimeStore,
) -> Result<NativeConcreteRestoreSources, NativeRestoreSourceError> {
    let recovery = store.recover()?;
    let checkpoint = recovery
        .checkpoint
        .ok_or(NativeRestoreSourceError::CheckpointMissing)?;
    let checkpoint_frame = store.read_durable_frame(checkpoint.height)?;
    let validated = validate_runtime_frame(&checkpoint_frame.frame_bytes)?;
    let canonical = validated
        .canonical_state_hash
        .ok_or(NativeRestoreSourceError::CanonicalRootMismatch)?;
    if canonical != checkpoint.state_root {
        return Err(NativeRestoreSourceError::CanonicalRootMismatch);
    }
    let machine = validated
        .runtime_machine_root
        .ok_or(NativeRestoreSourceError::MachineRootMissing)?;
    let leaf_count = usize::try_from(machine.leaf_count)
        .map_err(|_| NativeRestoreSourceError::LeafCount(machine.leaf_count))?;
    let source = ConcreteCheckpointSource {
        height: checkpoint.height,
        frame_bytes: checkpoint_frame.frame_bytes,
        root_hash: machine.root_hash,
        leaf_count,
        runtime_machine_leaves: checkpoint
            .runtime_machine_leaves
            .into_iter()
            .map(|row| (row.path_bytes, row.value_bytes))
            .collect(),
        state_rows: checkpoint.path_nodes,
    };
    verify_checkpoint_source(&source)?;
    let wal = recovery
        .wal_frames
        .into_iter()
        .map(concrete_wal_source_from_native)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(NativeConcreteRestoreSources {
        checkpoint: source,
        wal,
    })
}

/// Convert one already-validated native WAL frame into the concrete source
/// consumed by restart and replay. This avoids exporting a second recording
/// format merely to replay a live native database.
pub fn concrete_wal_source_from_native(
    frame: RecoveredWalFrame,
) -> Result<ConcreteWalSource, NativeRestoreSourceError> {
    let contexts = frame.entity_contexts.rebuild_contexts()?;
    let refs = frame
        .entity_contexts
        .frame_refs()
        .iter()
        .cloned()
        .collect::<BTreeMap<_, _>>();
    if contexts.keys().ne(refs.keys()) {
        return Err(NativeRestoreSourceError::ContextSet);
    }
    let entity_contexts = contexts
        .into_iter()
        .map(|(replica, value)| {
            Ok((
                replica.clone(),
                VerifiedEntityContext {
                    commitment: refs[&replica],
                    value,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, NativeRestoreSourceError>>()?;
    ConcreteWalSource::new(
        frame.height,
        frame.frame_bytes,
        entity_contexts,
        frame.outputs,
    )
    .map_err(Into::into)
}
