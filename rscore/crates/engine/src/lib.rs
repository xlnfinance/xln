//! Deterministic, path-copy Account execution.
//!
//! This crate is deliberately not wired into production yet. Its public API is
//! a closed Rust model whose candidate result can be compared with the
//! canonical TypeScript engine before native execution is enabled.

mod balance;
mod delta;
mod engine;
mod error;
mod identity;
mod lending;
mod mutation;
mod output;
mod state;
mod tx;

pub use delta::{Delta, DeltaPerspective, TokenId};
pub use engine::{AccountTransition, AccountVerdict, SequentialAccountEngine};
pub use error::{AccountRejection, StateError, TransitionError, ValidationRejection};
pub use identity::{AccountDomain, AccountIdentity, DepositoryAddress, EntityId, Side, WatchSeed};
pub use output::AccountOutput;
pub use state::{AccountReplica, AccountState, LendingIntentKind};
pub use tx::{AccountTx, DeliveryMode, LendingAction, LendingTermId, ReserveSide};
