use ethabi::ethereum_types::U256;
use num_bigint::BigInt;

pub type Word = [u8; 32];
pub type Address = [u8; 20];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JBatch {
    pub flashloans: Vec<Flashloan>,
    pub reserve_to_reserve: Vec<ReserveToReserve>,
    pub reserve_to_collateral: Vec<ReserveToCollateral>,
    pub collateral_to_reserve: Vec<CollateralToReserve>,
    pub settlements: Vec<Settlement>,
    pub dispute_starts: Vec<InitialDisputeProof>,
    pub counter_disputes: Vec<CounterDisputeProof>,
    pub dispute_finalizations: Vec<FinalDisputeProof>,
    pub external_token_to_reserve: Vec<ExternalTokenToReserve>,
    pub reserve_to_external_token: Vec<ReserveToExternalToken>,
    pub reveal_secrets: Vec<SecretReveal>,
    pub hash_ladder_registrations: Vec<HashLadderRegistration>,
}

pub(crate) fn batch_is_empty(batch: &JBatch) -> bool {
    batch.flashloans.is_empty()
        && batch.reserve_to_reserve.is_empty()
        && batch.reserve_to_collateral.is_empty()
        && batch.collateral_to_reserve.is_empty()
        && batch.settlements.is_empty()
        && batch.dispute_starts.is_empty()
        && batch.counter_disputes.is_empty()
        && batch.dispute_finalizations.is_empty()
        && batch.external_token_to_reserve.is_empty()
        && batch.reserve_to_external_token.is_empty()
        && batch.reveal_secrets.is_empty()
        && batch.hash_ladder_registrations.is_empty()
}

