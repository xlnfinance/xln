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
pub use consensus::context::AccountExecutionContext;
pub use consensus::frame::hash::{
    AccountFrame, GENESIS_PREV_FRAME_HASH, MAX_POLICY_VERSION, canonical_tx_digest,
    canonical_tx_value, is_frame_hashable, parse_root_hex,
    unsupported_kind as unsupported_frame_tx_kind,
};
pub use consensus::incoming::apply::{
    AckOutcome, CommittedFrameEvidence, HtlcEvidenceSecret, IncomingDeadlineViolation,
    IncomingFrameSecurityContext, IncomingOutcome, ReceiverClock, SignedIncomingFrame,
    apply_board_hanko_refresh, apply_incoming_ack, apply_incoming_ack_with_authority,
    apply_incoming_frame, apply_incoming_frame_ack, apply_incoming_frame_ack_with_authority,
    apply_incoming_frame_with_authority, apply_standalone_dispute,
};
pub use consensus::incoming::types::{
    AccountPeerEnvelope, BoardHankoRefreshInput, FrameAckOutcome, FrameAckPhase, IncomingAck,
    IncomingFrame, PeerEnvelopeRejection, StandaloneInputOutcome, validate_peer_envelope,
};
pub use consensus::proposal::propose::{
    Disposition, DroppedTx, ProposalOutcome, ProposedFrame, propose_account_frame,
};
pub use consensus::replica::{
    AccountAdmission, AccountConsensus, AdmissionRejection, CommittedFrame, ConsensusSnapshot,
    CounterpartyDispute, DisputeDraft, OutboundAck, PendingFrame, PendingFrameSnapshot,
    RolledBackProposal,
};
pub use consensus::signing::{
    CertifiedBoardAuthority, SigningIdentity, verify_ack_hanko_with_authority,
    verify_dispute_hanko_with_authority, verify_frame_hanko, verify_frame_hanko_with_authority,
};
pub use crypto::{
    address_of_private_key, derive_signer_address, derive_signer_key, normalize_recovery_byte,
    recover_signer_address, sign_digest,
};
pub use dispute::{DisputeProof, build_dispute_proof, dispute_proof_hash, proof_body_hash};
pub use input::mempool::ACCOUNT_MEMPOOL_SIZE;
pub use j_claims::{
    AccountSettledEvent, EMPTY_J_CLAIM_ROOT, JClaimMutation, JClaimNode, JClaimNodeChanges,
    JClaimProof, JClaimRecord, JClaimSide, JClaimStatus, JClaimStore, JClaimTransition,
    JEventClaimTx, JEventMetadata, JurisdictionEvent, account_key as j_claim_account_key,
    apply_claim_transition, canonical_events, canonical_events_hash, claim_key as j_claim_key,
    hash_node as hash_j_claim_node, prepare_claim_tx,
};
pub use state::account_replica_shell::{AccountEnvelope, EnvelopeError};
pub use state::delta::{Delta, DeltaPerspective, TokenId};
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
pub use swap::{SwapMarketPolicy, SwapOffer, SwapToken};
pub use tx::apply_result::AccountOutput;
pub use tx::handlers::htlc::{
    HTLC_OPAQUE_CIPHERTEXT_VERSION, HtlcBoundaryError, HtlcDeliveryMode, HtlcHashlock, HtlcLock,
    HtlcLockTx, HtlcRejection, HtlcResolveOutcome, HtlcResolveTx, OpaqueHtlcCiphertext,
    encode_htlc_lock_value, htlc_lock_radix_key, htlc_lock_value_digest,
};
pub use tx::handlers::rebalance::{BilateralRebalanceFeePolicy, RebalanceFeePolicySnapshot};
pub use tx::{AccountTx, DeliveryMode, LendingAction, LendingTermId, ReserveSide};
pub use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};
