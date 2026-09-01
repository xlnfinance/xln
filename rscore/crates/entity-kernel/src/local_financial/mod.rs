mod decode;
#[path = "payments/direct_payment.rs"]
mod direct_payment;
mod dispute;
mod extend_credit;
#[path = "payments/htlc_payment.rs"]
mod htlc_payment;
mod lending;
mod open_account;
#[path = "payments/quote_r2c.rs"]
mod quote_r2c;
mod request_collateral;
#[path = "payments/resolve_htlc.rs"]
mod resolve_htlc;
mod settlement;
mod swap_requests;
mod types;

use std::collections::BTreeMap;

use xln_rscore_engine::AccountTx;

use crate::paybook::PaybookChanges;
use crate::{
    DeterministicContext, EntityFrameEvent, EntityKernelError, EntityKernelOutput, EntityStateSlice,
};

pub use decode::decode_local_entity_financial_tx;
pub use types::AccountEnvelopeMutation;
pub use types::LocalAccountFinancialView;
pub use types::{
    DirectPaymentEntityTx, ExtendCreditEntityTx, HtlcPaymentEntityTx, LendingBorrowEntityTx,
    LendingClosePositionEntityTx, LendingOfferEntityTx, LendingRepayEntityTx,
    LocalEntityFinancialTx, PlaceSwapOfferEntityTx, ProposeCancelSwapEntityTx,
    RequestCollateralEntityTx,
};

pub(crate) struct LocalFinancialResult {
    pub account_creates: Vec<xln_rscore_batch::AccountSeed>,
    pub account_txs: Vec<(String, AccountTx)>,
    pub outputs: Vec<EntityKernelOutput>,
    pub events: Vec<EntityFrameEvent>,
    pub wake_targets: Vec<String>,
    pub envelope_mutations: Vec<(String, AccountEnvelopeMutation)>,
    pub routed_entity_outputs: Vec<crate::LocalEntityOutput>,
    pub orderbook_deltas: Vec<crate::orderbook::SameJOutputDelta>,
}

