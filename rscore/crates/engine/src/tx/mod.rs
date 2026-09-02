//! Mirrors `core/account/tx`. This file itself carries the `AccountTx` model,
//! whose TypeScript twin lives in `core/types/account.ts`.

pub(crate) mod apply;
pub(crate) mod apply_result;
pub(crate) mod apply_types;
pub(crate) mod handlers;

use num_bigint::BigInt;

use crate::{CanonicalValue, HtlcLockTx, HtlcResolveTx, JEventClaimTx, StateError, TokenId};

pub const ACCOUNT_TX_TYPES: [&str; 23] = [
    "direct_payment",
    "lending_fund",
    "lending_borrow_request",
    "lending_repay",
    "lending_credit",
    "lending_close_request",
    "lending_close_payout",
    "add_delta",
    "set_credit_limit",
    "request_collateral",
    "rebalance_refund",
    "rebalance_policy",
    "htlc_lock",
    "htlc_resolve",
    "cross_pull_lock",
    "cross_pull_close",
    "cross_pull_progress",
    "swap_offer",
    "swap_cancel_request",
    "swap_resolve",
    "cross_swap_fill_ack",
    "settle_transition",
    "j_event_claim",
];

/// Canonical Account admission profile shared with
/// `core/account/tx/admission-policy.ts`.
///
/// These variants remain hashable so historical signed frames can still be
/// verified, but neither local admission nor a new peer frame may introduce
/// them into live bilateral consensus. Reserve movement uses `j_event_claim`;
/// lending is not part of the production RRS Account profile.
pub(crate) fn account_tx_admission_error(tx: &AccountTx) -> Option<StateError> {
    matches!(
        tx,
        AccountTx::LendingFund { .. }
            | AccountTx::LendingBorrowRequest { .. }
            | AccountTx::LendingRepay { .. }
            | AccountTx::LendingCredit { .. }
            | AccountTx::LendingCloseRequest { .. }
            | AccountTx::LendingClosePayout { .. }
    )
    .then(|| StateError::AccountTxKindOutOfProfile(tx.wire_name()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryMode {
    Direct,
    Trusted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingTermId {
    OneHour,
    OneDay,
    OneMonth,
}

impl LendingTermId {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::OneHour => "1h",
            Self::OneDay => "1d",
            Self::OneMonth => "1m",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingAction {
    Grant,
    Revoke,
}

impl LendingAction {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Grant => "grant",
            Self::Revoke => "revoke",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReserveSide {
    Receiving,
    Counterparty,
}

impl ReserveSide {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Receiving => "receiving",
            Self::Counterparty => "counterparty",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebalanceRefundReason {
    PolicyMismatch,
    Timeout,
    FeeTooLow,
    Manual,
}

impl RebalanceRefundReason {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::PolicyMismatch => "policy_mismatch",
            Self::Timeout => "timeout",
            Self::FeeTooLow => "fee_too_low",
            Self::Manual => "manual",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountTx {
    JEventClaim(JEventClaimTx),
    AddDelta {
        token_id: TokenId,
    },
    SetCreditLimit {
        token_id: TokenId,
        amount: BigInt,
    },
    RebalancePolicy {
        token_id: u32,
        /// TypeScript admits any positive safe integer, so this is u64 and the
        /// wire keeps the whole domain instead of disabling the mirror.
        policy_version: u64,
        base_fee: BigInt,
        liquidity_fee_bps: BigInt,
        gas_fee: BigInt,
    },
    SwapOffer {
        offer_id: String,
        give_token_id: u32,
        give_token_decimals: u32,
        give_amount: BigInt,
        want_token_id: u32,
        want_token_decimals: u32,
        want_amount: BigInt,
        max_fee: BigInt,
        min_net_receive: BigInt,
        time_in_force: Option<u8>,
        price_ticks: Option<BigInt>,
        cross_jurisdiction: Option<CanonicalValue>,
    },
    SwapResolve {
        offer_id: String,
        fill_ratio: u32,
        fill_numerator: Option<BigInt>,
        fill_denominator: Option<BigInt>,
        cancel_remainder: bool,
        /// Carried, never interpreted. TypeScript hashes whatever the matcher
        /// wrote here, so an engine that dropped it would sign a frame the
        /// other side cannot reproduce.
        comment: Option<String>,
        fee_token_id: Option<u32>,
        fee_amount: Option<BigInt>,
        execution_give_amount: Option<BigInt>,
        execution_want_amount: Option<BigInt>,
        /// The book's own view of the resting remainder. Carried for the same
        /// reason as `comment`: TypeScript hashes it.
        resting_give_token_id: Option<u32>,
        resting_want_token_id: Option<u32>,
        resting_price_ticks: Option<BigInt>,
        resting_give_amount: Option<BigInt>,
        resting_want_amount: Option<BigInt>,
        resting_quantized_give: Option<BigInt>,
        resting_quantized_want: Option<BigInt>,
    },
    SwapCancelRequest {
        offer_id: String,
    },
    DirectPayment {
        token_id: TokenId,
        amount: BigInt,
        route: Vec<String>,
        description: Option<String>,
        from_entity_id: String,
        to_entity_id: String,
        delivery_mode: DeliveryMode,
        trusted_gateway_entity_id: Option<String>,
    },
    LendingFund {
        position_id: String,
        hub_entity_id: String,
        lender_entity_id: String,
        token_id: TokenId,
        amount: BigInt,
        term_id: LendingTermId,
        interest_bps: i64,
    },
    LendingBorrowRequest {
        request_id: String,
        hub_entity_id: String,
        borrower_entity_id: String,
        // This transition records the signed value without touching Delta, so
        // the current TypeScript semantics allow the full safe-integer domain.
        token_id: u64,
        amount: BigInt,
        term_id: LendingTermId,
        max_interest_bps: i64,
    },
    LendingRepay {
        loan_id: String,
        hub_entity_id: String,
        borrower_entity_id: String,
        token_id: TokenId,
        amount: BigInt,
    },
    LendingCredit {
        action: LendingAction,
        loan_id: String,
        hub_entity_id: String,
        borrower_entity_id: String,
        token_id: TokenId,
        credit_limit: BigInt,
    },
    LendingCloseRequest {
        position_id: String,
        hub_entity_id: String,
        lender_entity_id: String,
    },
    LendingClosePayout {
        position_id: String,
        hub_entity_id: String,
        lender_entity_id: String,
        token_id: TokenId,
        amount: BigInt,
    },
    RequestCollateral {
        token_id: TokenId,
        amount: BigInt,
        fee_token_id: Option<TokenId>,
        fee_amount: BigInt,
        policy_version: u64,
    },
    RebalanceRefund {
        request_id: String,
        request_token_id: TokenId,
        amount: BigInt,
        reason: RebalanceRefundReason,
    },
    /// The five cross-j/settlement transactions retain their exact canonical
    /// TypeScript data object. Their nested route, close-proof and Hanko
    /// records are already consensus values; representing them a second time
    /// as a parallel Rust object graph would create a second codec and invite
    /// omitted-field parity bugs. Handlers project only the fields they own.
    CrossPullLock {
        data: CanonicalValue,
    },
    CrossPullClose {
        data: CanonicalValue,
    },
    CrossPullProgress {
        data: CanonicalValue,
    },
    CrossSwapFillAck {
        data: CanonicalValue,
    },
    SettleTransition {
        data: CanonicalValue,
    },
    HtlcLock(HtlcLockTx),
    HtlcResolve(HtlcResolveTx),
}

impl AccountTx {
    pub const fn wire_name(&self) -> &'static str {
        match self {
            Self::DirectPayment { .. } => "direct_payment",
            Self::LendingFund { .. } => "lending_fund",
            Self::LendingBorrowRequest { .. } => "lending_borrow_request",
            Self::LendingRepay { .. } => "lending_repay",
            Self::LendingCredit { .. } => "lending_credit",
            Self::LendingCloseRequest { .. } => "lending_close_request",
            Self::LendingClosePayout { .. } => "lending_close_payout",
            Self::AddDelta { .. } => "add_delta",
            Self::SetCreditLimit { .. } => "set_credit_limit",
            Self::RequestCollateral { .. } => "request_collateral",
            Self::RebalanceRefund { .. } => "rebalance_refund",
            Self::RebalancePolicy { .. } => "rebalance_policy",
            Self::HtlcLock(_) => "htlc_lock",
            Self::HtlcResolve(_) => "htlc_resolve",
            Self::CrossPullLock { .. } => "cross_pull_lock",
            Self::CrossPullClose { .. } => "cross_pull_close",
            Self::CrossPullProgress { .. } => "cross_pull_progress",
            Self::SwapOffer { .. } => "swap_offer",
            Self::SwapCancelRequest { .. } => "swap_cancel_request",
            Self::SwapResolve { .. } => "swap_resolve",
            Self::CrossSwapFillAck { .. } => "cross_swap_fill_ack",
            Self::SettleTransition { .. } => "settle_transition",
            Self::JEventClaim(_) => "j_event_claim",
        }
    }
}
