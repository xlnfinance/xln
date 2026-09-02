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
mod parallel;
mod resident_consensus;
mod round;
mod types;

pub const MAX_BATCH_WORKERS: usize = 256;

pub use checkpoint::{
    AccountCheckpointHeader, AccountCheckpointRows, AccountCheckpointSections, AccountRestore,
    AccountsCheckpoint, CheckpointExpectation, CheckpointToken, CheckpointTreeDescriptor,
};
pub use checkpoint_wire::{
    AccountCheckpointNamespace, AccountWireEncodeError, EncodedAccountCheckpointNodeAddress,
    EncodedAccountCheckpointNodeMutation, EncodedAccountCheckpointNodes,
    EncodedAccountCheckpointTreeChanges, EncodedAccountJClaimChanges, EncodedAccountJClaimNodePut,
    JEventWireError, decode_jurisdiction_event, encode_account_checkpoint_nodes,
    encode_account_checkpoint_rows, encode_account_envelope, encode_account_tx, encode_bigint,
    encode_canonical_value, encode_delta, encode_j_claim_node, encode_jurisdiction_event,
};
pub use consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInput, AccountInputBoardAuthority,
    AccountInputKind, AccountInputResult, AccountInputRow, AccountInputVerdict,
    CertifiedBoardAuthorityResolver, DroppedRow, FailedHtlcLockRow, LocalGenesisSeedParams,
    ProposalRow, ProposedRow, UpstreamHtlcResolutionRow, build_local_genesis_seed,
};
pub use error::BatchError;
pub use parallel::{AccountPhaseKind, AccountPhaseMetric, AccountShardMetric};
pub use resident_consensus::{
    CertifiedSettlementHankoDraft, DeferredSettlementApproval, PendingSettlementHankoDraft,
    PreparedEntityOutbound, ResidentAccountDisputeView, ResidentAccountFinancialView,
    ResidentAccountFinancialViewRequest, ResidentAccountStatusView, ResidentConsensusEngine,
    ResidentCrossJMaterializationView, ResidentCrossJOpeningAccountView,
    ResidentHubRebalanceAccountView, ResidentHubRebalanceFeeState,
    ResidentOrderbookAccountSnapshot,
};
pub use round::{
    AccountEnvelopeUpdate, BatchAccountSelection, EntityAccountGenesisPolicy, EntityInboundRequest,
    EntityOutboundRequest, EntityRoundResult, FailedHtlcFollowup,
};
pub use types::{AccountId, AccountSeed, EngineGeneration};
pub use xln_rscore_engine::CommittedFrameEvidence;
pub use xln_rscore_engine::ReceiverClock;
