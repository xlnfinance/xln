mod followups;
mod history;
mod ingress;
mod types;

use xln_rscore_engine::AccountTx;

pub(crate) use followups::apply_committed_j_event_claim;
pub use history::{
    CanonicalJEventBlock, EMPTY_J_HISTORY_ROOT, canonical_j_event_blocks,
    canonical_j_event_range_hash, fold_j_history_root, j_event_range_digest,
};
pub use ingress::apply_finalized_j_event_batches;
pub use types::{
    EntityJEventIngress, FinalizedJEventBatch, JClaimIngress, JEventClaimQueued, JReserveUpdate,
};

pub(crate) fn account_tx_kind(tx: &AccountTx) -> &'static str {
    match tx {
        AccountTx::AddDelta { .. } => "add_delta",
        AccountTx::SetCreditLimit { .. } => "set_credit_limit",
        AccountTx::RebalancePolicy { .. } => "rebalance_policy",
        AccountTx::LendingFund { .. } => "lending_fund",
        AccountTx::LendingBorrowRequest { .. } => "lending_borrow_request",
        AccountTx::LendingRepay { .. } => "lending_repay",
        AccountTx::LendingCredit { .. } => "lending_credit",
        AccountTx::LendingCloseRequest { .. } => "lending_close_request",
        AccountTx::LendingClosePayout { .. } => "lending_close_payout",
        AccountTx::ReserveToCollateral { .. } => "reserve_to_collateral",
        AccountTx::SwapOffer { .. } => "swap_offer",
        AccountTx::SwapResolve { .. } => "swap_resolve",
        AccountTx::SwapCancelRequest { .. } => "swap_cancel_request",
        AccountTx::DirectPayment { .. } => "direct_payment",
        AccountTx::HtlcLock(_) => "htlc_lock",
        AccountTx::HtlcResolve(_) => "htlc_resolve",
        AccountTx::JEventClaim(_) => "j_event_claim",
    }
}
