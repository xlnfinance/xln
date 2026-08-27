//! Canonical single-Entity Runtime machine.
//!
//! The Runtime owns one resident Entity+Account stack. Ingress is queued in
//! deterministic FIFO order, one bounded prefix is applied, and the returned
//! replica is the only state that may be handed to durable storage. External
//! publication is deliberately outside this pure transition.

mod apply;
mod mempool;
mod scheduled_input;
mod scheduled_wake;
mod types;

#[cfg(test)]
pub(crate) mod tests;

pub use apply::apply_runtime;
pub use mempool::{SelectedRuntimeFrame, enqueue_runtime_input, select_runtime_frame};
pub use scheduled_wake::ScheduledWakeIndex;
pub(crate) use types::materialization_due;
pub use types::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RuntimeApplyResult, RuntimeEntityInput, RuntimeFrameContext, RuntimeFrameTouches, RuntimeInput,
    RuntimeLimits, RuntimeMachineError, RuntimeMempool, RuntimeOutputs, RuntimeReplica,
    RuntimeState, RuntimeTx, RuntimeWake,
};
