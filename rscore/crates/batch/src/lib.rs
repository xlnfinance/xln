//! Deterministic parallel batching over independently owned Account replicas.
//!
//! Account-local order and collected bytes are stable across worker counts.
//! This layer deliberately does not promise persistent account-to-worker shard
//! affinity across batches.

mod error;
mod execution;
mod stateful;
mod types;

pub use error::BatchError;
pub use stateful::StatefulBatchEngine;
pub use types::{
    AccountId, AccountSeed, BatchJob, BatchResponse, BatchVerdict, EngineGeneration, IndexedOutput,
    IndexedResult, PreparedBatch,
};
