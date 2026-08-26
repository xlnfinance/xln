use num_bigint::BigInt;

use crate::commitment::JClaimAccumulator;
use crate::{EntityId, JClaimProof, TokenId};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JEventMetadata {
    pub block_number: Option<u64>,
    pub block_hash: Option<[u8; 32]>,
    pub transaction_hash: Option<[u8; 32]>,
    pub log_index: Option<u64>,
    pub event_index: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSettledEvent {
    pub metadata: JEventMetadata,
    pub left_entity: EntityId,
    pub right_entity: EntityId,
    pub token_id: TokenId,
    pub left_reserve: BigInt,
    pub right_reserve: BigInt,
    pub collateral: BigInt,
    pub ondelta: BigInt,
    pub nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JurisdictionEvent {
    AccountSettled(AccountSettledEvent),
}

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
