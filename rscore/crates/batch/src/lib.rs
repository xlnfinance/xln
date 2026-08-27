#![forbid(unsafe_code)]

//! Deterministic parallel batching over independently owned Account replicas.
//!
//! Account-local order and collected bytes are stable across worker counts.
//! The first three key nibbles select one of 4096 logical shards; a persistent
//! startup plan assigns each shard to one physical worker for every batch.

mod checkpoint;
mod checkpoint_wire;
mod consensus;
mod error;
mod execution;
mod parallel;
mod query;
mod resident_consensus;
mod round;
mod stateful;
mod types;

pub use checkpoint::{
    AccountCheckpointHeader, AccountCheckpointRows, AccountCheckpointSections, AccountRestore,
    AccountsCheckpoint, CheckpointExpectation, CheckpointToken, CheckpointTreeDescriptor,
};
pub use checkpoint_wire::{
    AccountCheckpointNamespace, AccountWireEncodeError, EncodedAccountCheckpointNodeAddress,
    EncodedAccountCheckpointNodeMutation, EncodedAccountCheckpointNodes,
    EncodedAccountCheckpointTreeChanges, EncodedAccountJClaimChanges, EncodedAccountJClaimNodePut,
    encode_account_checkpoint_nodes, encode_account_checkpoint_rows, encode_account_envelope,
    encode_account_tx, encode_bigint, encode_delta, encode_j_claim_node,
};
pub use consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInputKind, AccountInputResult,
    AccountInputRow, AccountInputVerdict, AccountPeerInput, CertifiedBoardAuthorityResolver,
    DroppedRow, EntityProposalSelection, EntityStageContext, EntityStageReceipt, EntityStageStatus,
    EntityWave, EntityWaveOps, FailedHtlcLockRow, PeerBoardAuthority, ProposalRow, ProposedRow,
    StageKey, StatefulConsensusEngine, UpstreamHtlcResolutionRow, WaveOp, WaveOpsRequest,
    WaveProposalRequest, WaveRequest, WaveResult,
};
pub use error::BatchError;
pub use parallel::{AccountShardMetric, LOGICAL_ACCOUNT_SHARDS};
pub use resident_consensus::{ResidentAccountFinancialView, ResidentConsensusEngine};
pub use round::{
    EntityAccountGenesisPolicy, EntityInboundRequest, EntityOutboundRequest, EntityRoundResult,
    FailedHtlcRoute,
};
// The receiver clock is part of this layer's boundary: a caller cannot apply
// an input without saying what time it is on its own machine.
pub use query::{AccountSummaryRow, CapacityRequest, EngineTotals, TokenTotals};
pub use stateful::{MAX_BATCH_WORKERS, StatefulBatchEngine};
pub use types::{
    AccountId, AccountInputAuthority, AccountSeed, BatchJob, BatchResponse, BatchVerdict,
    CandidateId, EngineGeneration, IndexedOutput, IndexedResult, PreparedBatch,
    PreparedPaymentProfileRoot,
};
pub use xln_rscore_engine::CommittedFrameEvidence;
pub use xln_rscore_engine::ReceiverClock;
