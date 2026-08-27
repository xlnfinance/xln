use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum EntityKernelError {
    #[error("ENTITY_KERNEL_CROSS_J_UNSUPPORTED:{account_id}")]
    CrossJurisdictionUnsupported { account_id: String },
    #[error("ENTITY_KERNEL_TX_UNSUPPORTED:{kind}")]
    UnsupportedAccountTx { kind: &'static str },
    #[error("ENTITY_J_EVENT_INGRESS_TX_UNSUPPORTED:{kind}")]
    UnsupportedJEventIngress { kind: &'static str },
    #[error("ENTITY_J_EVENT_INVALID:{detail}")]
    JEventInvalid { detail: String },
    #[error("ENTITY_LOCAL_TX_INVALID:{kind}:{detail}")]
    InvalidLocalEntityTx { kind: &'static str, detail: String },
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
    #[error("CRONTAB_HUB_REBALANCE_HANDLER_MISSING")]
    HubRebalanceHandlerMissing,
}

impl EntityKernelError {
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
}
