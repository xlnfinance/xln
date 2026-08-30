use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, DisputeFinalizationEvidence, EntityId, JurisdictionEvent};

use crate::{AccountEnvelopeMutation, AccountProposalWork, EntityFrameEvent, LocalEntityOutput};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JReserveUpdate {
    pub token_id: u16,
    pub own_reserve: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JClaimIngress {
    pub account_id: EntityId,
    pub tx: AccountTx,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedJEventBatch {
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
    /// Complete canonical event block in EVM log order. Account projection is
    /// derived below; Entity-owned J semantics consume this same authority.
    pub events: Vec<JurisdictionEvent>,
    pub dispute_finalization_evidence: Vec<DisputeFinalizationEvidence>,
    pub reserve_updates: Vec<JReserveUpdate>,
    pub account_claims: Vec<JClaimIngress>,
}

/// Exact TS `REB_STEP:4` semantic row. Runtime may render it as a diagnostic
/// after the enclosing Entity frame is durable; it is never authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JEventClaimQueued {
    pub entity_id: String,
    pub counterparty_id: String,
    pub token_id: u16,
    pub j_height: u64,
}

#[derive(Clone, Debug)]
pub struct EntityJEventIngress {
    pub proposal_work: Vec<AccountProposalWork>,
    pub account_envelope_mutations: Vec<(String, AccountEnvelopeMutation)>,
    pub queued_claims: Vec<JEventClaimQueued>,
    pub routed_entity_outputs: Vec<LocalEntityOutput>,
    pub frame_events: Vec<EntityFrameEvent>,
}
