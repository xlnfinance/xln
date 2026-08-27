use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_engine::{AccountOutput, AccountTx, HtlcResolveOutcome, HtlcResolveTx};

use crate::commitment::compute_commitments;
use crate::j_events::{account_tx_kind, apply_committed_j_event_claim};
use crate::local_financial::{
    LocalAccountFinancialView, LocalEntityFinancialTx, apply_local_entity_financial_txs,
};
use crate::orderbook::{SameJOffer, SameJOutputDelta, apply_orderbook_outputs};
use crate::paybook::{
    PaybookEffects, committed_htlc_lock, committed_htlc_resolve, direct_payment_forward,
    revealed_secret_followup, timed_out_followup,
};
use crate::types::{AccountProposalWork, TargetedAccountTx};
use crate::{
    DeterministicContext, EntityKernelError, EntityKernelOutput, EntityKernelResult,
    EntityStateSlice, JurisdictionScope, OrderedAccountCommit, SchedulerCommand,
};

fn ensure_supported(tx: &AccountTx) -> Result<(), EntityKernelError> {
    match tx {
        AccountTx::SwapOffer { .. }
        | AccountTx::SwapResolve { .. }
        | AccountTx::SwapCancelRequest { .. }
        | AccountTx::DirectPayment { .. }
        | AccountTx::HtlcLock(_)
        | AccountTx::HtlcResolve(_)
        | AccountTx::JEventClaim(_) => Ok(()),
        _ => Err(EntityKernelError::UnsupportedAccountTx {
            kind: account_tx_kind(tx),
        }),
    }
}

fn require_one_output<'a>(
    outputs: &'a [AccountOutput],
    expected: &'static str,
) -> Result<&'a AccountOutput, EntityKernelError> {
    if outputs.len() != 1 {
        return Err(EntityKernelError::output(format!(
            "{expected}:COUNT:{}",
            outputs.len()
        )));
    }
    Ok(&outputs[0])
}

fn validate_direct_outputs(outputs: &[AccountOutput]) -> Result<(), EntityKernelError> {
    if outputs.len() > 1
        || outputs
            .iter()
            .any(|output| !matches!(output, AccountOutput::DirectPaymentForward { .. }))
    {
        return Err(EntityKernelError::output("DIRECT_PAYMENT_OUTPUTS"));
    }
    Ok(())
}

fn swap_offer_delta(
    account_id: &str,
    offer_id: &str,
    outputs: &[AccountOutput],
) -> Result<SameJOutputDelta, EntityKernelError> {
    let output = require_one_output(outputs, "SWAP_OFFER")?;
    let AccountOutput::SwapOfferUpsert { offer } = output else {
        return Err(EntityKernelError::output("SWAP_OFFER_KIND"));
    };
    if offer.offer_id != offer_id {
        return Err(EntityKernelError::output("SWAP_OFFER_ID"));
    }
    Ok(SameJOutputDelta::Upsert {
        account_id: account_id.to_string(),
        offer: Box::new(SameJOffer {
            offer_id: offer.offer_id.clone(),
            left_entity: offer.left_entity.clone(),
            right_entity: offer.right_entity.clone(),
            give_token_id: offer.give_token_id,
            give_token_decimals: offer.give_token_decimals,
            give_amount: offer.give_amount.clone(),
            want_token_id: offer.want_token_id,
            want_token_decimals: offer.want_token_decimals,
            want_amount: offer.want_amount.clone(),
            max_fee: offer.max_fee.clone(),
            min_net_receive: offer.min_net_receive.clone(),
            price_ticks: offer.price_ticks.clone(),
            time_in_force: offer.time_in_force,
            maker_is_left: offer.maker_is_left,
            created_height: offer.created_height,
            quantized_give: offer.quantized_give.clone(),
            quantized_want: offer.quantized_want.clone(),
        }),
    })
}

