//! Mirrors `core/account/j-claims`: authenticated pending jurisdiction claims.

mod accumulator;
mod codec;
mod events;
mod frame_value;
mod proof;
mod store;
mod transition;
mod types;

pub use accumulator::{JClaimMutation, JClaimNodeChanges, JClaimStore};
pub use codec::{
    EMPTY_J_CLAIM_ROOT, JClaimNode, JClaimProof, JClaimRecord, JClaimSide, account_key, claim_key,
    hash_node,
};
pub use events::canonical_events_hash;
pub use transition::{apply_claim_transition, prepare_claim_tx};
pub use types::{
    AccountSettledEvent, JClaimStatus, JClaimTransition, JEventClaimTx, JEventMetadata,
    JurisdictionEvent,
};

pub(crate) use frame_value::{canonical_event_value, canonical_proof_value};

pub(crate) use store::validate_store_for_roots;
