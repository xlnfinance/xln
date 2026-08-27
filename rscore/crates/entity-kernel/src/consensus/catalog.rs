//! Closed Entity transaction catalog for the native single-Entity Runtime.
//!
//! Keep this list byte-for-byte parallel with
//! `core/entity/tx/processing/catalog.ts`.  Recognition and native support are
//! deliberately separate: a known transaction outside the RRS milestone is a
//! typed rejection, never an "unknown" value and never a TypeScript fallback.

use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityTxKind {
    AccountInput,
    AdmitCrossJurisdictionBookOrder,
    ApplyCrossJurisdictionBookProgress,
    BoardHandover,
    Chat,
    ChatMessage,
    CrossJurisdictionBookOrderRemoved,
    CrossJurisdictionFillNotice,
    CrossJurisdictionForceSiblingDispute,
    CrossJurisdictionSalvage,
    CrossPullClose,
    DirectPayment,
    DisputeFinalize,
    DisputeStart,
    E2r,
    EntityCommand,
    EntityProviderActivateBoard,
    EntityProviderCancelAction,
    EntityProviderProposeControlBoard,
    EntityProviderReleaseControlShares,
    EntityProviderTransfer,
    ExtendCredit,
    HtlcPayment,
    InitOrderbookExt,
    JAbortSentBatch,
    JBroadcast,
    JClearBatch,
    JEvent,
    JRebroadcast,
    LendingBorrow,
    LendingClosePosition,
    LendingOffer,
    LendingRepay,
    MaterializeCrossJurisdictionClear,
    MaterializeCrossJurisdictionSwap,
    MintReserves,
    OpenAccount,
    OrderbookSweepCrossJurisdiction,
    PlaceSwapOffer,
    PrepareCrossJurisdictionSwap,
    PrepareDispute,
    ProcessHtlcTimeouts,
    ProfileUpdate,
    Propose,
    ProposeCancelSwap,
    R2c,
    R2e,
    R2r,
    RegisterCrossJurisdictionSwap,
    RemoveCrossJurisdictionBookOrder,
    RequestCollateral,
    RequestCrossJurisdictionClear,
    ResolveHtlcLock,
    RuntimeOutput,
    ScheduledWake,
    SetHubConfig,
    SetRebalancePolicy,
    SettleApprove,
    SettleExecute,
    SettlePropose,
    SettleReject,
    SettleUpdate,
    Vote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityTxSupport {
    /// Included in the RRS pay, HTLC, same-J swap and finalized-J-event slice.
    NativeMvp,
    /// Recognized protocol bytes that are explicitly outside this milestone.
    Excluded,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum EntityTxCatalogError {
    #[error("ENTITY_TX_TYPE_UNKNOWN:{0}")]
    Unknown(String),
    #[error("ENTITY_TX_NATIVE_UNSUPPORTED:{0}")]
    Unsupported(&'static str),
}

impl EntityTxKind {
    pub fn parse(value: &str) -> Result<Self, EntityTxCatalogError> {
        let kind = match value {
            "accountInput" => Self::AccountInput,
            "admitCrossJurisdictionBookOrder" => Self::AdmitCrossJurisdictionBookOrder,
            "applyCrossJurisdictionBookProgress" => Self::ApplyCrossJurisdictionBookProgress,
            "boardHandover" => Self::BoardHandover,
            "chat" => Self::Chat,
            "chatMessage" => Self::ChatMessage,
            "crossJurisdictionBookOrderRemoved" => Self::CrossJurisdictionBookOrderRemoved,
            "crossJurisdictionFillNotice" => Self::CrossJurisdictionFillNotice,
            "crossJurisdictionForceSiblingDispute" => Self::CrossJurisdictionForceSiblingDispute,
            "crossJurisdictionSalvage" => Self::CrossJurisdictionSalvage,
            "crossPullClose" => Self::CrossPullClose,
            "directPayment" => Self::DirectPayment,
            "disputeFinalize" => Self::DisputeFinalize,
            "disputeStart" => Self::DisputeStart,
            "e2r" => Self::E2r,
            "entityCommand" => Self::EntityCommand,
            "entityProviderActivateBoard" => Self::EntityProviderActivateBoard,
            "entityProviderCancelAction" => Self::EntityProviderCancelAction,
            "entityProviderProposeControlBoard" => Self::EntityProviderProposeControlBoard,
            "entityProviderReleaseControlShares" => Self::EntityProviderReleaseControlShares,
            "entityProviderTransfer" => Self::EntityProviderTransfer,
            "extendCredit" => Self::ExtendCredit,
            "htlcPayment" => Self::HtlcPayment,
            "initOrderbookExt" => Self::InitOrderbookExt,
            "j_abort_sent_batch" => Self::JAbortSentBatch,
            "j_broadcast" => Self::JBroadcast,
            "j_clear_batch" => Self::JClearBatch,
            "j_event" => Self::JEvent,
            "j_rebroadcast" => Self::JRebroadcast,
            "lendingBorrow" => Self::LendingBorrow,
            "lendingClosePosition" => Self::LendingClosePosition,
            "lendingOffer" => Self::LendingOffer,
            "lendingRepay" => Self::LendingRepay,
            "materializeCrossJurisdictionClear" => Self::MaterializeCrossJurisdictionClear,
            "materializeCrossJurisdictionSwap" => Self::MaterializeCrossJurisdictionSwap,
            "mintReserves" => Self::MintReserves,
            "openAccount" => Self::OpenAccount,
            "orderbookSweepCrossJurisdiction" => Self::OrderbookSweepCrossJurisdiction,
            "placeSwapOffer" => Self::PlaceSwapOffer,
            "prepareCrossJurisdictionSwap" => Self::PrepareCrossJurisdictionSwap,
            "prepareDispute" => Self::PrepareDispute,
            "processHtlcTimeouts" => Self::ProcessHtlcTimeouts,
            "profile-update" => Self::ProfileUpdate,
            "propose" => Self::Propose,
            "proposeCancelSwap" => Self::ProposeCancelSwap,
            "r2c" => Self::R2c,
            "r2e" => Self::R2e,
            "r2r" => Self::R2r,
            "registerCrossJurisdictionSwap" => Self::RegisterCrossJurisdictionSwap,
            "removeCrossJurisdictionBookOrder" => Self::RemoveCrossJurisdictionBookOrder,
            "requestCollateral" => Self::RequestCollateral,
            "requestCrossJurisdictionClear" => Self::RequestCrossJurisdictionClear,
            "resolveHtlcLock" => Self::ResolveHtlcLock,
            "runtimeOutput" => Self::RuntimeOutput,
            "scheduledWake" => Self::ScheduledWake,
            "setHubConfig" => Self::SetHubConfig,
            "setRebalancePolicy" => Self::SetRebalancePolicy,
            "settle_approve" => Self::SettleApprove,
            "settle_execute" => Self::SettleExecute,
            "settle_propose" => Self::SettlePropose,
            "settle_reject" => Self::SettleReject,
            "settle_update" => Self::SettleUpdate,
            "vote" => Self::Vote,
            other => return Err(EntityTxCatalogError::Unknown(other.to_string())),
        };
        Ok(kind)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AccountInput => "accountInput",
            Self::AdmitCrossJurisdictionBookOrder => "admitCrossJurisdictionBookOrder",
            Self::ApplyCrossJurisdictionBookProgress => "applyCrossJurisdictionBookProgress",
            Self::BoardHandover => "boardHandover",
            Self::Chat => "chat",
            Self::ChatMessage => "chatMessage",
            Self::CrossJurisdictionBookOrderRemoved => "crossJurisdictionBookOrderRemoved",
            Self::CrossJurisdictionFillNotice => "crossJurisdictionFillNotice",
            Self::CrossJurisdictionForceSiblingDispute => "crossJurisdictionForceSiblingDispute",
            Self::CrossJurisdictionSalvage => "crossJurisdictionSalvage",
            Self::CrossPullClose => "crossPullClose",
            Self::DirectPayment => "directPayment",
            Self::DisputeFinalize => "disputeFinalize",
            Self::DisputeStart => "disputeStart",
            Self::E2r => "e2r",
            Self::EntityCommand => "entityCommand",
            Self::EntityProviderActivateBoard => "entityProviderActivateBoard",
            Self::EntityProviderCancelAction => "entityProviderCancelAction",
            Self::EntityProviderProposeControlBoard => "entityProviderProposeControlBoard",
            Self::EntityProviderReleaseControlShares => "entityProviderReleaseControlShares",
            Self::EntityProviderTransfer => "entityProviderTransfer",
            Self::ExtendCredit => "extendCredit",
            Self::HtlcPayment => "htlcPayment",
            Self::InitOrderbookExt => "initOrderbookExt",
            Self::JAbortSentBatch => "j_abort_sent_batch",
            Self::JBroadcast => "j_broadcast",
            Self::JClearBatch => "j_clear_batch",
            Self::JEvent => "j_event",
            Self::JRebroadcast => "j_rebroadcast",
            Self::LendingBorrow => "lendingBorrow",
            Self::LendingClosePosition => "lendingClosePosition",
            Self::LendingOffer => "lendingOffer",
            Self::LendingRepay => "lendingRepay",
            Self::MaterializeCrossJurisdictionClear => "materializeCrossJurisdictionClear",
            Self::MaterializeCrossJurisdictionSwap => "materializeCrossJurisdictionSwap",
            Self::MintReserves => "mintReserves",
            Self::OpenAccount => "openAccount",
            Self::OrderbookSweepCrossJurisdiction => "orderbookSweepCrossJurisdiction",
            Self::PlaceSwapOffer => "placeSwapOffer",
            Self::PrepareCrossJurisdictionSwap => "prepareCrossJurisdictionSwap",
            Self::PrepareDispute => "prepareDispute",
            Self::ProcessHtlcTimeouts => "processHtlcTimeouts",
            Self::ProfileUpdate => "profile-update",
            Self::Propose => "propose",
            Self::ProposeCancelSwap => "proposeCancelSwap",
            Self::R2c => "r2c",
            Self::R2e => "r2e",
            Self::R2r => "r2r",
            Self::RegisterCrossJurisdictionSwap => "registerCrossJurisdictionSwap",
            Self::RemoveCrossJurisdictionBookOrder => "removeCrossJurisdictionBookOrder",
            Self::RequestCollateral => "requestCollateral",
            Self::RequestCrossJurisdictionClear => "requestCrossJurisdictionClear",
            Self::ResolveHtlcLock => "resolveHtlcLock",
            Self::RuntimeOutput => "runtimeOutput",
            Self::ScheduledWake => "scheduledWake",
            Self::SetHubConfig => "setHubConfig",
            Self::SetRebalancePolicy => "setRebalancePolicy",
            Self::SettleApprove => "settle_approve",
            Self::SettleExecute => "settle_execute",
            Self::SettlePropose => "settle_propose",
            Self::SettleReject => "settle_reject",
            Self::SettleUpdate => "settle_update",
            Self::Vote => "vote",
        }
    }

    pub const fn support(self) -> EntityTxSupport {
        match self {
            Self::AccountInput
            | Self::DirectPayment
            | Self::EntityCommand
            | Self::ExtendCredit
            | Self::HtlcPayment
            | Self::InitOrderbookExt
            | Self::JEvent
            | Self::OpenAccount
            | Self::PlaceSwapOffer
            | Self::ProcessHtlcTimeouts
            | Self::ProposeCancelSwap
            | Self::RequestCollateral
            | Self::ResolveHtlcLock
            | Self::ScheduledWake
            | Self::SetHubConfig
            | Self::SetRebalancePolicy => EntityTxSupport::NativeMvp,
            _ => EntityTxSupport::Excluded,
        }
    }

    pub fn require_native_mvp(self) -> Result<Self, EntityTxCatalogError> {
        match self.support() {
            EntityTxSupport::NativeMvp => Ok(self),
            EntityTxSupport::Excluded => Err(EntityTxCatalogError::Unsupported(self.as_str())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_round_trips_and_exclusions_are_loud() {
        let kinds = [
            "accountInput",
            "directPayment",
            "htlcPayment",
            "j_event",
            "placeSwapOffer",
            "crossPullClose",
            "disputeStart",
            "lendingBorrow",
        ];
        for text in kinds {
            assert_eq!(EntityTxKind::parse(text).expect("known").as_str(), text);
        }
        assert!(EntityTxKind::DirectPayment.require_native_mvp().is_ok());
        assert_eq!(
            EntityTxKind::CrossPullClose.require_native_mvp(),
            Err(EntityTxCatalogError::Unsupported("crossPullClose")),
        );
        assert!(matches!(
            EntityTxKind::parse("newUnreviewedTx"),
            Err(EntityTxCatalogError::Unknown(value)) if value == "newUnreviewedTx"
        ));
    }
}
