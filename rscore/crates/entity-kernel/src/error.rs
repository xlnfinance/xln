use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum EntityKernelError {
    #[error("ENTITY_BOARD_HANDOVER_INVALID:{detail}")]
    BoardHandoverInvalid { detail: String },
    #[error("ENTITY_KERNEL_CROSS_J_UNSUPPORTED:{account_id}")]
    CrossJurisdictionUnsupported { account_id: String },
    #[error("ENTITY_J_EVENT_INGRESS_TX_UNSUPPORTED:{kind}")]
    UnsupportedJEventIngress { kind: &'static str },
    #[error("ENTITY_J_EVENT_INVALID:{detail}")]
    JEventInvalid { detail: String },
    #[error("ENTITY_LOCAL_TX_INVALID:{kind}:{detail}")]
    InvalidLocalEntityTx { kind: &'static str, detail: String },
    /// A user/peer-authored tx that is invalid against its own data or
    /// committed state. Never a runtime fault: the kernel logs it and returns
    /// it as a typed reject, the resident round maps it to
    /// `ResidentEntityError::LocalCommandRejected`, and the Runtime loop
    /// evicts exactly that command and retries the round (TS
    /// `buildEntityProposalEvictingRejected`). No kernel decision reads
    /// process env. Handlers return it before any mutation.
    #[error("ENTITY_TX_REJECTED:{kind}:{detail}")]
    RejectedEntityTx { kind: &'static str, detail: String },
    #[error("ENTITY_KERNEL_OUTPUT_MISMATCH:{detail}")]
    AccountOutputMismatch { detail: String },
    #[error("ENTITY_KERNEL_ACCOUNT_MISSING:{account_id}")]
    AccountMissing { account_id: String },
    #[error("ENTITY_KERNEL_PREPARED_HTLC_MISSING:{account_id}:{lock_id}")]
    PreparedHtlcMissing { account_id: String, lock_id: String },
    #[error("ENTITY_KERNEL_PREPARED_HTLC_MISMATCH:{detail}")]
    PreparedHtlcMismatch { detail: String },
    #[error("ENTITY_KERNEL_HTLC_INVARIANT:{detail}")]
    HtlcInvariant { detail: String },
    #[error("ENTITY_KERNEL_ORDERBOOK_INVARIANT:{detail}")]
    OrderbookInvariant { detail: String },
    #[error("ENTITY_KERNEL_LENDING_INVARIANT:{detail}")]
    LendingInvariant { detail: String },
    #[error("ENTITY_KERNEL_SWAP_REJECTED:{code}")]
    SwapRejected { code: &'static str },
    #[error("ENTITY_KERNEL_TIF_UNSUPPORTED:{value}")]
    UnsupportedTimeInForce { value: u8 },
    #[error("ENTITY_KERNEL_COMMITMENT_UNSAFE_NUMBER:{field}:{value}")]
    CommitmentUnsafeNumber { field: &'static str, value: u64 },
    #[error("ENTITY_KERNEL_COMMITMENT_ENCODING:{detail}")]
    CommitmentEncoding { detail: String },
    #[error("ENTITY_KERNEL_SNAPSHOT_INVALID:{detail}")]
    SnapshotInvalid { detail: String },
    #[error("ENTITY_KERNEL_HUB_REBALANCE_CONFIG_INVALID:{detail}")]
    HubRebalanceConfigInvalid { detail: String },
    #[error("CRONTAB_HUB_REBALANCE_HANDLER_MISSING")]
    HubRebalanceHandlerMissing,
}

/// Owner canon 2026-09-05, mirrored in TS `rejectFailFast`: a rejected
/// inbound AccountInput halts by default (tests/dev) and is only logged+dropped in
/// production. `XLN_REJECT_FAIL_FAST=0|false|off` forces log-and-drop, `=1`
/// forces fail-fast; otherwise `NODE_ENV=production` means log-and-drop.
///
/// This is Runtime-loop policy only. No RJEA transition inside this crate
/// consults it: the kernel always returns the typed reject (local tx) or
/// records it on the round result (inbound Account input), and the Runtime
/// applies halt-vs-drop exactly once, outside the state machine, so replay
/// never depends on process env.
pub fn reject_fail_fast() -> bool {
    static POLICY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *POLICY.get_or_init(|| {
        if let Ok(raw) = std::env::var("XLN_REJECT_FAIL_FAST")
            && !raw.trim().is_empty()
        {
            return !matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            );
        }
        std::env::var("NODE_ENV")
            .map(|value| value != "production")
            .unwrap_or(true)
    })
}

/// Handler-level validation of a user-authored local Entity tx: the sender's
/// own fields, or the sender's request against committed state where the
/// committed side cannot itself be a kernel invariant. Everything else under
/// `InvalidLocalEntityTx` (missing Runtime/proposer context, canonical
/// encoding, corrupt committed evidence, scheduler/J-batch state) stays a
/// fatal kernel fault.
///
/// Mirrors the TS handler dispositions: `directPayment` is `rejectFailure`
/// in `core/entity/tx/handlers/payments/direct-payment.ts`; the raw htlc
/// payment / resolve / openAccount / profile / governance checks below are
/// what TS rejects at mempool admission before its reducer runs.
fn user_validation_reject(kind: &str, detail: &str) -> bool {
    match kind {
        // These amounts come directly from the sender's unsigned proposal,
        // before any workspace mutation; invalid money cannot halt the hub.
        "settle_propose" | "settle_update" => {
            detail.starts_with("SETTLEMENT_WORKSPACE_AMOUNT_INVALID:index=")
                || detail.starts_with("SETTLEMENT_TOKEN_INVALID:workspace-op=")
                || detail == "SETTLEMENT_WORKSPACE_OPS_EMPTY"
        }
        "directPayment" => true,
        // TS WAL records only accepted origins. The rejected raw command is
        // still replayed from Runtime input, so absence of its individual
        // origin rejects that command; a present mismatching origin is fatal.
        "htlcPayment" => {
            detail.starts_with("HTLC_PAYMENT_PREPARED_CONTEXT_REQUIRED:")
                || !detail.starts_with("HTLC_PAYMENT_PREPARED_CONTEXT_")
        }
        "resolveHtlcLock" => matches!(
            detail,
            "SECRET_BYTES32" | "HTLC_RESOLVE_LOCK_MISSING" | "HTLC_RESOLVE_HASHLOCK_MISMATCH"
        ),
        "openAccount" => {
            matches!(
                detail,
                "OPEN_ACCOUNT_DOMAIN_MISMATCH" | "TARGET_ENTITY_ID" | "ACCOUNT_PARTIES_INVALID"
            ) || detail.starts_with("OPEN_ACCOUNT_ALREADY_EXISTS:")
                || detail.starts_with("REBALANCE_POLICY_TOKEN_MISSING:")
        }
        "profile-update" => {
            detail == "ENTITY_SECTORS_NONCANONICAL"
                || detail.starts_with("INVALID_ENTITY:")
                || detail.starts_with("ENTITY_KIND_INVALID:")
        }
        "proposal" => {
            detail.starts_with("ENTITY_PROPOSAL_PROPOSER_UNKNOWN:")
                || detail.starts_with("ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED:")
                || detail.starts_with("ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT:")
                || detail.starts_with("ENTITY_PROPOSAL_DUPLICATE:")
        }
        "vote" => {
            detail.starts_with("ENTITY_PROPOSAL_VOTER_UNKNOWN:")
                || detail.starts_with("ENTITY_PROPOSAL_VOTE_TARGET_MISSING:")
                || detail.starts_with("ENTITY_PROPOSAL_BOARD_MISMATCH:")
                || detail.starts_with("ENTITY_PROPOSAL_EPOCH_MISMATCH:")
                || detail.starts_with("ENTITY_PROPOSAL_DUPLICATE_VOTE:")
        }
        "r2r" | "r2e" | "r2c" => matches!(
            detail,
            "TOKEN_OR_AMOUNT_INVALID"
                | "INSUFFICIENT_RESERVE"
                | "ACCOUNT_PARTIES_INVALID"
                | "AMOUNT_OVERFLOW"
        ),
        _ => false,
    }
}

impl EntityKernelError {
    /// Owner canon: a user can never take the Runtime down. Re-class the
    /// handler-level validation failures of a user-authored Financial/Control
    /// tx (`user_validation_reject`) as the typed reject disposition; every
    /// other error is returned unchanged and stays fatal.
    pub fn into_user_reject(self) -> Self {
        match self {
            Self::InvalidLocalEntityTx { kind, detail }
                if user_validation_reject(kind, &detail) =>
            {
                Self::RejectedEntityTx { kind, detail }
            }
            other => other,
        }
    }

    pub(crate) fn rejected(kind: &'static str, detail: impl Into<String>) -> Self {
        Self::RejectedEntityTx {
            kind,
            detail: detail.into(),
        }
    }

    pub(crate) fn local(kind: &'static str, detail: impl Into<String>) -> Self {
        Self::InvalidLocalEntityTx {
            kind,
            detail: detail.into(),
        }
    }

    pub(crate) fn output(detail: impl Into<String>) -> Self {
        Self::AccountOutputMismatch {
            detail: detail.into(),
        }
    }

    pub(crate) fn orderbook(detail: impl Into<String>) -> Self {
        Self::OrderbookInvariant {
            detail: detail.into(),
        }
    }

    pub(crate) fn htlc(detail: impl Into<String>) -> Self {
        Self::HtlcInvariant {
            detail: detail.into(),
        }
    }

    pub(crate) fn lending(detail: impl Into<String>) -> Self {
        Self::LendingInvariant {
            detail: detail.into(),
        }
    }
}
