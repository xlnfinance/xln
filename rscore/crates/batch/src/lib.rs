//! Deterministic parallel batching over independently owned Account replicas.
//!
//! Account-local order and collected bytes are stable across worker counts.
//! This layer deliberately does not promise persistent account-to-worker shard
//! affinity across batches.

mod checkpoint;
mod consensus;
mod error;
mod execution;
mod query;
mod stateful;
mod types;

pub use checkpoint::{
    AccountCheckpointHeader, AccountCheckpointRows, AccountCheckpointSections, AccountRestore,
    AccountsCheckpoint, CheckpointExpectation, CheckpointToken, CheckpointTreeDescriptor,
};
pub use consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInputKind, AccountInputResult,
    AccountInputRow, AccountInputVerdict, DroppedRow, EntityProposalSelection, EntityWave,
    EntityWaveOps, ProposalRow, ProposedRow, StatefulConsensusEngine, WaveOp, WaveOpsRequest,
    WaveProposalRequest, WaveRequest, WaveResult,
};
pub use error::BatchError;
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
