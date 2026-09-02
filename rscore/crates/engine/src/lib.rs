#![forbid(unsafe_code)]

//! Deterministic, path-copy Account execution.
//!
//! This is the canonical Account transition kernel used by resident Rust
//! authority and native replay. Production activation remains gate-controlled
//! until exact TS parity, checkpoint and crash-recovery evidence are green;
//! callers must not add a second transition implementation or a TS fallback.

// The module tree is a calque of `core/account` in TypeScript: same directory
// names, same file names, so the two implementations can be audited side by
// side. Anything without a TypeScript twin says so in its own header.
mod commitment;
mod consensus;
mod crypto;
mod dispute;
mod error;
mod input;
mod j_claims;
mod state;
mod swap;
mod tx;

pub use commitment::{CarriedSections, JClaimAccumulator};
pub use consensus::context::{AccountExecutionContext, SettlementExecutionContext};
pub use consensus::frame::hash::{
    AccountFrame, GENESIS_PREV_FRAME_HASH, MAX_POLICY_VERSION, canonical_tx_digest,
    canonical_tx_value, is_frame_hashable, parse_root_hex,
    unsupported_kind as unsupported_frame_tx_kind, wire_tx_value,
};
pub use consensus::incoming::apply::{
    AckOutcome, CommittedFrameEvidence, HtlcEvidenceSecret, IncomingDeadlineViolation,
    IncomingFrameSecurityContext, IncomingOutcome, ReceiverClock, SignedIncomingFrame,
    apply_board_hanko_refresh, apply_incoming_ack, apply_incoming_ack_frame,
    apply_incoming_ack_frame_with_authority, apply_incoming_ack_with_authority,
    apply_incoming_frame, apply_incoming_frame_with_authority, apply_standalone_dispute,
    classify_incoming_frame_without_mutation,
};
pub use consensus::incoming::types::{
    AccountInputEnvelope, AccountInputEnvelopeRejection, AckFrameOutcome, AckFramePhase,
    BoardHankoRefreshInput, IncomingAck, IncomingFrame, StandaloneInputOutcome,
    validate_account_input_envelope,
};
pub use consensus::proposal::propose::{
    AccountProposalSelection, Disposition, DroppedTx, ProposalOutcome, ProposedFrame,
    propose_account_frame, propose_account_frame_with_selection,
};
pub use consensus::replica::{
    AccountAdmission, AccountConsensus, AccountDisputeFinality, AccountDisputeFinalityResult,
    AccountDisputeStartedFinality, AdmissionRejection, CommittedFrame, ConsensusSnapshot,
    CounterpartyDispute, DisputeDraft, OutboundAck, PendingFrame, PendingFrameSnapshot,
    RolledBackProposal,
};
pub use consensus::signing::{
    CertifiedBoardAuthority, SigningIdentity, verify_ack_hanko_with_authority,
    verify_dispute_hanko_with_authority, verify_frame_hanko, verify_frame_hanko_with_authority,
};
pub use crypto::{
    EcdsaRecoveryProfileSnapshot, address_of_private_key, derive_signer_address, derive_signer_key,
    ecdsa_recovery_profile_snapshot, normalize_recovery_byte, recover_signer_address, sign_digest,
};
pub use dispute::{
    DisputeAllowance, DisputeProof, DisputeProofBody, DisputeTransformerClause,
    build_dispute_proof, build_dispute_proof_body, dispute_proof_hash, proof_body_hash,
};
pub use input::mempool::ACCOUNT_MEMPOOL_SIZE;
pub use j_claims::{
    AccountSettledEvent, BoardActivatedEvent, CounterDisputeRegisteredEvent, DebtCreatedEvent,
    DebtEnforcedEvent, DebtForgivenEvent, DisputeFinalizationEvidence, DisputeFinalizedEvent,
    DisputeStartedEvent, EMPTY_J_CLAIM_ROOT, EntityProviderActionCancelledEvent,
    EntityProviderActionExecutedEvent, EntityRegisteredEvent, ExternalAllowance,
    ExternalTokenBalance, ExternalWalletDeltaEvent, ExternalWalletSnapshotEvent,
    FoundationBootstrappedEvent, HankoBatchProcessedEvent, HashLadderRevealRegisteredEvent,
    JClaimMutation, JClaimNode, JClaimNodeChanges, JClaimProof, JClaimRecord, JClaimSide,
    JClaimStatus, JClaimStore, JClaimTransition, JEventClaimTx, JEventMetadata, JurisdictionEvent,
    ProofAllowance, ProofBody, ProofTransformerClause, ReserveUpdatedEvent, SecretRevealedEvent,
    account_key as j_claim_account_key, apply_claim_transition,
    canonical_dispute_finalization_evidence_hash, canonical_dispute_finalization_evidence_key,
    canonical_event_key, canonical_event_value, canonical_events, canonical_events_hash,
    claim_key as j_claim_key, hash_node as hash_j_claim_node,
    normalize_dispute_finalization_evidence, prepare_claim_tx,
};
pub use state::account_replica_shell::{AccountEnvelope, EnvelopeError};
pub use state::delta::{Delta, DeltaPerspective, TokenId};
pub use state::{RebalanceRefundState, RebalanceRequestFeeState};
pub use tx::apply::{AccountTransition, AccountVerdict, SequentialAccountEngine};
pub use xln_rscore_hanko::BoardDelays;
// The canonical value model is part of the engine's public boundary: the
// process layer decodes carried replica sections straight into it.
pub use error::{AccountRejection, StateError, TransitionError, ValidationRejection};
pub use state::identity::{
    AccountDomain, AccountIdentity, DepositoryAddress, EntityId, Side, WatchSeed,
};
pub use state::{
    AccountDisputeConfig, AccountReplica, AccountState, AccountStateSeed, LendingIntentKind,
};
pub use swap::{SwapMarketPolicy, SwapOffer, SwapOfferSnapshot, SwapToken};
pub use tx::apply_result::AccountOutput;
pub use tx::handlers::htlc::{
    HTLC_OPAQUE_CIPHERTEXT_VERSION, HtlcBoundaryError, HtlcDeliveryMode, HtlcHashlock, HtlcLock,
    HtlcLockTx, HtlcRejection, HtlcResolveOutcome, HtlcResolveTx, OpaqueHtlcCiphertext,
    encode_htlc_lock_value, htlc_lock_radix_key, htlc_lock_value_digest,
};
/// Verify the one canonical hash-ladder wire used by Account close and
/// cross-j registry forwarding. Entity must call this instead of growing a
/// second Keccak implementation at the parent layer.
pub fn verify_hash_ladder_binary(
    full_hash: &str,
    partial_root: &str,
    binary: &str,
) -> Result<u64, String> {
    tx::handlers::cross_j::verify_ladder(full_hash, partial_root, binary)
}
pub use tx::handlers::rebalance::{BilateralRebalanceFeePolicy, RebalanceFeePolicySnapshot};
pub use tx::handlers::settlement::{
    PreparedSettlementDiff, PreparedSettlementExecution, SettlementHankoDraft,
    attach_settlement_hanko_witnesses, build_settlement_hanko_draft,
    can_auto_approve_settlement_ops, prepare_settlement_execution, settlement_workspace_body_hash,
    validate_settlement_ops,
};
pub use tx::{
    ACCOUNT_TX_TYPES, AccountTx, DeliveryMode, LendingAction, LendingTermId, RebalanceRefundReason,
};
pub use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};
