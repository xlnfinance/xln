//! Canonical values carried by the 18 TypeScript `JurisdictionEvent` variants.
//!
//! These are consensus values, not watcher DTOs.  The watcher must normalize
//! untrusted RPC data before constructing them; wire and checkpoint decoders
//! enforce the same widths and integer domains again.

use num_bigint::BigInt;

use crate::{EntityId, TokenId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeFinalizationEvidence {
    pub sender: String,
    pub counterentity: String,
    pub initial_nonce: String,
    pub final_nonce: String,
    pub initial_proofbody_hash: String,
    pub final_proofbody_hash: String,
    pub proposer_is_left: bool,
    pub left_arguments: String,
    pub right_arguments: String,
    pub started_by_left: bool,
    pub sig: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JEventMetadata {
    pub block_number: Option<u64>,
    pub block_hash: Option<[u8; 32]>,
    pub transaction_hash: Option<[u8; 32]>,
    pub log_index: Option<u64>,
    pub event_index: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofAllowance {
    pub delta_index: BigInt,
    pub right_allowance: BigInt,
    pub left_allowance: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofTransformerClause {
    pub transformer_address: String,
    pub encoded_batch: String,
    pub allowances: Vec<ProofAllowance>,
}

/// User-signed executable dispute policy.  This is deliberately distinct
/// from `JClaimProof`, which is a Patricia inclusion/non-inclusion proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofBody {
    pub watch_seed: String,
    pub left_response_seconds: u64,
    pub right_response_seconds: u64,
    pub offdeltas: Vec<BigInt>,
    pub token_ids: Vec<BigInt>,
    pub transformers: Vec<ProofTransformerClause>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundationBootstrappedEvent {
    pub metadata: JEventMetadata,
    pub recipient: [u8; 20],
    pub board_hash: [u8; 32],
    pub control_token_id: BigInt,
    pub dividend_token_id: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityRegisteredEvent {
    pub metadata: JEventMetadata,
    pub entity_id: EntityId,
    pub entity_number: BigInt,
    pub board_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardActivatedEvent {
    pub metadata: JEventMetadata,
    pub entity_id: EntityId,
    pub previous_board_hash: [u8; 32],
    pub new_board_hash: [u8; 32],
    pub previous_board_valid_until: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveUpdatedEvent {
    pub metadata: JEventMetadata,
    pub entity: String,
    pub token_id: i64,
    pub new_balance: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalTokenBalance {
    pub token_address: [u8; 20],
    pub token_id: Option<i64>,
    pub balance: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAllowance {
    pub token_address: [u8; 20],
    pub spender: [u8; 20],
    pub allowance: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWalletSnapshotEvent {
    pub metadata: JEventMetadata,
    pub entity_id: String,
    pub owner: [u8; 20],
    pub native_balance: Option<BigInt>,
    pub token_balances: Vec<ExternalTokenBalance>,
    pub allowances: Vec<ExternalAllowance>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalWalletDeltaEvent {
    pub metadata: JEventMetadata,
    pub entity_id: String,
    pub owner: [u8; 20],
    pub token_address: [u8; 20],
    pub token_id: Option<i64>,
    pub balance_delta: Option<BigInt>,
    pub spender: Option<[u8; 20]>,
    pub allowance: Option<BigInt>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretRevealedEvent {
    pub metadata: JEventMetadata,
    pub hashlock: String,
    pub revealer: String,
    pub secret: String,
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
pub struct HankoBatchProcessedEvent {
    pub metadata: JEventMetadata,
    pub entity_id: EntityId,
    pub batch_hash: [u8; 32],
    pub nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProviderActionExecutedEvent {
    pub metadata: JEventMetadata,
    pub entity_id: EntityId,
    pub action_nonce: BigInt,
    pub action_hash: [u8; 32],
    pub action_kind: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProviderActionCancelledEvent {
    pub metadata: JEventMetadata,
    pub entity_id: EntityId,
    pub action_nonce: BigInt,
    pub cancelled_action_hash: [u8; 32],
    pub cancelled_action_kind: u8,
    pub cancel_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebtCreatedEvent {
    pub metadata: JEventMetadata,
    pub debtor: String,
    pub creditor: String,
    pub token_id: i64,
    pub amount: BigInt,
    pub debt_index: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeStartedEvent {
    pub metadata: JEventMetadata,
    pub sender: String,
    pub counterentity: String,
    pub nonce: BigInt,
    pub proposer_is_left: bool,
    pub proofbody_hash: String,
    pub watch_seed: [u8; 32],
    pub starter_initial_arguments: Vec<u8>,
    pub starter_counter_arguments: Vec<u8>,
    pub starter_counter_proof_commitment: [u8; 32],
    pub initial_proofbody: ProofBody,
    pub dispute_timeout: u64,
    pub dispute_start_timestamp: u64,
    pub left_response_seconds: u64,
    pub right_response_seconds: u64,
    pub batch_nonce: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeFinalizedEvent {
    pub metadata: JEventMetadata,
    pub sender: String,
    pub counterentity: String,
    pub initial_nonce: BigInt,
    pub initial_proofbody_hash: String,
    pub final_proofbody_hash: String,
    pub finalization_evidence_hash: String,
    pub final_proofbody: ProofBody,
    pub batch_nonce: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CounterDisputeRegisteredEvent {
    pub metadata: JEventMetadata,
    pub sender: String,
    pub counterentity: String,
    pub nonce: i64,
    pub proposer_is_left: bool,
    pub proofbody_hash: [u8; 32],
    pub counter_proofbody: ProofBody,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashLadderRevealRegisteredEvent {
    pub metadata: JEventMetadata,
    pub entity: String,
    pub counterparty_entity: String,
    pub ladder_hash: [u8; 32],
    pub fill_ratio: u16,
    pub full_secret: [u8; 32],
    pub reveals: [[u8; 32]; 4],
    pub target_role: bool,
    pub revealed_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebtEnforcedEvent {
    pub metadata: JEventMetadata,
    pub debtor: String,
    pub creditor: String,
    pub token_id: i64,
    pub amount_paid: BigInt,
    pub remaining_amount: BigInt,
    pub new_debt_index: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebtForgivenEvent {
    pub metadata: JEventMetadata,
    pub debtor: String,
    pub creditor: String,
    pub token_id: i64,
    pub amount_forgiven: BigInt,
    pub debt_index: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JurisdictionEvent {
    AccountSettled(AccountSettledEvent),
    FoundationBootstrapped(FoundationBootstrappedEvent),
    EntityRegistered(EntityRegisteredEvent),
    BoardActivated(BoardActivatedEvent),
    ReserveUpdated(ReserveUpdatedEvent),
    ExternalWalletSnapshot(ExternalWalletSnapshotEvent),
    ExternalWalletDelta(ExternalWalletDeltaEvent),
    SecretRevealed(SecretRevealedEvent),
    HankoBatchProcessed(HankoBatchProcessedEvent),
    EntityProviderActionExecuted(EntityProviderActionExecutedEvent),
    EntityProviderActionCancelled(EntityProviderActionCancelledEvent),
    DebtCreated(DebtCreatedEvent),
    DisputeStarted(DisputeStartedEvent),
    DisputeFinalized(DisputeFinalizedEvent),
    CounterDisputeRegistered(CounterDisputeRegisteredEvent),
    HashLadderRevealRegistered(HashLadderRevealRegisteredEvent),
    DebtEnforced(DebtEnforcedEvent),
    DebtForgiven(DebtForgivenEvent),
}

impl JurisdictionEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::AccountSettled(_) => "AccountSettled",
            Self::FoundationBootstrapped(_) => "FoundationBootstrapped",
            Self::EntityRegistered(_) => "EntityRegistered",
            Self::BoardActivated(_) => "BoardActivated",
            Self::ReserveUpdated(_) => "ReserveUpdated",
            Self::ExternalWalletSnapshot(_) => "ExternalWalletSnapshot",
            Self::ExternalWalletDelta(_) => "ExternalWalletDelta",
            Self::SecretRevealed(_) => "SecretRevealed",
            Self::HankoBatchProcessed(_) => "HankoBatchProcessed",
            Self::EntityProviderActionExecuted(_) => "EntityProviderActionExecuted",
            Self::EntityProviderActionCancelled(_) => "EntityProviderActionCancelled",
            Self::DebtCreated(_) => "DebtCreated",
            Self::DisputeStarted(_) => "DisputeStarted",
            Self::DisputeFinalized(_) => "DisputeFinalized",
            Self::CounterDisputeRegistered(_) => "CounterDisputeRegistered",
            Self::HashLadderRevealRegistered(_) => "HashLadderRevealRegistered",
            Self::DebtEnforced(_) => "DebtEnforced",
            Self::DebtForgiven(_) => "DebtForgiven",
        }
    }

    pub fn metadata(&self) -> &JEventMetadata {
        match self {
            Self::AccountSettled(value) => &value.metadata,
            Self::FoundationBootstrapped(value) => &value.metadata,
            Self::EntityRegistered(value) => &value.metadata,
            Self::BoardActivated(value) => &value.metadata,
            Self::ReserveUpdated(value) => &value.metadata,
            Self::ExternalWalletSnapshot(value) => &value.metadata,
            Self::ExternalWalletDelta(value) => &value.metadata,
            Self::SecretRevealed(value) => &value.metadata,
            Self::HankoBatchProcessed(value) => &value.metadata,
            Self::EntityProviderActionExecuted(value) => &value.metadata,
            Self::EntityProviderActionCancelled(value) => &value.metadata,
            Self::DebtCreated(value) => &value.metadata,
            Self::DisputeStarted(value) => &value.metadata,
            Self::DisputeFinalized(value) => &value.metadata,
            Self::CounterDisputeRegistered(value) => &value.metadata,
            Self::HashLadderRevealRegistered(value) => &value.metadata,
            Self::DebtEnforced(value) => &value.metadata,
            Self::DebtForgiven(value) => &value.metadata,
        }
    }
}
