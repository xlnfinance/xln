#![forbid(unsafe_code)]

//! Pure Entity orchestration over already-committed Account transitions.
//!
//! This workspace module is selected only by the explicit Rust Entity stack.
//! Its TypeScript-generated fixtures keep the payment/same-j slice exact while
//! the production coordinator boundary is integrated.

#[path = "support/board_handover.rs"]
mod board_handover;
#[path = "support/certified_board.rs"]
mod certified_board;
mod command;
#[path = "support/commitment.rs"]
mod commitment;
mod consensus;
mod cross_j;
#[path = "support/debt.rs"]
mod debt;
mod error;
#[path = "support/external_wallet.rs"]
mod external_wallet;
#[path = "support/frame_tx_effects.rs"]
mod frame_tx_effects;
mod hub_rebalance;
pub mod j_batch;
mod j_events;
mod kernel;
mod lending;
mod local_control;
mod local_financial;
mod local_tx;
mod orderbook;
mod paybook;
mod prepared_context;
#[path = "support/proposal.rs"]
mod proposal;
#[path = "support/provider_action.rs"]
mod provider_action;
mod resident;
mod scheduler;
mod scheduler_runtime;
mod snapshot;
#[path = "storage/projection.rs"]
mod storage_projection;
mod types;
mod unsafe_account_frame;

