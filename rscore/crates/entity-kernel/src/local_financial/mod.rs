mod decode;
mod direct_payment;
mod htlc_payment;
mod swap_requests;
mod types;

use std::collections::BTreeMap;

use xln_rscore_engine::AccountTx;

use crate::{
    DeterministicContext, EntityFrameEvent, EntityKernelError, EntityKernelOutput, EntityStateSlice,
};

pub use decode::decode_local_entity_financial_tx;
pub(crate) use types::LocalAccountFinancialView;
pub use types::{
    DirectPaymentEntityTx, HtlcPaymentEntityTx, LocalEntityFinancialTx, PlaceSwapOfferEntityTx,
    ProposeCancelSwapEntityTx,
};

pub(crate) struct LocalFinancialResult {
    pub account_txs: Vec<(String, AccountTx)>,
    pub outputs: Vec<EntityKernelOutput>,
    pub events: Vec<EntityFrameEvent>,
    pub wake_targets: Vec<String>,
}

pub(crate) fn apply_local_entity_financial_txs(
    state: &mut EntityStateSlice,
    txs: Vec<LocalEntityFinancialTx>,
    context: &DeterministicContext,
    account_views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<LocalFinancialResult, EntityKernelError> {
    let mut account_txs = Vec::new();
    let mut outputs = Vec::new();
    let mut events = Vec::new();
    let mut wake_targets = Vec::new();
    for tx in txs {
        match tx {
            LocalEntityFinancialTx::DirectPayment(tx) => direct_payment::apply_direct_payment(
                state,
                tx,
                &mut account_txs,
                &mut events,
                &mut wake_targets,
            )?,
            LocalEntityFinancialTx::HtlcPayment(tx) => htlc_payment::apply_htlc_payment(
                state,
                tx,
                context,
                account_views,
                &mut account_txs,
                &mut outputs,
                &mut events,
            )?,
            LocalEntityFinancialTx::PlaceSwapOffer(tx) => {
                swap_requests::apply_place_swap_offer(
                    state,
                    tx,
                    &mut account_txs,
                    &mut wake_targets,
                )?;
            }
            LocalEntityFinancialTx::ProposeCancelSwap(tx) => {
                swap_requests::apply_cancel_swap(state, tx, &mut account_txs, &mut wake_targets)?;
            }
        }
    }
    // Output routing keeps exactly one trigger-only self-wake per target
    // before anything durable exists (TS merges identically before its
    // Runtime FIFO), so pre-merge multiplicity is unobservable. Collapse it
    // here instead of allocating and encoding one wake object per payment.
    let mut seen_wake_targets = std::collections::BTreeSet::new();
    wake_targets.retain(|target| seen_wake_targets.insert(target.clone()));
    Ok(LocalFinancialResult {
        account_txs,
        outputs,
        events,
        wake_targets,
    })
}
