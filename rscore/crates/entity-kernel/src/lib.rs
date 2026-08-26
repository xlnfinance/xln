#![forbid(unsafe_code)]

//! Pure Entity orchestration over already-committed Account transitions.
//!
//! This workspace module is selected only by the explicit Rust Entity stack.
//! Its TypeScript-generated fixtures keep the payment/same-j slice exact while
//! the production coordinator boundary is integrated.

mod commitment;
mod consensus;
mod error;
mod kernel;
mod orderbook;
mod paybook;
mod resident;
mod types;

pub use consensus::{
    EntityConsensusError, EntityConsensusSection, compute_entity_consensus_root,
    compute_entity_section_digest,
};
pub use error::EntityKernelError;
pub use kernel::apply_entity_kernel;
pub use orderbook::{
    BookOrder, BookState, OrderbookState, PairDimensions, PairPolicy, SameJOffer, Side,
    compute_book_commitment_hash,
};
pub use resident::{
    ResidentEntityError, ResidentEntityRequest, ResidentEntityResult, apply_resident_entity_round,
};
pub use types::{
    AccountProposalWork, CommittedAccountTransition, DeterministicContext, EntityKernelCommitments,
    EntityKernelOutput, EntityKernelResult, EntityStateSlice, HtlcPreparedBinding,
    HtlcPreparedOutcome, HtlcRoute, JurisdictionScope, LockBookEntry, OrderedAccountCommit,
    PreparedHtlcEntry,
};