pub(crate) fn batch_op_count(batch: &JBatch) -> usize {
    batch.flashloans.len()
        + batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flashloan {
    pub token_id: U256,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveToReserve {
    pub receiving_entity: Word,
    pub token_id: U256,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityAmount {
    pub entity: Word,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveToCollateral {
    pub token_id: U256,
    pub receiving_entity: Word,
    pub pairs: Vec<EntityAmount>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollateralToReserve {
    pub counterparty: Word,
    pub token_id: U256,
    pub amount: U256,
    pub nonce: U256,
    pub sig: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementDiff {
    pub token_id: U256,
    pub left_diff: BigInt,
    pub right_diff: BigInt,
    pub collateral_diff: BigInt,
    pub ondelta_diff: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub left_entity: Word,
    pub right_entity: Word,
    pub diffs: Vec<SettlementDiff>,
    pub forgive_debts_in_token_ids: Vec<U256>,
    pub sig: Vec<u8>,
    pub nonce: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowance {
    pub delta_index: U256,
    pub right_allowance: U256,
    pub left_allowance: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransformerClause {
    pub transformer_address: Address,
    pub encoded_batch: Vec<u8>,
    pub allowances: Vec<Allowance>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofBody {
    pub watch_seed: Word,
    pub left_response_seconds: u32,
    pub right_response_seconds: u32,
    pub offdeltas: Vec<BigInt>,
    pub token_ids: Vec<U256>,
    pub transformers: Vec<TransformerClause>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitialDisputeProof {
    pub counterentity: Word,
    pub nonce: U256,
    pub proposer_is_left: bool,
    pub proofbody_hash: Word,
    pub initial_proofbody: ProofBody,
    pub watch_seed: Word,
    pub sig: Vec<u8>,
    pub starter_initial_arguments: Vec<u8>,
    pub starter_counter_arguments: Vec<u8>,
    pub starter_counter_proof_commitment: Word,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CounterDisputeProof {
    pub counterentity: Word,
    pub initial_nonce: U256,
    pub initial_proofbody_hash: Word,
    pub counter_nonce: U256,
    pub proposer_is_left: bool,
    pub counter_proofbody: ProofBody,
    pub sig: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalDisputeProof {
    pub counterentity: Word,
    pub initial_nonce: U256,
    pub final_nonce: U256,
    pub proposer_is_left: bool,
    pub initial_proofbody_hash: Word,
    pub final_proofbody: ProofBody,
    pub starter_arguments: Vec<u8>,
    pub other_arguments: Vec<u8>,
    pub sig: Vec<u8>,
    pub started_by_left: bool,
    pub cooperative: bool,
    /// Runtime-only authenticated L1 deadline. It is committed in Entity
    /// state but deliberately omitted from Depository ABI encoding.
    pub submit_not_before_timestamp: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalTokenToReserve {
    pub entity: Word,
    pub contract_address: Address,
    pub external_token_id: U256,
    pub token_type: u8,
    pub internal_token_id: U256,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReserveToExternalToken {
    pub receiving_entity: Word,
    pub token_id: U256,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretReveal {
    pub transformer: Address,
    pub secret: Word,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashLadderWitness {
    pub fill_ratio: u16,
    pub full_secret: Word,
    pub reveals: [Word; 4],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashLadderRegistration {
    pub counterparty_entity: Word,
    pub target_role: bool,
    pub full_hash: Word,
    pub partial_root: Word,
    pub witness: HashLadderWitness,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedJBatch {
    pub entity_id: Word,
    /// Runtime-local signer selected by Entity consensus; for external-token
    /// deposits this exact EOA must be `msg.sender` because Depository pulls
    /// ERC-20/721/1155 assets from it.
    pub signer_id: Address,
    pub nonce: U256,
    pub batch: JBatch,
    pub hanko: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum JBatchStatus {
    #[default]
    Empty,
    Accumulating,
    Sent,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JurisdictionConfig {
    pub address: String,
    pub name: String,
    pub entity_provider_address: String,
    pub depository_address: String,
    pub chain_id: Option<u64>,
    pub block_time_ms: Option<u64>,
    pub registration_block: Option<u64>,
    pub entity_provider_deployment_block: Option<u64>,
    pub rebalance_policy_usd: Option<RebalancePolicyUsd>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebalancePolicyUsd {
    pub r2c_request_soft_limit: u64,
    pub hard_limit: u64,
    pub max_fee: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JBatchFeeOverrides {
    pub gas_bump_bps: Option<u32>,
    pub max_fee_per_gas_wei: Option<String>,
    pub max_priority_fee_per_gas_wei: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeFailureCategory {
    ExpectedEmpty,
    TransientRace,
    Contradiction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFailureSignal {
    pub category: RuntimeFailureCategory,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub fatal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JBatchLastFailure {
    pub message: String,
    pub failed_at: u64,
    pub failure: RuntimeFailureSignal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JBatchTerminalFailure {
    pub message: String,
    pub failed_at: u64,
    pub failure: Option<RuntimeFailureSignal>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentJBatch {
    pub batch: JBatch,
    pub batch_hash: Word,
    pub encoded_batch: Vec<u8>,
    pub entity_nonce: u64,
    pub first_submitted_at: u64,
    pub last_submitted_at: u64,
    pub submit_attempts: u32,
    pub fee_overrides: Option<JBatchFeeOverrides>,
    pub transaction_hash: Option<Word>,
    pub last_failure: Option<JBatchLastFailure>,
    pub terminal_failure: Option<JBatchTerminalFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JBatchState {
    pub batch: JBatch,
    pub jurisdiction: Option<JurisdictionConfig>,
    pub last_broadcast: u64,
    pub broadcast_count: u64,
    pub failed_attempts: u64,
    pub status: JBatchStatus,
    pub sent_batch: Option<SentJBatch>,
    pub recovery_batches: Vec<JBatch>,
    pub auto_broadcast_draft: bool,
    pub entity_nonce: Option<u64>,
}

impl Default for JBatchState {
    fn default() -> Self {
        Self {
            batch: JBatch::default(),
            jurisdiction: None,
            last_broadcast: 0,
            broadcast_count: 0,
            failed_attempts: 0,
            status: JBatchStatus::Empty,
            sent_batch: None,
            recovery_batches: Vec::new(),
            auto_broadcast_draft: false,
            entity_nonce: None,
        }
    }
}
