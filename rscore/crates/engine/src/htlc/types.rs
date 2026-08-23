use num_bigint::BigInt;

use crate::{HtlcHashlock, OpaqueHtlcCiphertext, Side, TokenId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HtlcDeliveryMode {
    Instant,
    Async,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcLockTx {
    pub lock_id: String,
    pub hashlock: HtlcHashlock,
    pub timelock: BigInt,
    pub reveal_before_height: u64,
    pub amount: BigInt,
    pub token_id: TokenId,
    pub delivery_mode: Option<HtlcDeliveryMode>,
    pub envelope: Option<OpaqueHtlcCiphertext>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HtlcResolveOutcome {
    Secret { secret: String },
    Error { reason: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcResolveTx {
    pub lock_id: String,
    pub outcome: HtlcResolveOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcLock {
    lock_id: String,
    hashlock: HtlcHashlock,
    timelock: BigInt,
    reveal_before_height: u64,
    amount: BigInt,
    token_id: TokenId,
    sender: Side,
    created_height: u64,
    created_timestamp: u64,
    envelope_hash: Option<[u8; 32]>,
}

impl HtlcLock {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        lock_id: String,
        hashlock: HtlcHashlock,
        timelock: BigInt,
        reveal_before_height: u64,
        amount: BigInt,
        token_id: TokenId,
        sender: Side,
        created_height: u64,
        created_timestamp: u64,
        envelope_hash: Option<[u8; 32]>,
    ) -> Self {
        Self {
            lock_id,
            hashlock,
            timelock,
            reveal_before_height,
            amount,
            token_id,
            sender,
            created_height,
            created_timestamp,
            envelope_hash,
        }
    }

    pub fn lock_id(&self) -> &str {
        &self.lock_id
    }
    pub const fn hashlock(&self) -> &HtlcHashlock {
        &self.hashlock
    }
    pub const fn timelock(&self) -> &BigInt {
        &self.timelock
    }
    pub const fn reveal_before_height(&self) -> u64 {
        self.reveal_before_height
    }
    pub const fn amount(&self) -> &BigInt {
        &self.amount
    }
    pub const fn token_id(&self) -> TokenId {
        self.token_id
    }
    pub const fn sender(&self) -> Side {
        self.sender
    }
    pub const fn created_height(&self) -> u64 {
        self.created_height
    }
    pub const fn created_timestamp(&self) -> u64 {
        self.created_timestamp
    }
    pub const fn envelope_hash(&self) -> Option<&[u8; 32]> {
        self.envelope_hash.as_ref()
    }
    pub fn envelope_hash_hex(&self) -> Option<String> {
        self.envelope_hash.as_ref().map(super::boundary::hex_32)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HtlcRejection {
    LockExists {
        lock_id: String,
    },
    TimelockExpired {
        timelock: BigInt,
    },
    RevealHeightPassed {
        reveal_before_height: u64,
        current_j_height: u64,
    },
    Amount {
        amount: BigInt,
        minimum: BigInt,
        maximum: BigInt,
    },
    InsufficientCapacity {
        required: BigInt,
        available: BigInt,
    },
    LockNotFound {
        lock_id: String,
    },
    DeltaNotFound {
        token_id: TokenId,
    },
    DeadlineExpired {
        timestamp: u64,
        timelock: BigInt,
        j_height: u64,
        reveal_before_height: u64,
    },
    InvalidSecret {
        message: String,
    },
    HashMismatch {
        expected: HtlcHashlock,
        actual: HtlcHashlock,
    },
    ActivePayerCancellation,
    TimeoutBeforeExpiry,
    HoldUnderflow {
        side: Side,
        hold: BigInt,
        amount: BigInt,
    },
}

impl HtlcRejection {
    pub fn message(&self) -> String {
        match self {
            Self::LockExists { lock_id } => format!("Lock {lock_id} already exists"),
            Self::TimelockExpired { timelock } => {
                format!("Timelock {timelock} already expired (timestamp)")
            }
            Self::RevealHeightPassed {
                reveal_before_height,
                current_j_height,
            } => format!(
                "revealBeforeHeight {reveal_before_height} already passed (current J height: {current_j_height})"
            ),
            Self::Amount {
                amount,
                minimum,
                maximum,
            } => {
                format!("Invalid amount: {amount} (min {minimum}, max {maximum})")
            }
            Self::InsufficientCapacity {
                required,
                available,
            } => {
                format!("Insufficient capacity: need {required}, available {available}")
            }
            Self::LockNotFound { lock_id } => format!("Lock {lock_id} not found"),
            Self::DeltaNotFound { token_id } => format!("Delta {token_id} not found"),
            Self::DeadlineExpired {
                timestamp,
                timelock,
                j_height,
                reveal_before_height,
            } => {
                format!(
                    "Lock expired: timestamp={timestamp}/{timelock} jHeight={j_height}/{reveal_before_height}"
                )
            }
            Self::InvalidSecret { message } => format!("Invalid secret: {message}"),
            Self::HashMismatch { expected, actual } => format!(
                "Hash mismatch: expected {}..., got {}...",
                &expected.as_str()[..8],
                &actual.as_str()[..8],
            ),
            Self::ActivePayerCancellation => {
                "Only beneficiary can release an active HTLC; payer can cancel only after expiry"
                    .into()
            }
            Self::TimeoutBeforeExpiry => "Lock not expired yet".into(),
            Self::HoldUnderflow { side, hold, amount } => format!(
                "HTLC_RESOLVE_HOLD_UNDERFLOW:{} hold={hold} amount={amount}",
                match side {
                    Side::Left => "left",
                    Side::Right => "right",
                },
            ),
        }
    }
}
