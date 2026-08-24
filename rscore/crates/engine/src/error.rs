use num_bigint::BigInt;
use thiserror::Error;

use crate::{HtlcBoundaryError, HtlcRejection, Side, TokenId};

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum StateError {
    #[error("ACCOUNT_ENTITY_ID_INVALID:{0}")]
    InvalidEntityId(String),
    #[error("ACCOUNT_DEPOSITORY_ADDRESS_INVALID:{0}")]
    InvalidDepositoryAddress(String),
    #[error("ACCOUNT_WATCH_SEED_INVALID:{0}")]
    InvalidWatchSeed(String),
    #[error("ACCOUNT_CHAIN_ID_INVALID:{0}")]
    InvalidChainId(u64),
    #[error("ACCOUNT_PARTIES_NON_CANONICAL:left={left}:right={right}")]
    NonCanonicalAccountParties { left: String, right: String },
    #[error("ACCOUNT_REPLICA_OWNER_INVALID:{0}")]
    InvalidReplicaOwner(String),
    #[error("ACCOUNT_DELTA_DUPLICATE_TOKEN:{0}")]
    DuplicateToken(TokenId),
    #[error("ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:{context}:{attempted}:{maximum}")]
    DeltaRowLimitExceeded {
        context: &'static str,
        attempted: usize,
        maximum: usize,
    },
    #[error("ACCOUNT_DELTA_FIELD_OUT_OF_RANGE:{field}:{value}")]
    DeltaFieldOutOfRange { field: &'static str, value: BigInt },
    #[error("ACCOUNT_STATE_PERSISTENT_MAP:{0}")]
    PersistentMap(String),
    #[error("ACCOUNT_STATE_LEAF_TOO_LARGE:{actual}:{maximum}")]
    AccountStateLeafTooLarge { actual: usize, maximum: usize },
    #[error("ACCOUNT_DISPUTE_{side}_RESPONSE_SECONDS_INVALID:{value}")]
    InvalidDisputeResponseSeconds { side: &'static str, value: u64 },
    #[error("ACCOUNT_DISPUTE_RESPONSE_TOTAL_EXCEEDED:{0}")]
    DisputeResponseTotalExceeded(u64),
    #[error("ACCOUNT_HTLC_RESTORE_INVALID:{field}:{value}")]
    InvalidHtlcRestore { field: &'static str, value: String },
    #[error("ACCOUNT_HTLC_RESTORE_DUPLICATE:{0}")]
    DuplicateHtlcLock(String),
    #[error("ACCOUNT_HTLC_RESTORE_LIMIT_EXCEEDED:{actual}:{maximum}")]
    HtlcRestoreLimitExceeded { actual: usize, maximum: usize },
    #[error("ACCOUNT_STATE_ROOT:{0}")]
    AccountStateRoot(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationRejection {
    CreditLimitNegative {
        amount: BigInt,
    },
    CreditLimitAboveMaximum {
        amount: BigInt,
        maximum: BigInt,
    },
    PaymentAmount {
        amount: BigInt,
        minimum: BigInt,
        maximum: BigInt,
    },
    RouteLength {
        length: usize,
        maximum: usize,
    },
    DirectGatewayForbidden,
    TrustedGatewayRequired,
    PaymentDirection,
    DirectRoute,
    TrustedRoute,
    InsufficientCapacity {
        payer_suffix: String,
        required: BigInt,
        available: BigInt,
    },
    ReserveToCollateralBlocked,
    RebalancePolicyTokenId {
        token_id: u32,
    },
    RebalancePolicyVersion {
        version: u64,
    },
    RebalancePolicyTimestamp,
    RebalancePolicyFeeTerms {
        token_id: u32,
    },
    RebalancePolicyMissingDelta {
        token_id: u32,
    },
    RebalancePolicyEquivocation {
        side: Side,
        token_id: u32,
        version: u64,
    },
    SwapOfferId {
        offer_id: String,
    },
    SwapOfferExists {
        offer_id: String,
    },
    SwapOfferLimit {
        maximum: usize,
    },
    SwapOfferMarketLimit {
        market: String,
        maximum: usize,
    },
    SwapOfferDecimals,
    SwapOfferAmount,
    SwapOfferSameToken {
        token_id: u32,
    },
    SwapOfferTimeInForce,
    SwapOfferQuantization {
        offer_id: String,
    },
    SwapOfferNotFound {
        offer_id: String,
    },
    SwapCancelNotMaker,
    /// One of the swap_resolve checks; the code names the TypeScript check.
    SwapResolve {
        code: &'static str,
    },
    SwapNetAuthorization {
        code: &'static str,
    },
    Htlc(HtlcRejection),
}

impl ValidationRejection {
    pub fn message(&self) -> String {
        match self {
            Self::CreditLimitNegative { amount } => format!("Credit limit cannot be negative: {amount}"),
            Self::CreditLimitAboveMaximum { amount, maximum } => {
                format!("Credit limit exceeds maximum: {amount} > {maximum}")
            }
            Self::PaymentAmount { amount, minimum, maximum } => {
                format!("Invalid payment amount: {amount} (min {minimum}, max {maximum})")
            }
            Self::RouteLength { length, maximum } => {
                format!("Route too long: {length} hops (max {maximum})")
            }
            Self::DirectGatewayForbidden => "Direct payment forbids a trusted gateway".into(),
            Self::TrustedGatewayRequired => "Trusted payment requires one declared gateway".into(),
            Self::PaymentDirection => "FATAL: Payment direction must match the frame proposer".into(),
            Self::DirectRoute => "Direct payment route must contain only the bilateral recipient".into(),
            Self::TrustedRoute => "Trusted payment must be source → declared gateway → recipient".into(),
            Self::InsufficientCapacity { payer_suffix, required, available } => format!(
                "Insufficient capacity for sender {payer_suffix}: need {required}, available {available}"
            ),
            Self::ReserveToCollateralBlocked => {
                "SECURITY: reserve_to_collateral blocked - must use j_event_claim bilateral consensus".into()
            }
            Self::RebalancePolicyTokenId { token_id } => {
                format!("rebalance_policy: invalid tokenId {token_id}")
            }
            Self::RebalancePolicyVersion { version } => {
                format!("rebalance_policy: invalid policyVersion {version}")
            }
            Self::RebalancePolicyTimestamp => {
                "rebalance_policy: invalid committed timestamp".into()
            }
            Self::RebalancePolicyFeeTerms { token_id } => {
                format!("rebalance_policy: invalid fee terms for token {token_id}")
            }
            Self::RebalancePolicyMissingDelta { token_id } => {
                format!("rebalance_policy: no delta for token {token_id}")
            }
            Self::RebalancePolicyEquivocation { side, token_id, version } => {
                let side = if *side == Side::Left { "left" } else { "right" };
                format!("REBALANCE_POLICY_EQUIVOCATION: side={side} token={token_id} version={version}")
            }
            Self::SwapOfferId { offer_id } => {
                format!("Invalid offerId: colons not allowed (got {offer_id})")
            }
            Self::SwapOfferExists { offer_id } => format!("Offer {offer_id} already exists"),
            Self::SwapOfferLimit { maximum } => {
                format!("Too many open swap offers: max {maximum}")
            }
            Self::SwapOfferMarketLimit { market, maximum } => {
                format!("Too many open swap offers for {market}: max {maximum}")
            }
            Self::SwapOfferDecimals => "Invalid token decimals".into(),
            Self::SwapOfferAmount => "Invalid swap amount".into(),
            Self::SwapOfferSameToken { token_id } => format!("Cannot swap same token: {token_id}"),
            Self::SwapOfferTimeInForce => "Invalid timeInForce".into(),
            Self::SwapOfferQuantization { offer_id } => format!(
                "Invalid price ratio or order too small after canonical quantization: {offer_id}"
            ),
            Self::SwapOfferNotFound { offer_id } => format!("Offer {offer_id} not found"),
            Self::SwapCancelNotMaker => "Only maker can cancel swap offer".into(),
            Self::SwapResolve { code } => (*code).to_owned(),
            Self::SwapNetAuthorization { code } => (*code).to_owned(),
            Self::Htlc(reason) => reason.message(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountRejection {
    Validation(ValidationRejection),
    DeltaRowLimitExceeded { attempted: usize, maximum: usize },
    HtlcLockCapacity { maximum: usize },
}

impl AccountRejection {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "ACCOUNT_TX_VALIDATION",
            Self::DeltaRowLimitExceeded { .. } => "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED",
            Self::HtlcLockCapacity { .. } => "ACCOUNT_HTLC_LOCK_CAPACITY",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Validation(reason) => reason.message(),
            Self::DeltaRowLimitExceeded { attempted, maximum } => {
                format!("ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:{attempted}:{maximum}")
            }
            Self::HtlcLockCapacity { maximum } => {
                format!("Too many active HTLC locks: max {maximum}")
            }
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error(transparent)]
    InvalidState(#[from] StateError),
    #[error(transparent)]
    HtlcBoundary(#[from] HtlcBoundaryError),
    #[error("SWAP_MARKET_POLICY_MISSING")]
    SwapMarketPolicyMissing,
    #[error("TRUSTED_PAYMENT_FORWARD_CONTEXT_MISSING")]
    TrustedPaymentForwardContextMissing,
    #[error("TRUSTED_PAYMENT_FORWARD_GATEWAY_MISMATCH")]
    TrustedPaymentForwardGatewayMismatch,
    #[error("TRUSTED_PAYMENT_FORWARD_LOOP")]
    TrustedPaymentForwardLoop,
    #[error("LENDING_{role}_INVALID:{claimed}")]
    LendingRoleInvalid { role: &'static str, claimed: String },
    #[error("LENDING_{role}_NOT_PROPOSER: claimed={claimed} proposer={proposer}")]
    LendingRoleNotProposer {
        role: &'static str,
        claimed: String,
        proposer: String,
    },
    #[error("LENDING_COUNTERPARTY_INVALID: expected={expected} got={actual}")]
    LendingCounterpartyInvalid { expected: String, actual: String },
    #[error("LENDING_INTENT_ID_INVALID:{0}")]
    LendingIntentIdInvalid(String),
    #[error("LENDING_INTENT_REPLAY:{0}")]
    LendingIntentReplay(String),
    #[error("{context}_AMOUNT_MUST_BE_POSITIVE")]
    LendingAmountNotPositive { context: &'static str },
    #[error("LENDING_INVALID_INTEREST_BPS: {0}")]
    LendingInterestBpsInvalid(i64),
    #[error("LENDING_CREDIT_LIMIT_NEGATIVE:{0}")]
    LendingCreditLimitNegative(BigInt),
    #[error("ACCOUNT_TX_ROUTE_MISMATCH:lending")]
    LendingRouteMismatch,
    #[error("ACCOUNT_EXECUTION_CONTEXT_REQUIRED:{0}")]
    ExecutionContextRequired(&'static str),
    #[error("ACCOUNT_EXECUTION_CONTEXT_OUT_OF_RANGE:{field}:{value}")]
    ExecutionContextOutOfRange { field: &'static str, value: u64 },
}
