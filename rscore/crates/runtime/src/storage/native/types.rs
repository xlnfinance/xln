//! Values crossing the native Runtime persistence boundary.

use std::collections::BTreeMap;

use super::entity_context::EntityContextPayloadRows;
use super::keys::PathNodeKey;

pub const DEFAULT_CHECKPOINT_PERIOD_FRAMES: u64 = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeStorageConfig {
    pub checkpoint_period_frames: u64,
}

impl Default for NativeStorageConfig {
    fn default() -> Self {
        Self {
            checkpoint_period_frames: DEFAULT_CHECKPOINT_PERIOD_FRAMES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathNodeChange {
    pub key: PathNodeKey,
    pub value: Option<Vec<u8>>,
}

/// One exact canonical Runtime-machine leaf. The physical key is derived by
/// the store as `0x16 || checkpointHeight || path_bytes`; callers cannot
/// smuggle another height or namespace through this row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeMachineLeafRow {
    pub path_bytes: Vec<u8>,
    pub value_bytes: Vec<u8>,
}

/// External J-watcher progress bound to one fixed native path. It is Runtime
/// replica-envelope metadata, never Entity consensus state and never part of
/// the checkpoint Merkle graph. The store overwrites it atomically with the
/// Runtime frame that consumed the corresponding finalized range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeWatcherCursorRow {
    pub entity_id: [u8; 32],
    pub chain_id: u64,
    pub depository_address: [u8; 20],
    pub value_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointGraph {
    pub state_root: [u8; 32],
    /// A full import first deletes every native path row. A cadence checkpoint
    /// normally supplies only net changes since the preceding checkpoint.
    pub full: bool,
    pub node_changes: Vec<PathNodeChange>,
    /// Complete 0x16 leaf set for this checkpoint height. These rows are
    /// rebuilt against the RuntimeFrame's committed root before any write.
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
    pub watcher_cursor_changes: Vec<RuntimeWatcherCursorRow>,
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
    pub retained_history_bytes: u64,
}

impl Default for StorageHead {
    fn default() -> Self {
        Self {
            schema_version: 3,
            latest_height: 0,
            latest_materialized_height: 0,
            latest_snapshot_height: 0,
            snapshot_period_frames: 10_000,
            retain_snapshots: 9_007_199_254_740_991,
            epoch_max_bytes: 9_007_199_254_740_991,
            account_merkle_radix: 16,
            epoch_replay_bytes: 0,
            retained_history_bytes: 0,
        }
    }
}
