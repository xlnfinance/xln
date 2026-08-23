use num_bigint::BigInt;

use crate::{HtlcLockTx, HtlcResolveTx, TokenId};

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
    AddDelta {
        token_id: TokenId,
    },
    SetCreditLimit {
        token_id: TokenId,
        amount: BigInt,
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
