//! Deterministic parallel batching over independently owned Account replicas.
//!
//! Account-local order and collected bytes are stable across worker counts.
//! This layer deliberately does not promise persistent account-to-worker shard
//! affinity across batches.

mod consensus;
mod error;
mod execution;
mod query;
mod stateful;
mod types;

pub use consensus::{
    AccountInputKind, AccountInputResult, AccountInputRow, AccountInputVerdict, ProposalRow,
    StatefulConsensusEngine,
};
pub use error::BatchError;
pub use query::{AccountSummaryRow, CapacityRequest, EngineTotals, TokenTotals};
pub use stateful::{MAX_BATCH_WORKERS, StatefulBatchEngine};
pub use types::{
    AccountId, AccountInputAuthority, AccountSeed, BatchJob, BatchResponse, BatchVerdict,
    EngineGeneration, IndexedOutput, IndexedResult, PreparedBatch, PreparedPaymentProfileRoot,
};
