use num_bigint::BigInt;
use thiserror::Error;

use crate::TokenId;

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
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountRejection {
    Validation(ValidationRejection),
    DeltaRowLimitExceeded { attempted: usize, maximum: usize },
}

impl AccountRejection {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "ACCOUNT_TX_VALIDATION",
            Self::DeltaRowLimitExceeded { .. } => "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Validation(reason) => reason.message(),
            Self::DeltaRowLimitExceeded { attempted, maximum } => {
                format!("ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:{attempted}:{maximum}")
            }
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error(transparent)]
    InvalidState(#[from] StateError),
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
}
