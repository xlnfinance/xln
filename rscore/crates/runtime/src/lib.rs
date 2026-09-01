#![forbid(unsafe_code)]

//! Canonical sovereign Runtime state and WAL commitments.
//!
//! This crate deliberately starts at the durable consensus boundary. A Rust
//! Runtime frame is valid only when its storage commitments reproduce the
//! canonical TypeScript bytes; fixture-specific root hooks are not accepted.

#[path = "codec/account_input_json.rs"]
mod account_input_json;
mod certified_board_registry;
#[path = "checkpoint/checkpoint_node_key.rs"]
mod checkpoint_node_key;
#[path = "checkpoint/checkpoint_projection_metadata.rs"]
mod checkpoint_projection_metadata;
mod commitment;
#[path = "checkpoint/entity_checkpoint.rs"]
mod entity_checkpoint;
mod entity_context_json;
mod entity_frame;
mod j_import;
pub mod j_submit;
mod j_watcher;
mod leveldb;
mod machine;
mod machine_graph;
mod mesh_seed;
pub mod processor;
mod recording;
pub mod restore;
pub mod rheader;
pub mod storage;
#[path = "codec/storage_msgpack.rs"]
mod storage_msgpack;
#[path = "codec/tagged_json.rs"]
mod tagged_json;
pub mod transport;

pub use account_input_json::{
    AccountInputJsonError, decode_account_input_row, decode_account_tx_json,
    decode_entity_account_input_row, decode_entity_account_input_rows,
};
pub use certified_board_registry::CertifiedBoardRegistry;
pub(crate) use checkpoint_projection_metadata::{
    EntityCheckpointProjectionMetadata, EntityFieldProjectionDescriptor,
    EntityTreeProjectionDescriptor,
};
pub use commitment::{
    CanonicalRuntimeEntityHash, RuntimeCommitmentError, RuntimeComponentDigest,
    RuntimePostStateCommitment, StorageReplicaMetaEntry, compute_canonical_runtime_state_hash,
    compute_runtime_component_digest, compute_storage_post_state_hash,
    compute_storage_replica_meta_digest, encode_storage_payload,
};
pub use entity_checkpoint::{
    EntityCheckpointError, carried_entity_checkpoint_sections, entity_checkpoint_crontab,
};
pub use entity_context_json::{
    CanonicalEntityInfraMaterializer, EntityContextJsonError, EntityInfraMaterializeRequest,
    EntityInfraMaterializer, FreshEntityContextError, InboundHtlcInfrastructure,
    MaterializedEntityInfraContext, canonical_swap_market_policy,
    decode_entity_deterministic_context,
};
pub use entity_frame::{EntityFrameError, fit_entity_account_input_prefix};
pub use j_import::{
    JurisdictionContracts, JurisdictionImportRequest, JurisdictionImportResult,
    JurisdictionTokenInfo,
};
pub use j_watcher::{
    FinalizedJEventBatch, FinalizedJHeader, FinalizedWatcherCursor, HttpJsonRpc, JClaimIngress,
    JReserveUpdate, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc, ObserveJRange,
    WatchedExternalWallet, WatchedHashLadder, decode_observe_j_range, encode_observe_j_range,
    observation_from_poll, poll_finalized_j_events,
};
pub use leveldb::{
    RawConcreteWalRows, RuntimeLevelDbError, RuntimeWalReader, StoredRscoreCheckpoint,
    concrete_wal_source_from_raw,
};
pub use machine::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RewindJHistory, RuntimeAdapterCommandMarker, RuntimeApplyPhaseProfile, RuntimeApplyResult,
    RuntimeEntityFrameContext, RuntimeEntityInput, RuntimeEntityKey, RuntimeEntityOutputs,
    RuntimeEntityReplica, RuntimeEntityState, RuntimeEntityWake, RuntimeFrameContext,
    RuntimeFrameTouches, RuntimeInput, RuntimeLimits, RuntimeLiveInput, RuntimeMachineError,
    RuntimeMempool, RuntimeOutputs, RuntimeReplica, RuntimeState, RuntimeTouchedAccount, RuntimeTx,
    RuntimeWake, SelectedRuntimeFrame, apply_runtime, apply_runtime_live, enqueue_runtime_input,
    select_runtime_frame,
};
pub use machine_graph::{RuntimeMachineGraphError, rebuild_runtime_machine_graph};
pub use mesh_seed::{MeshSeedError, derive_mesh_child_seed};
pub use processor::{
    DurableRuntimeProcessor, DurableRuntimeProcessorError, ResidentRuntimeService,
    ResidentRuntimeServiceError, RuntimeDurableCommitments, RuntimeDurableEntityCommitment,
    RuntimeDurableEnvelope, RuntimeDurableEnvelopeError, RuntimeOperatorConfig,
    RuntimeProcessReport, RuntimeSignerLabel,
};
pub use recording::{
    RecordingPostStateCheck, RuntimeRecordingError, verify_recording_post_state_hashes,
    verify_wal_post_state_hash,
};
pub use storage_msgpack::{StorageMessagePackError, decode_storage_payload};
pub use tagged_json::{
    TaggedJsonError, canonical_value_from_tagged_json, tagged_json_from_canonical_value,
};
