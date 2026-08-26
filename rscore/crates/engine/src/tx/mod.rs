//! Mirrors `core/account/tx`. This file itself carries the `AccountTx` model,
//! whose TypeScript twin lives in `core/types/account.ts`.

pub(crate) mod apply;
pub(crate) mod apply_result;
pub(crate) mod apply_types;
pub(crate) mod handlers;

use num_bigint::BigInt;

use crate::{HtlcLockTx, HtlcResolveTx, JEventClaimTx, TokenId};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingAction {
    Grant,
    Revoke,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReserveSide {
    Receiving,
    Counterparty,
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
    ReserveToCollateral {
        token_id: TokenId,
        collateral: String,
        ondelta: String,
        side: ReserveSide,
        block_number: i64,
        transaction_hash: String,
    },
    HtlcLock(HtlcLockTx),
    HtlcResolve(HtlcResolveTx),
}
