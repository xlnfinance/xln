//! Exact, atomic Runtime restore boundary.

#[path = "account/account_canonical.rs"]
mod account_canonical;
#[path = "account/account_checkpoint.rs"]
mod account_checkpoint;
#[path = "account/account_tx.rs"]
mod account_tx;
#[path = "account/account_value.rs"]
mod account_value;
mod certified_board_registry;
mod concrete;
mod concrete_source;
mod decode_checkpoint;
#[path = "entity/entity_consensus.rs"]
mod entity_consensus;
#[path = "entity/entity_frame_head.rs"]
mod entity_frame_head;
#[path = "entity/entity_graph.rs"]
mod entity_graph;
#[path = "entity/entity_snapshot.rs"]
mod entity_snapshot;
#[path = "entity/entity_tree.rs"]
mod entity_tree;
mod model;
#[path = "native/source.rs"]
mod native_source;
mod orchestrator;
#[path = "orderbook/orderbook_accounts.rs"]
mod orderbook_accounts;
#[path = "orderbook/orderbook_graph.rs"]
mod orderbook_graph;
#[path = "orderbook/orderbook_metadata.rs"]
mod orderbook_metadata;
#[path = "native/path_checkpoint.rs"]
mod path_checkpoint;
mod source;
mod verification;
mod wal_input;

pub use model::{
    DurableRuntimeIdentity, ExactRuntimeCheckpoint, ExactRuntimeWalFrame, RestoreBoundary,
    RestoreCommitments, RestoreDigest, RestoreHead,
};
pub use native_source::{
    NativeConcreteRestoreSources, NativeRestoreSourceError, load_native_restore_sources,
};
pub use orchestrator::{
    ExactRestoreError, ExactRestoreTarget, RestoreStage, restore_exact_runtime,
};
pub use source::{
    LevelDbRuntimeInput, RestoreSourceError, RuntimeRestoreHeights, load_exact_leveldb_wal_tail,
    read_runtime_restore_heights,
};

#[cfg(test)]
mod tests;
pub use account_checkpoint::decode_account_rows;
pub use account_value::AccountWireRestoreError;
pub use certified_board_registry::{
    CertifiedBoardRegistryRestoreError, hydrate_certified_board_registry,
};
pub use concrete::{
    ConcreteRestoreError, DecodedRuntimeCheckpoint, DecodedRuntimeWalFrame, RestoredRuntime,
    replay_decoded_runtime_wal, restore_decoded_runtime_checkpoint,
};
pub(crate) use concrete_source::VerifiedWalFrame;
pub use concrete_source::{
    ConcreteCheckpointSource, ConcreteRestoreSourceError, ConcreteWalSource, VerifiedEntityContext,
    verify_checkpoint_source,
};
pub use decode_checkpoint::{
    ConcreteCheckpointConfiguration, ConcreteCheckpointDecodeError, MigrationOrigin,
    decode_concrete_runtime_checkpoint, decode_offline_ts_import_checkpoint,
};
pub use entity_consensus::{EntityConsensusRestoreError, hydrate_entity_consensus};
pub use entity_frame_head::{EntityFrameHeadRestoreError, decode_certified_entity_frame_head};
pub(crate) use entity_graph::entity_projection_metadata;
pub use entity_graph::{EntityGraphRestoreError, HydratedEntityGraph, hydrate_entity_graph};
pub use entity_snapshot::{EntitySnapshotRestoreError, entity_snapshot_from_graph};
pub use orderbook_accounts::{RestoredOrderbookAccounts, restore_orderbook_accounts};
pub use orderbook_graph::{HydratedOrderbook, OrderbookGraphRestoreError, hydrate_orderbook_graph};
pub(crate) use path_checkpoint::checkpoint_protocol_fingerprint;
pub use path_checkpoint::{
    PathCheckpointRestoreError, RestoredReplicaMetadata, restore_path_checkpoint,
};
pub use wal_input::{
    ConcreteWalDecodeError, decode_concrete_runtime_wal_frame,
    reconcile_runtime_input_with_resident_queue,
};
