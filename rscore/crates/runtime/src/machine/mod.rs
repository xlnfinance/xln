//! Canonical path-keyed multi-Entity Runtime machine.
//!
//! The Runtime owns one resident Entity+Account stack. Ingress is queued in
//! deterministic FIFO order, one bounded prefix is applied, and the returned
//! replica is the only state that may be handed to durable storage. External
//! publication is deliberately outside this pure transition.

mod apply;
mod inbound_genesis;
mod mempool;
mod scheduled_input;
mod types;

#[cfg(test)]
pub(crate) mod tests;

pub use apply::{apply_runtime, apply_runtime_live};
pub use mempool::{SelectedRuntimeFrame, enqueue_runtime_input, select_runtime_frame};
pub(crate) use types::materialization_due;
pub use types::{
    AccountCommitEvidence, AccountCommitSource, AppliedRuntimeFrame, AppliedRuntimeInput,
    RewindJHistory, RuntimeAdapterCommandMarker, RuntimeApplyResult, RuntimeEntityFrameContext,
    RuntimeEntityInit, RuntimeEntityInput, RuntimeEntityKey, RuntimeEntityOutputs,
    RuntimeEntityReplica, RuntimeEntityState, RuntimeEntityWake, RuntimeFrameContext,
    RuntimeFrameTouches, RuntimeInput, RuntimeLimits, RuntimeLiveInput, RuntimeMachineError,
    RuntimeMempool, RuntimeOutputs, RuntimeReplica, RuntimeState, RuntimeTouchedAccount, RuntimeTx,
    RuntimeWake,
};
