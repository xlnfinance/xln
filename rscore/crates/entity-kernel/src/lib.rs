#![forbid(unsafe_code)]

//! Pure Entity orchestration over already-committed Account transitions.
//!
//! This workspace module is selected only by the explicit Rust Entity stack.
//! Its TypeScript-generated fixtures keep the payment/same-j slice exact while
//! the production coordinator boundary is integrated.

mod command;
mod commitment;
mod consensus;
mod error;
mod frame_tx_effects;
mod j_events;
mod kernel;
mod local_financial;
mod orderbook;
mod paybook;
mod prepared_context;
mod resident;
mod scheduler;
mod scheduler_runtime;
mod snapshot;
#[path = "storage/projection.rs"]
mod storage_projection;
mod types;

pub use command::{
    EntityCommandBoard, EntityCommandDisposition, EntityCommandError, EntityCommandNonceRecord,
    EntityCommandNonceState, SignedEntityCommandV1, UNREGISTERED_ENTITY_COMMAND_STACK_KEY,
    advance_entity_command_nonce, assert_signed_entity_command, build_collective_entity_command,
    canonical_entity_command_nonces, current_entity_command_board_hash,
    decode_signed_entity_command, get_entity_command_disposition,
    normalize_entity_command_nonce_board,
};
pub use commitment::{compute_entity_effects_parity_digest, compute_entity_owned_sections};
pub use consensus::{
    CanonicalEntityTx, CertifiedEntityFrameLink, CertifiedEntityProposal,
    CertifiedEntityTransition, ConsensusMode, ENTITY_OWNED_CONSENSUS_FIELDS, EntityAuthorityError,
    EntityCertificationError, EntityConsensusConfig, EntityConsensusError, EntityConsensusSection,
    EntityConsensusState, EntityEncodingError, EntityFrame, EntityFrameAuthority, EntityFrameBody,
    EntityFrameError, EntityFrameEvent, EntityFrameLeader, EntityHankoWitness,
    EntityHankoWitnessMap, EntityHtlcNoteIndex, EntityLeaderState, EntityLineageError,
    EntityOutputError, EntitySingleSigner, EntityTransitionCertificationRequest,
    EntityTransitionError, EntityTxCatalogError, EntityTxKind, EntityTxSupport, HashToSign,
    HashType, LocalEntityOutput, LocalEntityOutputTx, PendingNonMutatingWake, PresignedManifest,
    PresignedManifestEntry, ResidentEntityConsensusReplica, build_certified_entity_frame_link,
    build_entity_hash_manifest, certify_entity_transition, certify_single_signer_entity_frame,
    compute_entity_consensus_root, compute_entity_events_parity_digest, compute_entity_frame_hash,
    compute_entity_section_digest, is_entity_owned_consensus_field,
    project_entity_consensus_sections,
};
pub use error::EntityKernelError;
pub use j_events::{
    CanonicalJEventBlock, EMPTY_J_HISTORY_ROOT, EntityJEventIngress, FinalizedJEventBatch,
    JClaimIngress, JEventClaimQueued, JReserveUpdate, apply_finalized_j_event_batches,
    canonical_j_event_blocks, canonical_j_event_range_hash, fold_j_history_root,
    j_event_range_digest,
};
pub use kernel::apply_entity_kernel;
pub use local_financial::{
    DirectPaymentEntityTx, HtlcPaymentEntityTx, LocalEntityFinancialTx, PlaceSwapOfferEntityTx,
    ProposeCancelSwapEntityTx, decode_local_entity_financial_tx,
};
pub use orderbook::{
    BookOrder, BookPricePageEntrySnapshot, BookPricePageSnapshot, BookState, BookStateSnapshot,
    OrderbookState, OrderbookStateSnapshot, PairDimensions, PairPolicy, SameJOffer, Side,
    canonical_pair_orientation, canonical_pair_policy, canonical_token_decimals,
    compute_book_commitment_hash, is_canonical_liquid_token,
};
#[cfg(feature = "bench")]
pub use orderbook::{OrderbookBenchmarkResult, run_orderbook_benchmark};
pub use prepared_context::{
    DecryptedHtlcLayer, DecryptedHtlcMaterializeInput, HtlcMaterializeEnvironment,
    HtlcMaterializeInput, PreparedAccountView, PreparedContextError,
    compute_htlc_envelope_context_hash, decode_onion_layer, decrypt_htlc_materialize_inputs,
    decrypt_opaque_htlc_layer, materialize_decrypted_htlc_entries,
    materialize_htlc_prepared_entries, required_htlc_account_tokens,
};
pub use resident::{
    ResidentEntityCoreResult, ResidentEntityError, ResidentEntityRequest, ResidentEntityResult,
    ResidentJEventProjection, apply_resident_entity_round, apply_resident_entity_round_core,
};
pub use scheduler::{
    CrontabState, CrontabTaskMethod, CrontabTaskParam, CrontabTaskState, ScheduledHook,
    ScheduledHookKind, cancel_hook, schedule_hook,
};
pub use scheduler_runtime::{
    MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, ScheduledWake, ScheduledWakeJob, ScheduledWakeJobKind,
    SchedulerCommand, SchedulerError, SchedulerExecution, collect_due_scheduled_wake_jobs,
    execute_crontab, scheduled_wake_entity_tx,
};
pub use snapshot::{EntityStateSnapshot, capture_entity_state, restore_entity_state};
pub use storage_projection::{
    EntityStorageProjection, EntityStorageProjectionError, project_entity_storage,
};
pub use types::{
    AccountProposalWork, CommittedAccountTransition, DeterministicContext, EntityKernelCommitments,
    EntityKernelOutput, EntityKernelResult, EntityReferral, EntityStateSlice, HtlcPreparedBinding,
    HtlcPreparedOutcome, HtlcRoute, HubProfile, JurisdictionScope, LockBookEntry,
    OrderbookConsensusMetadata, OrderedAccountCommit, OriginatedHtlcDeliveryMode,
    PreparedHtlcEntry, PreparedOriginatedHtlcPayment, SpreadDistribution,
};
