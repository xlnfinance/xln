use num_bigint::BigInt;
use std::collections::BTreeMap;

use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, DeliveryMode, LendingTermId, TokenId, WatchSeed,
};

use crate::types::OriginatedHtlcDeliveryMode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectPaymentEntityTx {
    pub target_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub route: Vec<String>,
    pub description: Option<String>,
    pub delivery_mode: DeliveryMode,
    pub trusted_gateway_entity_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenAccountEntityTx {
    pub target_entity_id: String,
    pub dispute_config: AccountDisputeConfig,
    pub account_domain: AccountDomain,
    pub watch_seed: WatchSeed,
    pub credit_amount: Option<BigInt>,
    pub token_id: TokenId,
    pub pin_public: bool,
    pub rebalance_policy: Option<CanonicalRebalancePolicy>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalRebalancePolicy {
    pub r2c_request_soft_limit: BigInt,
    pub hard_limit: BigInt,
    pub max_acceptable_fee: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcPaymentEntityTx {
    pub target_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub max_sender_debit: BigInt,
    pub route: Vec<String>,
    pub description: Option<String>,
    pub delivery_mode: OriginatedHtlcDeliveryMode,
    pub started_at_ms: Option<u64>,
    pub hashlock: Option<String>,
    pub tx_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceSwapOfferEntityTx {
    pub counterparty_entity_id: String,
    pub offer_id: String,
    pub give_token_id: u32,
    pub give_token_decimals: u32,
    pub give_amount: BigInt,
    pub want_token_id: u32,
    pub want_token_decimals: u32,
    pub want_amount: BigInt,
    pub max_fee: BigInt,
    pub min_net_receive: BigInt,
    pub price_ticks: Option<BigInt>,
    pub time_in_force: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposeCancelSwapEntityTx {
    pub counterparty_entity_id: String,
    pub offer_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtendCreditEntityTx {
    pub counterparty_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestCollateralEntityTx {
    pub counterparty_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub fee_token_id: Option<TokenId>,
    pub fee_amount: BigInt,
    pub policy_version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessHtlcTimeoutsEntityTx {
    pub expired_locks: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetRebalancePolicyEntityTx {
    pub counterparty_entity_id: String,
    pub token_id: TokenId,
    pub r2c_request_soft_limit: BigInt,
    pub hard_limit: BigInt,
    pub max_acceptable_fee: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteBackedR2cEntityTx {
    pub counterparty_entity_id: String,
    pub receiving_entity_id: Option<String>,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub rebalance_quote_id: u64,
    pub rebalance_fee_token_id: Option<TokenId>,
    pub rebalance_fee_amount: Option<BigInt>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleProposeEntityTx {
    pub counterparty_entity_id: String,
    pub ops: Vec<xln_rscore_protocol::CanonicalValue>,
    pub executor_is_left: Option<bool>,
    pub memo: Option<String>,
    pub continuation: Option<xln_rscore_protocol::CanonicalValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleUpdateEntityTx {
    pub counterparty_entity_id: String,
    pub ops: Vec<xln_rscore_protocol::CanonicalValue>,
    pub executor_is_left: Option<bool>,
    pub memo: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleApproveEntityTx {
    pub counterparty_entity_id: String,
    pub workspace_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleExecuteEntityTx {
    pub counterparty_entity_id: String,
    pub disable_c2r_shortcut: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleRejectEntityTx {
    pub counterparty_entity_id: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareDisputeEntityTx {
    pub counterparty_entity_id: String,
    pub description: Option<String>,
    pub min_cooldown_ms: u64,
    pub cross_jurisdiction_route_id: Option<String>,
    pub starter_initial_arguments: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeStartEntityTx {
    pub counterparty_entity_id: String,
    pub description: Option<String>,
    pub cross_jurisdiction_route_id: Option<String>,
    pub starter_initial_arguments: Option<String>,
    pub starter_counter_arguments: Option<String>,
    pub starter_counter_proof_commitment: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeFinalizeEntityTx {
    pub counterparty_entity_id: String,
    pub use_onchain_registry: bool,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveHtlcLockEntityTx {
    pub counterparty_entity_id: String,
    pub lock_id: String,
    pub secret: String,
    pub cross_jurisdiction_route_id: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForceSiblingDisputeEntityTx {
    pub route_id: String,
    pub observed_counterparty_entity_id: String,
    pub observed_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountEnvelopeMutation {
    ClearRebalanceActiveQuote,
    SetRejectedFrameEvidence {
        reason: String,
        frame_hash: [u8; 32],
        frame_hanko: Vec<u8>,
    },
    SetRebalancePolicy {
        token_id: u32,
        policy: xln_rscore_protocol::CanonicalValue,
    },
    SetRebalanceSubmittedAt {
        token_id: u32,
        submitted_at: Option<u64>,
    },
    ReplaceDisputeLifecycle {
        status: String,
        dispute_prepare: Option<xln_rscore_protocol::CanonicalValue>,
        active_dispute: Option<xln_rscore_protocol::CanonicalValue>,
    },
    ApplyDisputeStarted(xln_rscore_engine::AccountDisputeStartedFinality),
    ApplyDisputeFinality(xln_rscore_engine::AccountDisputeFinality),
    ConfirmDisputeBookRemoval {
        order_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingOfferEntityTx {
    pub position_id: String,
    pub hub_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub term_id: LendingTermId,
    pub interest_bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingBorrowEntityTx {
    pub request_id: String,
    pub hub_entity_id: String,
    pub token_id: u64,
    pub amount: BigInt,
    pub term_id: LendingTermId,
    pub max_interest_bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingRepayEntityTx {
    pub hub_entity_id: String,
    pub loan_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingClosePositionEntityTx {
    pub hub_entity_id: String,
    pub position_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalEntityFinancialTx {
    CrossJurisdictionForceSiblingDispute(ForceSiblingDisputeEntityTx),
    DirectPayment(DirectPaymentEntityTx),
    DisputeFinalize(DisputeFinalizeEntityTx),
    DisputeStart(DisputeStartEntityTx),
    ExtendCredit(ExtendCreditEntityTx),
    HtlcPayment(HtlcPaymentEntityTx),
    LendingBorrow(LendingBorrowEntityTx),
    LendingClosePosition(LendingClosePositionEntityTx),
    LendingOffer(LendingOfferEntityTx),
    LendingRepay(LendingRepayEntityTx),
    OpenAccount(OpenAccountEntityTx),
    PlaceSwapOffer(PlaceSwapOfferEntityTx),
    PrepareDispute(PrepareDisputeEntityTx),
    ProcessHtlcTimeouts(ProcessHtlcTimeoutsEntityTx),
    ProposeCancelSwap(ProposeCancelSwapEntityTx),
    RequestCollateral(RequestCollateralEntityTx),
    ResolveHtlcLock(ResolveHtlcLockEntityTx),
    QuoteBackedR2c(QuoteBackedR2cEntityTx),
    SetRebalancePolicy(SetRebalancePolicyEntityTx),
    SettleApprove(SettleApproveEntityTx),
    SettleExecute(SettleExecuteEntityTx),
    SettlePropose(SettleProposeEntityTx),
    SettleReject(SettleRejectEntityTx),
    SettleUpdate(SettleUpdateEntityTx),
}

/// Compact post-inbound Account projection used by Entity-local financial
/// admission. No replica, radix node, mempool or consensus envelope crosses
/// the permanent Account-worker boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalAccountFinancialView {
    pub active: bool,
    pub owner_side: xln_rscore_engine::Side,
    pub owner_out_capacity: BTreeMap<TokenId, BigInt>,
    pub owner_peer_credit_limit: BTreeMap<TokenId, BigInt>,
    pub settlement_workspace: Option<xln_rscore_protocol::CanonicalValue>,
    pub settlement_transition_pending: bool,
    pub settlement_execution: Result<xln_rscore_engine::PreparedSettlementExecution, String>,
    pub rebalance_active_quote: Option<xln_rscore_protocol::CanonicalValue>,
    pub htlc_locks: BTreeMap<String, xln_rscore_engine::HtlcLock>,
    pub pulls: BTreeMap<String, xln_rscore_protocol::CanonicalValue>,
    pub swap_offers: BTreeMap<String, xln_rscore_engine::SwapOfferSnapshot>,
    pub pending_cross_pull_close_ids: std::collections::BTreeSet<String>,
    pub pending_cross_swap_ack_ids: std::collections::BTreeSet<String>,
    pub dispute: Option<xln_rscore_batch::ResidentAccountDisputeView>,
}

impl From<xln_rscore_batch::ResidentAccountFinancialView> for LocalAccountFinancialView {
    fn from(view: xln_rscore_batch::ResidentAccountFinancialView) -> Self {
        Self {
            active: view.active,
            owner_side: view.owner_side,
            owner_out_capacity: view.owner_out_capacity,
            owner_peer_credit_limit: view.owner_peer_credit_limit,
            settlement_workspace: view.settlement_workspace,
            settlement_transition_pending: view.settlement_transition_pending,
            settlement_execution: view.settlement_execution,
            rebalance_active_quote: view.rebalance_active_quote,
            htlc_locks: view.htlc_locks,
            pulls: view.pulls,
            swap_offers: view.swap_offers,
            pending_cross_pull_close_ids: view.pending_cross_pull_close_ids,
            pending_cross_swap_ack_ids: view.pending_cross_swap_ack_ids,
            dispute: view.dispute,
        }
    }
}
