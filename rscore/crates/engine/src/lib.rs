//! Deterministic, path-copy Account execution.
//!
//! This crate is deliberately not wired into production yet. Its public API is
//! a closed Rust model whose candidate result can be compared with the
//! canonical TypeScript engine before native execution is enabled.

// The module tree is a calque of `core/account` in TypeScript: same directory
// names, same file names, so the two implementations can be audited side by
// side. Anything without a TypeScript twin says so in its own header.
mod commitment;
mod consensus;
mod crypto;
mod error;
mod state;
mod swap;
mod tx;

pub use commitment::{CarriedSections, JClaimAccumulator};
pub use consensus::context::AccountExecutionContext;
pub use consensus::frame::hash::{
    AccountFrame, GENESIS_PREV_FRAME_HASH, canonical_tx_value, parse_root_hex,
};
pub use crypto::{
    address_of_private_key, derive_signer_address, derive_signer_key, normalize_recovery_byte,
    recover_signer_address, sign_digest,
};
pub use state::account_replica_shell::{AccountEnvelope, EnvelopeError};
pub use state::delta::{Delta, DeltaPerspective, TokenId};
pub use tx::apply::{AccountTransition, AccountVerdict, SequentialAccountEngine};
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
pub use xln_rscore_protocol::CanonicalValue;
