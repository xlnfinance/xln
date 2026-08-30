//! Mirrors `core/account/j-claims`: authenticated pending jurisdiction claims.

mod accumulator;
mod codec;
#[path = "events/event_types.rs"]
mod event_types;
#[path = "events/event_value.rs"]
mod event_value;
#[path = "events/event_value_support.rs"]
mod event_value_support;
mod events;
mod evidence;
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
pub use event_types::*;
pub use events::{canonical_event_key, canonical_events, canonical_events_hash};
pub use evidence::{
    canonical_dispute_finalization_evidence_hash, canonical_dispute_finalization_evidence_key,
    normalize_dispute_finalization_evidence,
};
pub(crate) use transition::{
    AccountJEventClaimAdmissionResult, LocalClaimPlan, QueuedClaimWitness,
    apply_admitted_claim_transition, plan_local_claim, validate_j_event_claim_admission,
};
pub use transition::{apply_claim_transition, prepare_claim_tx};
pub use types::{JClaimStatus, JClaimTransition, JEventClaimTx};

pub use event_value::canonical_event_value;
pub(crate) use frame_value::canonical_proof_value;

pub(crate) use store::validate_store_for_roots;
