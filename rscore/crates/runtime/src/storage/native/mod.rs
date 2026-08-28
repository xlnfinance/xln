//! Native single-Entity Runtime persistence.
//!
//! The sole commit point is one LevelDB batch followed by real filesystem
//! `sync_all`. Exact RuntimeFrame bytes, flat outbox rows, checkpoint path
//! changes and HEAD share that boundary. A caller may publish outputs only
//! from the returned [`DurableRuntimeFrame`].

mod bounded;
mod codec;
mod entity_context;
mod frame;
mod fsync;
mod keys;
mod recovery;
mod store;
mod types;

use thiserror::Error;

pub use entity_context::{
    EntityContextPayloadDigest, EntityContextPayloadError, EntityContextPayloadKind,
    EntityContextPayloadRow, EntityContextPayloadRows,
};
pub(crate) use entity_context::{entity_context_height_prefix, parse_entity_context_payload_key};
pub(crate) use frame::decode_and_validate_runtime_frame;
pub use frame::{
    AccountAuthorityCheckpointRef, CanonicalRuntimeFrameDraft, CanonicalStateCommitment,
    EncodedRuntimeFrame, RuntimeFrameCodecError, RuntimeFrameEntityHash, RuntimeMachineGraphRoot,
    TouchedAccount, ValidatedRuntimeFrame, build_runtime_frame_commit, validate_runtime_frame,
};
#[cfg(test)]
pub(crate) use frame::{reset_runtime_frame_validation_count, runtime_frame_validation_count};
pub use keys::PathNodeKey;
pub(crate) use keys::valid_path_key;
pub use store::NativeRuntimeStore;
pub use types::{
    CheckpointGraph, DurableRuntimeFrame, NativeRuntimeRecovery, NativeStorageConfig,
    PathNodeChange, RecoveredCheckpoint, RecoveredOutboxFrame, RecoveredWalFrame,
    RuntimeFrameCommit, RuntimeMachineLeafRow, RuntimeWatcherCursorRow,
};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_OUTPUT_ROWS: usize = 10_000;

#[derive(Debug, Error)]
pub enum NativeStorageError {
    #[error("RRS_STORAGE_DATABASE:{0}")]
    Database(String),
    #[error("RRS_STORAGE_FSYNC:{0}")]
    Fsync(std::io::Error),
    #[error("RRS_STORAGE_POISONED")]
    Poisoned,
    #[error("RRS_STORAGE_CHECKPOINT_PERIOD")]
    CheckpointPeriod,
    #[error("RRS_STORAGE_CHECKPOINT_REQUIRED:{0}")]
    CheckpointRequired(u64),
    #[error("RRS_STORAGE_CHECKPOINT:{0}")]
    Checkpoint(&'static str),
    #[error("RRS_STORAGE_HEIGHT:expected={expected}:actual={actual}")]
    Height { expected: u64, actual: u64 },
    #[error("RRS_STORAGE_HEIGHT_OVERFLOW")]
    HeightOverflow,
    #[error("RRS_STORAGE_FRAME_HEIGHT:key={key}:frame={frame}")]
    FrameHeight { key: u64, frame: u64 },
    #[error("RRS_STORAGE_FRAME_BYTES:{0}")]
    FrameBytes(usize),
    #[error("RRS_STORAGE_FRAME_FIELD:{0}")]
    FrameField(&'static str),
    #[error(transparent)]
    FrameCodec(#[from] frame::RuntimeFrameCodecError),
    #[error("RRS_STORAGE_FRAME_OUTPUT_COUNT:frame={frame}:rows={rows}")]
    FrameOutputCount { frame: usize, rows: usize },
    #[error("RRS_STORAGE_OUTPUT_COUNT:{0}")]
    OutputCount(usize),
    #[error("RRS_STORAGE_OUTPUT_BYTES:{0}")]
    OutputBytes(usize),
    #[error("RRS_STORAGE_OUTPUT_DIGEST:{0}")]
    OutputDigest(u64),
    #[error("RRS_STORAGE_DURABLE_TOKEN:{0}")]
    DurableToken(u64),
    #[error("RRS_STORAGE_NOT_DURABLE:{0}")]
    NotDurable(u64),
    #[error("RRS_STORAGE_MISSING:{0:?}")]
    Missing(Vec<u8>),
    #[error("RRS_STORAGE_PATH_KEY:{0:?}")]
    PathKey(Vec<u8>),
    #[error("RRS_STORAGE_DUPLICATE_NODE_KEY:{0:?}")]
    DuplicateNodeKey(Vec<u8>),
    #[error("RRS_STORAGE_RUNTIME_MACHINE_PATH")]
    RuntimeMachinePath,
    #[error("RRS_STORAGE_RUNTIME_MACHINE_ROOT_MISSING")]
    RuntimeMachineRootMissing,
    #[error("RRS_STORAGE_RUNTIME_MACHINE_ROOT_MISMATCH")]
    RuntimeMachineRootMismatch,
    #[error("RRS_STORAGE_CHECKPOINT_IMPORT_NOT_EMPTY")]
    CheckpointImportNotEmpty,
    #[error("RRS_STORAGE_CHECKPOINT_IMPORT_FULL_REQUIRED")]
    CheckpointImportFullRequired,
    #[error("RRS_STORAGE_WATCHER_CURSOR_COUNT:{0}")]
    WatcherCursorCount(usize),
    #[error("RRS_STORAGE_WATCHER_CURSOR_DUPLICATE")]
    WatcherCursorDuplicate,
    #[error("RRS_STORAGE_WATCHER_CURSOR_VALUE:{0}")]
    WatcherCursorValue(&'static str),
    #[error("RRS_STORAGE_HEAD:{0}")]
    Head(&'static str),
    #[error("RRS_STORAGE_UNSAFE_NUMBER:{0}")]
    UnsafeNumber(u64),
    #[error("RRS_STORAGE_BYTE_COUNT_OVERFLOW")]
    ByteCountOverflow,
    #[error("RRS_STORAGE_BOUNDED_VALUE:{0}")]
    BoundedValue(String),
    #[error(transparent)]
    EntityContext(#[from] EntityContextPayloadError),
    #[error(transparent)]
    MessagePack(#[from] crate::StorageMessagePackError),
    #[error(transparent)]
    Commitment(#[from] crate::RuntimeCommitmentError),
    #[error(transparent)]
    RuntimeMachineGraph(#[from] crate::RuntimeMachineGraphError),
}

#[cfg(test)]
mod tests;
