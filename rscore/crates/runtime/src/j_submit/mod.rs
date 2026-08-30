//! Native post-WAL Jurisdiction submission.
//!
//! The deterministic Runtime seals ordered J work in its ordinary outbox.
//! This module performs only external I/O after that frame is durable: exact
//! Batch ABI, Hanko verification, EIP-1559 signing and JSON-RPC publication.
//! A mined RPC receipt never mutates Runtime state; only receipt-trie-authenticated
//! watcher ingress may retire a sealed batch.

mod calldata;
mod governance_lifecycle;
mod intent;
pub(crate) mod lifecycle;
pub(crate) mod provider_lifecycle;
mod submission;
mod transaction;

#[cfg(test)]
mod tests;

use thiserror::Error;

pub use calldata::{
    WatchtowerCounterDisputeCall, decode_process_batch_calldata,
    decode_watchtower_counter_dispute_calldata,
};
pub(crate) use governance_lifecycle::decode_governance_result;
pub use governance_lifecycle::{
    DurableGovernanceAttempt, GovernanceResultData, GovernanceResultOutcome,
    apply_governance_result, decode_pending_governance_attempts, encode_governance_result,
    prepare_governance_attempt, register_governance_attempt,
};
pub use intent::{
    JIntentError, JMaintenanceIntent, PreparedEntityJIntents, PreparedEntityProviderActionIntent,
    prepare_certified_entity_j_intents,
};
pub use lifecycle::{
    DurableJSubmitAttempt, JAdapterFailure, JSubmitResultData, JSubmitResultOutcome,
    RetryJSubmitData, apply_j_submit_result, apply_j_submit_retry, build_j_submit_attempt_id,
    decode_pending_j_submit_attempts, encode_j_submit_result, encode_retry_j_submit,
};
pub use provider_lifecycle::{
    DurableEntityProviderActionAttempt, EntityProviderActionResultData,
    EntityProviderActionResultOutcome, RetryEntityProviderActionData,
    apply_entity_provider_action_result, apply_entity_provider_action_retry,
    build_entity_provider_action_attempt_id, decode_pending_entity_provider_attempts,
    encode_entity_provider_action_result, encode_retry_entity_provider_action,
};
pub(crate) use submission::ControlBoardProposal;
pub use submission::{JSubmitConfig, JSubmitOutcome, JSubmitter, ProcessedBatchEvidence};
pub use transaction::{Eip1559Transaction, SignedEip1559Transaction};
pub use xln_rscore_entity_kernel::j_batch::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DurableJAttempt {
    Batch(DurableJSubmitAttempt),
    EntityProvider(DurableEntityProviderActionAttempt),
    /// Exact TS maintenance lane: `mint` is a dev-chain administrative call,
    /// not a financial submit attempt and therefore has no retry FSM row.
    Governance(DurableGovernanceAttempt),
    Maintenance(JMaintenanceIntent),
    ScheduleRuntimeTx(crate::RuntimeTx),
}

impl From<DurableJSubmitAttempt> for DurableJAttempt {
    fn from(value: DurableJSubmitAttempt) -> Self {
        Self::Batch(value)
    }
}

impl From<DurableEntityProviderActionAttempt> for DurableJAttempt {
    fn from(value: DurableEntityProviderActionAttempt) -> Self {
        Self::EntityProvider(value)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JSubmitError {
    #[error(transparent)]
    Batch(#[from] xln_rscore_entity_kernel::JBatchError),
    #[error("RSCORE_J_HANKO:{0}")]
    Hanko(String),
    #[error("RSCORE_J_RPC:{0}")]
    Rpc(String),
    #[error("RSCORE_J_TRANSACTION:{0}")]
    Transaction(&'static str),
}
