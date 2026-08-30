use crate::JClaimProof;
use crate::commitment::JClaimAccumulator;

use super::event_types::JurisdictionEvent;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JEventClaimTx {
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
    pub events: Vec<JurisdictionEvent>,
    pub left_proof: Option<JClaimProof>,
    pub right_proof: Option<JClaimProof>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JClaimStatus {
    Pending,
    Idempotent,
    Finalized,
    Stale,
}

pub struct JClaimTransition {
    pub status: JClaimStatus,
    pub left: JClaimAccumulator,
    pub right: JClaimAccumulator,
    pub events: Vec<JurisdictionEvent>,
}