fn swap_resolve_delta(
    account_id: &str,
    offer_id: &str,
    outputs: &[AccountOutput],
) -> Result<SameJOutputDelta, EntityKernelError> {
    match require_one_output(outputs, "SWAP_RESOLVE")? {
        AccountOutput::SwapOfferUpsert { offer } if offer.offer_id == offer_id => {
            Ok(SameJOutputDelta::Upsert {
                account_id: account_id.to_string(),
                offer: Box::new(SameJOffer {
                    offer_id: offer.offer_id.clone(),
                    left_entity: offer.left_entity.clone(),
                    right_entity: offer.right_entity.clone(),
                    give_token_id: offer.give_token_id,
                    give_token_decimals: offer.give_token_decimals,
                    give_amount: offer.give_amount.clone(),
                    want_token_id: offer.want_token_id,
                    want_token_decimals: offer.want_token_decimals,
                    want_amount: offer.want_amount.clone(),
                    max_fee: offer.max_fee.clone(),
                    min_net_receive: offer.min_net_receive.clone(),
                    price_ticks: offer.price_ticks.clone(),
                    time_in_force: offer.time_in_force,
                    maker_is_left: offer.maker_is_left,
                    created_height: offer.created_height,
                    quantized_give: offer.quantized_give.clone(),
                    quantized_want: offer.quantized_want.clone(),
                }),
            })
        }
        AccountOutput::SwapOfferRemove {
            offer_id: output_id,
            maker_is_left: _,
        } if output_id == offer_id => Ok(SameJOutputDelta::Remove {
            account_id: account_id.to_string(),
            offer_id: offer_id.to_string(),
        }),
        _ => Err(EntityKernelError::output("SWAP_RESOLVE_KIND_OR_ID")),
    }
}

fn swap_cancel_delta(
    account_id: &str,
    offer_id: &str,
    outputs: &[AccountOutput],
) -> Result<SameJOutputDelta, EntityKernelError> {
    let output = require_one_output(outputs, "SWAP_CANCEL")?;
    let AccountOutput::SwapCancelRequest {
        offer_id: output_id,
    } = output
    else {
        return Err(EntityKernelError::output("SWAP_CANCEL_KIND"));
    };
    if output_id != offer_id {
        return Err(EntityKernelError::output("SWAP_CANCEL_ID"));
    }
    Ok(SameJOutputDelta::CancelRequest {
        account_id: account_id.to_string(),
        offer_id: offer_id.to_string(),
    })
}

fn htlc_output<'a>(
    tx: &xln_rscore_engine::HtlcResolveTx,
    outputs: &'a [AccountOutput],
) -> Result<&'a AccountOutput, EntityKernelError> {
    let output = require_one_output(outputs, "HTLC_RESOLVE")?;
    let valid = match (&tx.outcome, output) {
        (
            HtlcResolveOutcome::Secret { secret: tx_secret },
            AccountOutput::HtlcSecret {
                lock_id, secret, ..
            },
        ) => lock_id == &tx.lock_id && secret == tx_secret,
        (HtlcResolveOutcome::Error { .. }, AccountOutput::HtlcError { lock_id, .. }) => {
            lock_id == &tx.lock_id
        }
        _ => false,
    };
    valid
        .then_some(output)
        .ok_or_else(|| EntityKernelError::output("HTLC_RESOLVE_KIND_OR_ID"))
}