pub(crate) fn apply_local_entity_financial_txs(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    txs: Vec<LocalEntityFinancialTx>,
    context: &DeterministicContext,
    account_views: &BTreeMap<String, LocalAccountFinancialView>,
    genesis_policy: Option<&xln_rscore_batch::EntityAccountGenesisPolicy>,
    runtime_seed: Option<&str>,
) -> Result<LocalFinancialResult, EntityKernelError> {
    let mut account_creates = Vec::new();
    let mut account_txs = Vec::new();
    let mut outputs = Vec::new();
    let mut events = Vec::new();
    let mut wake_targets = Vec::new();
    let mut envelope_mutations = Vec::new();
    let mut routed_entity_outputs = Vec::new();
    let mut orderbook_deltas = Vec::new();
    for tx in txs {
        match tx {
            LocalEntityFinancialTx::CrossJurisdictionForceSiblingDispute(tx) => {
                let counterparty = crate::cross_j::force_sibling_dispute_counterparty(
                    state,
                    &tx.route_id,
                    &tx.observed_counterparty_entity_id,
                )?;
                dispute::apply_prepare(
                    state,
                    paybook,
                    types::PrepareDisputeEntityTx {
                        counterparty_entity_id: counterparty,
                        description: Some(format!("sibling-dispute:{}", tx.route_id)),
                        min_cooldown_ms: 0,
                        cross_jurisdiction_route_id: Some(tx.route_id),
                        starter_initial_arguments: None,
                    },
                    account_views,
                    runtime_seed,
                    &mut envelope_mutations,
                    &mut routed_entity_outputs,
                    &mut events,
                    &mut orderbook_deltas,
                )?;
            }
            LocalEntityFinancialTx::DirectPayment(tx) => direct_payment::apply_direct_payment(
                state,
                tx,
                &mut account_txs,
                &mut events,
                &mut wake_targets,
            )?,
            LocalEntityFinancialTx::DisputeFinalize(tx) => dispute::apply_finalize(
                state,
                paybook,
                tx,
                account_views,
                &mut envelope_mutations,
                &mut routed_entity_outputs,
                &mut events,
            )?,
            LocalEntityFinancialTx::DisputeStart(tx) => dispute::apply_start(
                state,
                paybook,
                tx,
                account_views,
                runtime_seed,
                &mut envelope_mutations,
                &mut routed_entity_outputs,
                &mut events,
            )?,
            LocalEntityFinancialTx::ExtendCredit(tx) => extend_credit::apply_extend_credit(
                state,
                tx,
                &mut account_txs,
                &mut events,
                &mut wake_targets,
            ),
            LocalEntityFinancialTx::HtlcPayment(tx) => htlc_payment::apply_htlc_payment(
                state,
                paybook,
                tx,
                context,
                account_views,
                &mut account_txs,
                &mut outputs,
                &mut events,
            )?,
            LocalEntityFinancialTx::LendingBorrow(tx) => {
                lending::apply_borrow(state, tx, &mut account_txs, &mut events, &mut wake_targets)?
            }
            LocalEntityFinancialTx::LendingClosePosition(tx) => {
                lending::apply_close(state, tx, &mut account_txs, &mut events, &mut wake_targets)?
            }
            LocalEntityFinancialTx::LendingOffer(tx) => lending::apply_offer(
                state,
                tx,
                account_views,
                &mut account_txs,
                &mut events,
                &mut wake_targets,
            )?,
            LocalEntityFinancialTx::LendingRepay(tx) => {
                lending::apply_repay(state, tx, &mut account_txs, &mut events, &mut wake_targets)?
            }
            LocalEntityFinancialTx::OpenAccount(tx) => open_account::apply(
                state,
                tx,
                genesis_policy,
                &mut account_creates,
                &mut account_txs,
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
            LocalEntityFinancialTx::PrepareDispute(tx) => dispute::apply_prepare(
                state,
                paybook,
                tx,
                account_views,
                runtime_seed,
                &mut envelope_mutations,
                &mut routed_entity_outputs,
                &mut events,
                &mut orderbook_deltas,
            )?,
            LocalEntityFinancialTx::ProcessHtlcTimeouts(tx) => {
                account_txs.extend(tx.expired_locks.into_iter().map(|(account_id, lock_id)| {
                    (
                        account_id,
                        AccountTx::HtlcResolve(xln_rscore_engine::HtlcResolveTx {
                            lock_id,
                            outcome: xln_rscore_engine::HtlcResolveOutcome::Error {
                                reason: Some("timeout".to_string()),
                            },
                        }),
                    )
                }));
            }
            LocalEntityFinancialTx::ProposeCancelSwap(tx) => {
                swap_requests::apply_cancel_swap(state, tx, &mut account_txs, &mut wake_targets)?;
            }
            LocalEntityFinancialTx::RequestCollateral(tx) => {
                request_collateral::apply_request_collateral(
                    state,
                    tx,
                    &mut account_txs,
                    &mut wake_targets,
                );
            }
            LocalEntityFinancialTx::ResolveHtlcLock(tx) => resolve_htlc::apply(
                state,
                paybook,
                tx,
                account_views,
                &mut account_txs,
                &mut events,
                &mut wake_targets,
            )?,
            LocalEntityFinancialTx::QuoteBackedR2c(tx) => quote_r2c::apply(
                state,
                tx,
                account_views,
                &mut account_txs,
                &mut events,
                &mut envelope_mutations,
            )?,
            LocalEntityFinancialTx::SetRebalancePolicy(tx) => {
                if state.known_accounts.contains(&tx.counterparty_entity_id) {
                    let policy = xln_rscore_protocol::CanonicalValue::Object(vec![
                        (
                            "r2cRequestSoftLimit".into(),
                            xln_rscore_protocol::CanonicalValue::BigInt(tx.r2c_request_soft_limit),
                        ),
                        (
                            "hardLimit".into(),
                            xln_rscore_protocol::CanonicalValue::BigInt(tx.hard_limit),
                        ),
                        (
                            "maxAcceptableFee".into(),
                            xln_rscore_protocol::CanonicalValue::BigInt(tx.max_acceptable_fee),
                        ),
                    ]);
                    envelope_mutations.push((
                        tx.counterparty_entity_id,
                        AccountEnvelopeMutation::SetRebalancePolicy {
                            token_id: u32::from(tx.token_id.get()),
                            policy,
                        },
                    ));
                }
            }
            LocalEntityFinancialTx::SettleApprove(tx) => {
                settlement::apply_approve(state, tx, account_views, &mut events)?
            }
            LocalEntityFinancialTx::SettleExecute(tx) => {
                settlement::apply_execute(state, tx, account_views, &mut account_txs, &mut events)?
            }
            LocalEntityFinancialTx::SettlePropose(tx) => {
                settlement::apply_propose(state, tx, account_views, &mut account_txs, &mut events)?
            }
            LocalEntityFinancialTx::SettleReject(tx) => {
                settlement::apply_reject(state, tx, account_views, &mut account_txs, &mut events)?
            }
            LocalEntityFinancialTx::SettleUpdate(tx) => {
                settlement::apply_update(state, tx, account_views, &mut account_txs, &mut events)?
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
        account_creates,
        account_txs,
        outputs,
        events,
        wake_targets,
        envelope_mutations,
        routed_entity_outputs,
        orderbook_deltas,
    })
}

pub(crate) use settlement::apply_committed_settlement_followup;
