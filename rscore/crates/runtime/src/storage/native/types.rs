//! Values crossing the native Runtime persistence boundary.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use super::entity_context::EntityContextPayloadRows;
use super::keys::PathNodeKey;

pub const DEFAULT_CHECKPOINT_PERIOD_FRAMES: u64 = 1_000;

/// RAM-only wall decomposition of one native WAL append. It is returned to
/// the committer for diagnostics and never enters HEAD, a frame or checkpoint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct NativeStorageTimings {
    pub prepare_validate: Duration,
    pub batch_build: Duration,
    pub db_write_sync: Duration,
    pub directory_sync: Duration,
    pub post_commit: Duration,
}

impl NativeStorageTimings {
    pub(crate) fn accounted(self) -> Duration {
        self.prepare_validate
            + self.batch_build
            + self.db_write_sync
            + self.directory_sync
            + self.post_commit
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeStorageConfig {
    pub checkpoint_period_frames: u64,
    /// When false, LevelDB writes skip per-frame fsync and directory sync.
    /// Only valid for derived, restartable databases (replay verification);
    /// every production store must keep the default.
    pub durable_fsync: bool,
}

impl Default for NativeStorageConfig {
    fn default() -> Self {
        Self {
            checkpoint_period_frames: DEFAULT_CHECKPOINT_PERIOD_FRAMES,
            durable_fsync: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathNodeChange {
    pub key: PathNodeKey,
    pub value: Option<Vec<u8>>,
}

/// One exact canonical Runtime-machine leaf. The physical key is derived by
/// the store as the stable `0x16 || path_bytes`; callers cannot smuggle a
/// generation or another namespace through this row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeMachineLeafRow {
    pub path_bytes: Vec<u8>,
    pub value_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointGraph {
    pub state_root: [u8; 32],
    /// A full import first deletes every native path row. A cadence checkpoint
    /// normally supplies only net changes since the preceding checkpoint.
    pub full: bool,
    pub node_changes: Vec<PathNodeChange>,
    /// Complete current 0x16 leaf set. These rows are rebuilt against the
    /// RuntimeFrame's committed root before atomically replacing stable paths.
    pub runtime_machine_leaves: Vec<RuntimeMachineLeafRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFrameCommit {
    pub height: u64,
    /// Exact canonical `0x03 || msgpackr` RuntimeFrame bytes.
    pub frame_bytes: Vec<u8>,
    /// Exact canonical `0x03 || msgpackr` output rows, in publication order.
    pub outputs: Vec<Vec<u8>>,
    /// Complete verified v2 Entity replay-context graphs. The RuntimeFrame
    /// references are derived from these rows and can never be supplied alone.
    pub entity_contexts: EntityContextPayloadRows,
    pub checkpoint: Option<CheckpointGraph>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableRuntimeFrame {
    pub(super) height: u64,
    pub(super) output_count: usize,
    pub(super) output_digest: [u8; 32],
    /// Exact rows that were just included in the synced write batch. They are
    /// retained only until immediate publication; recovered resend tokens use
    /// `None` and read the same rows from LevelDB.
    pub(super) resident_outputs: Option<Vec<Vec<u8>>>,
    /// Ephemeral by-construction projection paired with `resident_outputs`.
    /// A recovered token never has it; publication consumes it exactly once.
    pub(super) resident_output_values: RefCell<Option<Vec<Value>>>,
}

impl DurableRuntimeFrame {
    pub fn height(&self) -> u64 {
        self.height
    }

    pub fn output_count(&self) -> usize {
        self.output_count
    }

    pub(crate) fn resident_outputs(&self) -> Option<&[Vec<u8>]> {
        self.resident_outputs.as_deref()
    }

    pub(crate) fn take_resident_output_values(&self) -> Option<Vec<Value>> {
        self.resident_output_values.borrow_mut().take()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredCheckpoint {
    pub height: u64,
    pub state_root: [u8; 32],
    pub path_nodes: BTreeMap<Vec<u8>, Vec<u8>>,
    pub runtime_machine_leaves: Vec<RuntimeMachineLeafRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredWalFrame {
    pub height: u64,
    pub frame_bytes: Vec<u8>,
    pub outputs: Vec<Vec<u8>>,
    pub entity_contexts: EntityContextPayloadRows,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredOutboxFrame {
    pub height: u64,
    pub outputs: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeRuntimeRecovery {
    pub checkpoint: Option<RecoveredCheckpoint>,
    pub wal_frames: Vec<RecoveredWalFrame>,
    /// No transport receipt is durable. Recovery therefore republishes the
    /// materialized frame plus its WAL tail in height order; duplicate Account
    /// inputs are removed only by bilateral Account consensus.
    pub pending_outbox: Vec<RecoveredOutboxFrame>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StorageHead {
    pub schema_version: u64,
    pub latest_height: u64,
    pub latest_materialized_height: u64,
    pub latest_snapshot_height: u64,
    pub snapshot_period_frames: u64,
    pub retain_snapshots: u64,
    pub epoch_max_bytes: u64,
    pub account_merkle_radix: u64,
    pub epoch_replay_bytes: u64,
    pub retained_wal_bytes: u64,
}

impl Default for StorageHead {
    fn default() -> Self {
        Self {
            schema_version: 5,
            latest_height: 0,
            latest_materialized_height: 0,
            latest_snapshot_height: 0,
            snapshot_period_frames: 10_000,
            retain_snapshots: 9_007_199_254_740_991,
            epoch_max_bytes: 9_007_199_254_740_991,
            account_merkle_radix: 16,
            epoch_replay_bytes: 0,
            retained_wal_bytes: 0,
        }
    }
}