fn preapply_resolves(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    jurisdiction_id: Option<&str>,
    outputs: &mut Vec<EntityKernelOutput>,
    account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let mut effects = PaybookEffects {
        account_txs,
        outputs,
    };
    for transition in &commit.transitions {
        let AccountTx::HtlcResolve(tx) = &transition.tx else {
            continue;
        };
        let output = htlc_output(tx, &transition.outputs)?;
        committed_htlc_resolve(
            state,
            &commit.account_id,
            output,
            jurisdiction_id,
            &mut effects,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_commit_transitions(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    context: &DeterministicContext,
    consumed_htlcs: &mut BTreeSet<(String, String)>,
    deltas: &mut Vec<SameJOutputDelta>,
    account_txs: &mut Vec<TargetedAccountTx>,
    outputs: &mut Vec<EntityKernelOutput>,
) -> Result<(), EntityKernelError> {
    let mut direct_forwards = Vec::new();
    let mut timed_out = Vec::new();
    let mut revealed = Vec::new();
    for transition in &commit.transitions {
        ensure_supported(&transition.tx)?;
        let mut effects = PaybookEffects {
            account_txs,
            outputs,
        };
        match &transition.tx {
            AccountTx::DirectPayment { .. } => {
                validate_direct_outputs(&transition.outputs)?;
                direct_forwards.extend(transition.outputs.iter().cloned());
            }
            AccountTx::HtlcLock(tx) => {
                if !transition.outputs.is_empty() {
                    return Err(EntityKernelError::output("HTLC_LOCK_OUTPUTS"));
                }
                committed_htlc_lock(state, commit, tx, context, consumed_htlcs, &mut effects)?;
            }
            AccountTx::HtlcResolve(tx) => {
                let output = htlc_output(tx, &transition.outputs)?.clone();
                match output {
                    AccountOutput::HtlcSecret { .. } => revealed.push(output),
                    AccountOutput::HtlcError { .. } => timed_out.push(output),
                    _ => return Err(EntityKernelError::output("HTLC_RESOLVE_KIND_OR_ID")),
                }
            }
            AccountTx::SwapOffer { offer_id, .. } => {
                deltas.push(swap_offer_delta(
                    &commit.account_id,
                    offer_id,
                    &transition.outputs,
                )?);
            }
            AccountTx::SwapResolve { offer_id, .. } => {
                deltas.push(swap_resolve_delta(
                    &commit.account_id,
                    offer_id,
                    &transition.outputs,
                )?);
            }
            AccountTx::SwapCancelRequest { offer_id } => {
                deltas.push(swap_cancel_delta(
                    &commit.account_id,
                    offer_id,
                    &transition.outputs,
                )?);
            }
            AccountTx::JEventClaim(claim) => {
                apply_committed_j_event_claim(
                    &state.entity_id,
                    &commit.account_id,
                    claim,
                    &transition.outputs,
                    outputs,
                )?;
            }
            _ => {
                return Err(EntityKernelError::UnsupportedAccountTx {
                    kind: account_tx_kind(&transition.tx),
                });
            }
        }
    }
    let mut effects = PaybookEffects {
        account_txs,
        outputs,
    };
    // Canonical TS first consumes frame-owned HTLC locks/swaps, then applies
    // parent follow-ups in direct -> timeout -> secret order. This ordering is
    // observable when one target Account receives multiple outbound txs.
    for output in &direct_forwards {
        direct_payment_forward(state, output, &mut effects)?;
    }
    for output in &timed_out {
        timed_out_followup(state, output, &mut effects)?;
    }
    for output in &revealed {
        revealed_secret_followup(
            state,
            output,
            context.jurisdiction_id.as_deref(),
            &mut effects,
        )?;
    }
    Ok(())
}

fn validate_commit(
    state: &EntityStateSlice,
    commit: &OrderedAccountCommit,
) -> Result<(), EntityKernelError> {
    if commit.scope == JurisdictionScope::Cross {
        return Err(EntityKernelError::CrossJurisdictionUnsupported {
            account_id: commit.account_id.clone(),
        });
    }
    if !state.known_accounts.contains(&commit.account_id) {
        return Err(EntityKernelError::AccountMissing {
            account_id: commit.account_id.clone(),
        });
    }
    Ok(())
}

fn group_proposal_work(account_txs: Vec<TargetedAccountTx>) -> Vec<AccountProposalWork> {
    let mut positions = BTreeMap::<String, usize>::new();
    let mut grouped = Vec::<AccountProposalWork>::new();
    for (account_id, tx) in account_txs {
        if let Some(index) = positions.get(&account_id).copied() {
            grouped[index].txs.push(tx);
            continue;
        }
        positions.insert(account_id.clone(), grouped.len());
        grouped.push(AccountProposalWork {
            account_id,
            txs: vec![tx],
        });
    }
    grouped
}

fn append_scheduled_account_txs(
    commands: &[SchedulerCommand],
    account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    for command in commands {
        match command {
            SchedulerCommand::ProcessHtlcTimeouts { expired_locks } => {
                account_txs.extend(expired_locks.iter().map(|(account_id, lock_id)| {
                    (
                        account_id.clone(),
                        AccountTx::HtlcResolve(HtlcResolveTx {
                            lock_id: lock_id.clone(),
                            outcome: HtlcResolveOutcome::Error {
                                reason: Some("timeout".to_string()),
                            },
                        }),
                    )
                }));
            }
            SchedulerCommand::HubRebalance => {
                return Err(EntityKernelError::HubRebalanceHandlerMissing);
            }
        }
    }
    Ok(())
}

pub(crate) struct EntityTransitionResult {
    pub(crate) state: EntityStateSlice,
    pub(crate) proposal_work: Vec<AccountProposalWork>,
    pub(crate) outputs: Vec<EntityKernelOutput>,
    pub(crate) local_events: Vec<crate::EntityFrameEvent>,
    pub(crate) non_mutating_wake_targets: Vec<String>,
}

pub(crate) fn apply_entity_transitions(
    mut state: EntityStateSlice,
    commits: &[OrderedAccountCommit],
    local_txs: Vec<LocalEntityFinancialTx>,
    local_account_views: &BTreeMap<String, LocalAccountFinancialView>,
    context: &DeterministicContext,
    scheduled_commands: &[SchedulerCommand],
) -> Result<EntityTransitionResult, EntityKernelError> {
    let mut deltas = Vec::new();
    let mut account_txs = Vec::new();
    let mut outputs = Vec::new();
    let mut consumed_htlcs = BTreeSet::new();
    for commit in commits {
        validate_commit(&state, commit)?;
        preapply_resolves(
            &mut state,
            commit,
            context.jurisdiction_id.as_deref(),
            &mut outputs,
            &mut account_txs,
        )?;
        apply_commit_transitions(
            &mut state,
            commit,
            context,
            &mut consumed_htlcs,
            &mut deltas,
            &mut account_txs,
            &mut outputs,
        )?;
    }
    if !deltas.is_empty() && state.orderbook.is_none() {
        return Err(EntityKernelError::orderbook("ORDERBOOK_EXTENSION_REQUIRED"));
    }
    if let Some(orderbook) = &mut state.orderbook {
        let orderbook_effects =
            apply_orderbook_outputs(orderbook, &deltas, context, &state.entity_id)?;
        account_txs.extend(orderbook_effects.account_txs);
        if orderbook_effects.matched_swaps > 0 {
            outputs.push(EntityKernelOutput::SwapMatched {
                entity_id: state.entity_id.clone(),
                count: orderbook_effects.matched_swaps,
            });
        }
    }
    let local =
        apply_local_entity_financial_txs(&mut state, local_txs, context, local_account_views)?;
    account_txs.extend(local.account_txs);
    outputs.extend(local.outputs);
    append_scheduled_account_txs(scheduled_commands, &mut account_txs)?;
    let proposal_work = group_proposal_work(account_txs);
    Ok(EntityTransitionResult {
        state,
        proposal_work,
        outputs,
        local_events: local.events,
        non_mutating_wake_targets: local.wake_targets,
    })
}

pub fn apply_entity_kernel(
    state: EntityStateSlice,
    commits: &[OrderedAccountCommit],
    context: &DeterministicContext,
) -> Result<EntityKernelResult, EntityKernelError> {
    let result =
        apply_entity_transitions(state, commits, Vec::new(), &BTreeMap::new(), context, &[])?;
    let commitments = compute_commitments(&result.state, &result.proposal_work, &result.outputs)?;
    Ok(EntityKernelResult {
        state: result.state,
        proposal_work: result.proposal_work,
        outputs: result.outputs,
        commitments,
    })
}
