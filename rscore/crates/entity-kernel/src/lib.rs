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
mod snapshot;
mod types;

pub use commitment::compute_entity_owned_sections;
pub use consensus::{
    EntityConsensusError, EntityConsensusSection, compute_entity_consensus_root,
    compute_entity_section_digest,
};
pub use error::EntityKernelError;
pub use kernel::apply_entity_kernel;
pub use orderbook::{
    BookOrder, BookPricePageEntrySnapshot, BookPricePageSnapshot, BookState, BookStateSnapshot,
    OrderbookState, OrderbookStateSnapshot, PairDimensions, PairPolicy, SameJOffer, Side,
    compute_book_commitment_hash,
};
#[cfg(feature = "bench")]
pub use orderbook::{OrderbookBenchmarkResult, run_orderbook_benchmark};
pub use resident::{
    ResidentEntityError, ResidentEntityRequest, ResidentEntityResult, apply_resident_entity_round,
};
pub use snapshot::{EntityStateSnapshot, capture_entity_state, restore_entity_state};
pub use types::{
    AccountProposalWork, CommittedAccountTransition, DeterministicContext, EntityKernelCommitments,
    EntityKernelOutput, EntityKernelResult, EntityReferral, EntityStateSlice, HtlcPreparedBinding,
    HtlcPreparedOutcome, HtlcRoute, HubProfile, JurisdictionScope, LockBookEntry,
    OrderbookConsensusMetadata, OrderedAccountCommit, PreparedHtlcEntry, SpreadDistribution,
};