pub use board_handover::resolve_board_handover_authority;
pub use certified_board::{
    CertifiedBoardRecord, CertifiedBoardSource, CertifiedBoardState, CertifiedBoardStorageNode,
    CertifiedBoardStoragePath, canonical_certified_board_record, canonical_certified_board_state,
    certified_board_stack_key, decode_canonical_certified_board_state,
    project_certified_board_storage_nodes,
};
pub use command::{
    EntityCommandBoard, EntityCommandDisposition, EntityCommandError, EntityCommandNonceRecord,
    EntityCommandNonceState, SignedEntityCommandV1, UNREGISTERED_ENTITY_COMMAND_STACK_KEY,
    advance_entity_command_nonce, assert_signed_entity_command,
    build_locally_authored_entity_command, canonical_entity_command_nonces,
    current_entity_command_board_hash, decode_signed_entity_command,
    get_entity_command_disposition, is_individual_entity_command_tx_kind,
    normalize_entity_command_nonce_board,
};
pub use commitment::{
    canonical_swap_trading_pairs, collection_commitment, compute_entity_effects_parity_digest,
    compute_entity_owned_sections, decode_canonical_swap_trading_pairs,
};
pub use consensus::{
    CanonicalEntityTx, CertifiedEntityFrameLink, CertifiedEntityProposal,
    CertifiedEntityTransition, ConsensusMode, ENTITY_OWNED_CONSENSUS_FIELDS, ENTITY_TX_TYPES,
    EntityAuthorityError, EntityCertificationError, EntityConsensusConfig, EntityConsensusError,
    EntityConsensusSection, EntityConsensusState, EntityEncodingError, EntityFrame,
    EntityFrameAuthority, EntityFrameBody, EntityFrameDraft, EntityFrameError, EntityFrameEvent,
    EntityFrameLeader, EntityFrameWireMeasure, EntityFrameWireMeasureBody, EntityHankoWitness,
    EntityHankoWitnessMap, EntityLeaderState, EntityLineageError, EntityOutputError,
    EntitySingleSigner, EntityTransitionCertificationRequest, EntityTransitionError,
    EntityTxCatalogError, EntityTxKind, HashToSign, HashType, JPrefixRangeClaim, LocalEntityOutput,
    LocalEntityOutputTx, MAX_ENTITY_FRAME_BYTES, MAX_ENTITY_FRAME_TX_BYTES,
    MAX_ENTITY_PROPOSAL_WIRE_BYTES, PendingNonMutatingWake, PresignedManifest,
    PresignedManifestEntry, ResidentEntityConsensusReplica, build_certified_entity_frame_link,
    build_entity_hash_manifest, build_required_j_prefix_certificate, certify_entity_transition,
    certify_single_signer_entity_frame, compute_entity_consensus_root,
    compute_entity_events_parity_digest, compute_entity_frame_hash, compute_entity_section_digest,
    encode_entity_frame_context, is_entity_owned_consensus_field, measure_entity_frame_tx_bytes,
    measure_entity_frame_wire, project_entity_consensus_sections, sign_j_event_range,
};
pub use cross_j::{
    CrossJOpeningProposalSelection, CrossJOpeningSelectionError, CrossJOpeningSiblingAccountView,
    CrossJOpeningSiblingEntityView, CrossJurisdictionAccountViewRequest,
    CrossJurisdictionApplyResult, apply_cross_jurisdiction_entity_txs, authorize_runtime_output,
    build_proposer_materializations, cross_j_opening_account_ids,
    proposer_materialization_account_view_requests, proposer_materialization_key,
    select_cross_j_opening_proposal,
};
pub use debt::{
    DebtDirection, DebtEntry, DebtEventType, DebtLedger, canonical_debt_entry,
    canonical_debt_ledger, decode_canonical_debt_entry, decode_canonical_debt_ledger,
};
pub use error::EntityKernelError;
pub use external_wallet::{
    ExternalWalletAllowanceRecord, ExternalWalletBalanceRecord, ExternalWalletState,
    canonical_external_wallet, decode_canonical_external_wallet,
};
pub use j_batch::{
    JBatch, JBatchError, JBatchState, JBatchStatus, SealedJBatch, SentJBatch, canonical_j_batch,
    canonical_j_batch_state, decode_canonical_j_batch, decode_canonical_j_batch_state,
    decode_j_batch, encode_j_batch, encode_proof_body, proof_body_from_engine,
    proof_body_from_j_event, proof_body_hash,
};
pub use j_events::{
    CanonicalJEventBlock, EMPTY_J_HISTORY_ROOT, EntityJEventIngress, FinalizedJEventBatch,
    JClaimIngress, JEventClaimQueued, JReserveUpdate, apply_finalized_j_event_batches,
    canonical_j_event_blocks, canonical_j_event_range_hash, fold_j_history_root,
    j_event_range_digest, project_finalized_j_event_batch,
};
pub use kernel::apply_entity_kernel;
pub use lending::{
    LendingLoan, LendingLoanStatus, LendingPoolPosition, LendingPoolStatus, LendingState,
    canonical_lending_state, decode_canonical_lending_state,
};
pub use local_control::{
    EntityPropose, EntityVote, LocalEntityControlTx, ProfileUpdate, apply_local_entity_control_tx,
    decode_local_entity_control_tx,
};
pub use local_financial::{
    AccountEnvelopeMutation, DirectPaymentEntityTx, ExtendCreditEntityTx, HtlcPaymentEntityTx,
    LendingBorrowEntityTx, LendingClosePositionEntityTx, LendingOfferEntityTx,
    LendingRepayEntityTx, LocalAccountFinancialView, LocalEntityFinancialTx,
    PlaceSwapOfferEntityTx, ProposeCancelSwapEntityTx, RequestCollateralEntityTx,
    decode_local_entity_financial_tx,
};
pub use local_tx::{
    AdmittedLocalEntityTx, CrossJurisdictionRuntimeOutput, LocalEntityTx, decode_local_entity_tx,
    is_cross_jurisdiction_entity_tx_kind,
};
pub use orderbook::{
    BookOrder, BookPricePageEntrySnapshot, BookPricePageSnapshot, BookSideLevel, BookState,
    BookStateSnapshot, ORDERBOOK_PRICE_SCALE, OrderbookState, OrderbookStateSnapshot,
    PairDimensions, PairPolicy, SameJOffer, Side, canonical_pair_orientation,
    canonical_pair_policy, canonical_token_decimals, compute_book_commitment_hash,
    is_canonical_liquid_token,
};
#[cfg(feature = "bench")]
pub use orderbook::{OrderbookBenchmarkResult, run_orderbook_benchmark};
pub use prepared_context::{
    DecodedOnionLayer, DecryptedHtlcLayer, DecryptedHtlcMaterializeInput,
    HtlcMaterializeEnvironment, HtlcMaterializeInput, PreparedAccountView, PreparedContextError,
    compute_htlc_envelope_context_hash, decode_onion_layer, decrypt_htlc_materialize_inputs,
    decrypt_opaque_htlc_layer, materialize_decrypted_htlc_entries,
    materialize_htlc_prepared_entries, required_htlc_account_tokens,
};
pub use proposal::{
    EntityProposal, EntityProposalVote, EntityProposals, EntityVoteChoice,
    canonical_entity_proposals, decode_canonical_entity_proposals, generate_entity_proposal_id,
    hash_entity_proposal_action,
};
pub use provider_action::{
    EntityProviderActionIntent, EntityProviderActionPayload, EntityProviderActionState,
    canonical_entity_provider_action_intent, canonical_entity_provider_action_state,
    decode_canonical_entity_provider_action_intent, decode_canonical_entity_provider_action_state,
    hash_entity_provider_action,
};
pub use resident::{
    ResidentEntityCoreResult, ResidentEntityError, ResidentEntityOperation, ResidentEntityRequest,
    ResidentEntityResult, ResidentJEventProjection, apply_resident_entity_round,
    apply_resident_entity_round_core,
};
pub use scheduler::{
    CrontabState, CrontabTaskMethod, CrontabTaskParam, CrontabTaskState, ScheduledHook,
    ScheduledHookKind, ScheduledHookMap, cancel_hook, schedule_hook,
};
pub use scheduler_runtime::{
    CrontabExecutionContext, MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS, ScheduledWake, ScheduledWakeJob,
    ScheduledWakeJobKind, SchedulerCommand, SchedulerError, SchedulerExecution,
    collect_due_scheduled_wake_jobs, execute_crontab, scheduled_wake_entity_tx,
};
pub use snapshot::{EntityStateSnapshot, capture_entity_state, restore_entity_state};
pub use storage_projection::{
    EntityStorageProjection, EntityStorageProjectionError, project_entity_storage,
};
pub use types::{
    AccountProposalWork, CommittedAccountTransition, ControlBoardSupporterVote,
    DeterministicContext, EntityCanonicalCollection, EntityJOutput, EntityKernelCommitments,
    EntityKernelOutput, EntityKernelResult, EntityProfile, EntityProviderGovernanceIntent,
    EntityReferral, EntityStateSlice, EntitySwapPair, HtlcPreparedBinding, HtlcPreparedOutcome,
    HubProfile, JurisdictionScope, KnownAccounts, OrderbookConsensusMetadata, OrderedAccountCommit,
    OriginatedHtlcDeliveryMode, PaybookEntry, PaybookState, PreparedHtlcEntry,
    PreparedOriginatedHtlcPayment, SpreadDistribution,
};
