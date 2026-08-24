//! Deterministic, path-copy Account execution.
//!
//! This crate is deliberately not wired into production yet. Its public API is
//! a closed Rust model whose candidate result can be compared with the
//! canonical TypeScript engine before native execution is enabled.

mod balance;
mod commitment;
mod context;
mod delta;
mod engine;
mod envelope;
mod error;
mod htlc;
mod identity;
mod lending;
mod mutation;
mod output;
mod rebalance;
mod state;
mod swap;
mod tx;

pub use commitment::{CarriedSections, JClaimAccumulator};
pub use context::AccountExecutionContext;
pub use delta::{Delta, DeltaPerspective, TokenId};
pub use engine::{AccountTransition, AccountVerdict, SequentialAccountEngine};
pub use envelope::{AccountEnvelope, EnvelopeError};
// The canonical value model is part of the engine's public boundary: the
// process layer decodes carried replica sections straight into it.
pub use error::{AccountRejection, StateError, TransitionError, ValidationRejection};
pub use htlc::{
    HTLC_OPAQUE_CIPHERTEXT_VERSION, HtlcBoundaryError, HtlcDeliveryMode, HtlcHashlock, HtlcLock,
    HtlcLockTx, HtlcRejection, HtlcResolveOutcome, HtlcResolveTx, OpaqueHtlcCiphertext,
    encode_htlc_lock_value, htlc_lock_radix_key, htlc_lock_value_digest,
};
pub use identity::{AccountDomain, AccountIdentity, DepositoryAddress, EntityId, Side, WatchSeed};
pub use output::AccountOutput;
pub use rebalance::{BilateralRebalanceFeePolicy, RebalanceFeePolicySnapshot};
pub use state::{
    AccountDisputeConfig, AccountReplica, AccountState, AccountStateSeed, LendingIntentKind,
};
pub use swap::{SwapMarketPolicy, SwapOffer, SwapToken};
pub use tx::{AccountTx, DeliveryMode, LendingAction, LendingTermId, ReserveSide};
pub use xln_rscore_protocol::CanonicalValue;
