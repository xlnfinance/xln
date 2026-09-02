use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountOutput, AccountTx, HtlcResolveOutcome, HtlcResolveTx, SwapOfferSnapshot,
};
use xln_rscore_protocol::CanonicalValue;

use crate::commitment::compute_commitments;
use crate::j_events::apply_committed_j_event_claim;
use crate::local_financial::{LocalAccountFinancialView, apply_local_entity_financial_txs};
use crate::orderbook::{
    OrderbookPairJob, OrderbookPairResult, PreparedOrderbookStage, SameJOffer, SameJOutputDelta,
    install_orderbook_outputs, prepare_orderbook_outputs, validate_orderbook_outputs,
};
use crate::paybook::{
    PaybookChanges, PaybookEffects, committed_htlc_lock, committed_htlc_resolve,
    direct_payment_forward, revealed_secret_followup, timed_out_followup,
};
use crate::types::{AccountProposalWork, TargetedAccountTx};
use crate::{
    CanonicalEntityTx, DeterministicContext, EntityFrameEvent, EntityKernelError,
    EntityKernelOutput, EntityKernelResult, EntityStateSlice, EntityTxKind, JurisdictionScope,
    OrderedAccountCommit, SchedulerCommand,
};
use crate::{
    LocalEntityOutput, LocalEntityOutputTx, LocalEntityTx, apply_cross_jurisdiction_entity_txs,
    apply_local_entity_control_tx, authorize_runtime_output,
};

fn profile_entity() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

fn hub_config_field<'a>(
    config: &'a CanonicalValue,
    field: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    let CanonicalValue::Object(entries) = config else {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "OBJECT".to_string(),
        });
    };
    entries
        .iter()
        .find_map(|(key, value)| (key == field).then_some(value))
        .ok_or(EntityKernelError::HubRebalanceConfigInvalid {
            detail: field.to_string(),
        })
}

fn initial_hub_policy_txs(
    state: &EntityStateSlice,
    commit: &OrderedAccountCommit,
    created_accounts: &BTreeSet<String>,
) -> Result<Vec<AccountTx>, EntityKernelError> {
    if !created_accounts.contains(&commit.account_id)
        || !commit.committed_via_new_frame
        || commit.frame_height != 1
    {
        return Ok(Vec::new());
    }
    let Some(config) = state.hub_rebalance_config.as_ref() else {
        return Ok(Vec::new());
    };
    let CanonicalValue::Number(version) = hub_config_field(config, "policyVersion")? else {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "policyVersion".to_string(),
        });
    };
    let policy_version = version.as_str().parse::<u64>().map_err(|_| {
        EntityKernelError::HubRebalanceConfigInvalid {
            detail: "policyVersion".to_string(),
        }
    })?;
    if policy_version == 0 {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "policyVersion".to_string(),
        });
    }
    let CanonicalValue::BigInt(liquidity_fee_bps) =
        hub_config_field(config, "rebalanceLiquidityFeeBps")?
    else {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "rebalanceLiquidityFeeBps".to_string(),
        });
    };
    if liquidity_fee_bps < &BigInt::from(0) {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "rebalanceLiquidityFeeBps".to_string(),
        });
    }
    let token_ids = commit
        .transitions
        .iter()
        .filter_map(|transition| match transition.tx {
            AccountTx::AddDelta { token_id } => Some(token_id.get()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    token_ids
        .into_iter()
        .map(|token_id| {
            let decimals = match token_id {
                1 | 3 | 4 => 6,
                2 | 5 => 18,
                _ => {
                    return Err(EntityKernelError::HubRebalanceConfigInvalid {
                        detail: format!("TOKEN_METADATA_UNAVAILABLE:{token_id}"),
                    });
                }
            };
            Ok(AccountTx::RebalancePolicy {
                token_id: u32::from(token_id),
                policy_version,
                base_fee: BigInt::from(10_u8).pow(decimals - 1),
                liquidity_fee_bps: liquidity_fee_bps.clone(),
                gas_fee: BigInt::from(0),
            })
        })
        .collect()
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

fn same_j_offer(offer: SwapOfferSnapshot) -> SameJOffer {
    SameJOffer {
        offer_id: offer.offer_id,
        left_entity: offer.left_entity,
        right_entity: offer.right_entity,
        give_token_id: offer.give_token_id,
        give_token_decimals: offer.give_token_decimals,
        give_amount: offer.give_amount,
        want_token_id: offer.want_token_id,
        want_token_decimals: offer.want_token_decimals,
        want_amount: offer.want_amount,
        max_fee: offer.max_fee,
        min_net_receive: offer.min_net_receive,
        price_ticks: offer.price_ticks,
        time_in_force: offer.time_in_force,
        maker_is_left: offer.maker_is_left,
        created_height: offer.created_height,
        quantized_give: offer.quantized_give,
        quantized_want: offer.quantized_want,
        cross_jurisdiction: offer.cross_jurisdiction,
    }
}

fn swap_offer_delta(
    state: &mut EntityStateSlice,
    account_id: &str,
    offer_id: &str,
    outputs: Vec<AccountOutput>,
) -> Result<Option<SameJOutputDelta>, EntityKernelError> {
    let [AccountOutput::SwapOfferUpsert { offer }] = outputs.as_slice() else {
        if outputs.len() != 1 {
            return Err(EntityKernelError::output(format!(
                "SWAP_OFFER:COUNT:{}",
                outputs.len()
            )));
        }
        return Err(EntityKernelError::output("SWAP_OFFER_KIND"));
    };
    if offer.offer_id != offer_id {
        return Err(EntityKernelError::output("SWAP_OFFER_ID"));
    }
    let AccountOutput::SwapOfferUpsert { offer } = outputs
        .into_iter()
        .next()
        .ok_or_else(|| EntityKernelError::output("SWAP_OFFER:COUNT:0"))?
    else {
        unreachable!("validated swap offer output")
    };
    if let Some(route) = offer.cross_jurisdiction.as_ref() {
        let route_id = match route {
            xln_rscore_protocol::CanonicalValue::Object(fields) => fields
                .iter()
                .find_map(|(key, value)| (key == "orderId").then_some(value)),
            _ => None,
        }
        .and_then(|value| match value {
            xln_rscore_protocol::CanonicalValue::String(value) => Some(value.as_str()),
            _ => None,
        })
        .ok_or_else(|| EntityKernelError::output("CROSS_J_SWAP_ROUTE_ORDER_ID"))?;
        if route_id != offer_id {
            return Err(EntityKernelError::output("CROSS_J_SWAP_ROUTE_ID_MISMATCH"));
        }
        state
            .cross_jurisdiction_swaps
            .get_or_insert_with(crate::EntityCanonicalCollection::empty)
            .insert(offer_id.to_string(), route.clone())?;
        let (route_account_id, working_offer) =
            crate::cross_j::cross_jurisdiction_working_offer(route)?;
        if route_account_id != account_id {
            return Err(EntityKernelError::output(
                "CROSS_J_SWAP_SOURCE_ACCOUNT_MISMATCH",
            ));
        }
        return Ok(Some(SameJOutputDelta::Upsert {
            account_id: route_account_id,
            offer: Box::new(working_offer),
        }));
    }
    Ok(Some(SameJOutputDelta::Upsert {
        account_id: account_id.to_string(),
        offer: Box::new(same_j_offer(*offer)),
    }))
}

fn swap_resolve_delta(
    state: &mut EntityStateSlice,
    account_id: &str,
    offer_id: &str,
    outputs: Vec<AccountOutput>,
) -> Result<Option<SameJOutputDelta>, EntityKernelError> {
    if outputs.len() != 1 {
        return Err(EntityKernelError::output(format!(
            "SWAP_RESOLVE:COUNT:{}",
            outputs.len()
        )));
    }
    match outputs
        .into_iter()
        .next()
        .ok_or_else(|| EntityKernelError::output("SWAP_RESOLVE:COUNT:0"))?
    {
        AccountOutput::SwapOfferUpsert { offer } if offer.offer_id == offer_id => {
            if let Some(route) = offer.cross_jurisdiction.as_ref() {
                state
                    .cross_jurisdiction_swaps
                    .get_or_insert_with(crate::EntityCanonicalCollection::empty)
                    .insert(offer_id.to_string(), route.clone())?;
                return Ok(None);
            }
            Ok(Some(SameJOutputDelta::Upsert {
                account_id: account_id.to_string(),
                offer: Box::new(same_j_offer(*offer)),
            }))
        }
        AccountOutput::SwapOfferRemove {
            offer_id: output_id,
            maker_is_left: _,
        } if output_id == offer_id => {
            if state
                .cross_jurisdiction_swaps
                .as_ref()
                .is_some_and(|routes| routes.get(offer_id).is_some())
            {
                Ok(None)
            } else {
                Ok(Some(SameJOutputDelta::Remove {
                    account_id: account_id.to_string(),
                    offer_id: output_id,
                }))
            }
        }
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
    paybook: &mut PaybookChanges,
    commit: &mut OrderedAccountCommit,
    jurisdiction_id: Option<&str>,
    outputs: &mut Vec<EntityKernelOutput>,
    account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<(Vec<AccountOutput>, Vec<AccountOutput>), EntityKernelError> {
    let mut effects = PaybookEffects {
        account_txs,
        outputs,
    };
    let mut retained = Vec::with_capacity(commit.transitions.len());
    let mut timed_out = Vec::new();
    let mut revealed = Vec::new();
    for transition in std::mem::take(&mut commit.transitions) {
        let AccountTx::HtlcResolve(tx) = &transition.tx else {
            retained.push(transition);
            continue;
        };
        let output = htlc_output(tx, &transition.outputs)?;
        committed_htlc_resolve(
            state,
            paybook,
            &commit.account_id,
            output,
            jurisdiction_id,
            &mut effects,
        )?;
        let output = transition
            .outputs
            .into_iter()
            .next()
            .ok_or_else(|| EntityKernelError::output("HTLC_RESOLVE_OUTPUT_MISSING"))?;
        match output {
            AccountOutput::HtlcSecret { .. } => revealed.push(output),
            AccountOutput::HtlcError { .. } => timed_out.push(output),
            _ => return Err(EntityKernelError::output("HTLC_RESOLVE_KIND_OR_ID")),
        }
    }
    commit.transitions = retained;
    Ok((timed_out, revealed))
}

#[allow(clippy::too_many_arguments)]
fn apply_commit_transitions(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    commit: &mut OrderedAccountCommit,
    context: &DeterministicContext,
    consumed_htlcs: &mut BTreeSet<(String, String)>,
    deltas: &mut Vec<SameJOutputDelta>,
    account_txs: &mut Vec<TargetedAccountTx>,
    outputs: &mut Vec<EntityKernelOutput>,
    routed_entity_outputs: &mut Vec<LocalEntityOutput>,
    entity_events: &mut Vec<EntityFrameEvent>,
    created_accounts: &BTreeSet<String>,
    timed_out: Vec<AccountOutput>,
    revealed: Vec<AccountOutput>,
    local_account_views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<(), EntityKernelError> {
    let mut direct_forwards = Vec::new();
    let initial_policy_txs = initial_hub_policy_txs(state, commit, created_accounts)?;
    let transitions = std::mem::take(&mut commit.transitions);
    let last_settlement_transition = transitions
        .iter()
        .rposition(|transition| matches!(transition.tx, AccountTx::SettleTransition { .. }));
    let local_is_left = state.entity_id.as_str() < commit.account_id.as_str();
    let proposer_is_left = if commit.committed_via_new_frame {
        !local_is_left
    } else {
        local_is_left
    };
    for (transition_index, mut transition) in transitions.into_iter().enumerate() {
        if crate::local_financial::apply_committed_settlement_followup(
            state,
            &commit.account_id,
            &transition.tx,
            last_settlement_transition == Some(transition_index),
            proposer_is_left,
            local_account_views.get(&commit.account_id),
        )? {
            if !transition.outputs.is_empty() {
                return Err(EntityKernelError::output(format!(
                    "SETTLEMENT_COMMITTED_OUTPUTS:{}",
                    transition.outputs.len()
                )));
            }
            continue;
        }
        if crate::lending::apply_committed_lending_followup(
            state,
            commit,
            &transition,
            local_account_views.get(&commit.account_id),
            account_txs,
        )? {
            continue;
        }
        if let Some(applied) = crate::cross_j::apply_committed_account_tx_followup(
            state,
            &commit.account_id,
            commit.frame_timestamp,
            &transition.tx,
        )? {
            if !transition.outputs.is_empty() {
                return Err(EntityKernelError::output(format!(
                    "CROSS_J_COMMITTED_OUTPUTS:{}:{}",
                    transition.tx.wire_name(),
                    transition.outputs.len(),
                )));
            }
            deltas.extend(applied.orderbook_deltas);
            for work in applied.proposal_work {
                account_txs.extend(work.txs.into_iter().map(|tx| (work.account_id.clone(), tx)));
            }
            routed_entity_outputs.extend(applied.outputs);
            entity_events.extend(applied.events);
            continue;
        }
        let mut effects = PaybookEffects {
            account_txs,
            outputs,
        };
        match &transition.tx {
            AccountTx::DirectPayment { .. } => {
                validate_direct_outputs(&transition.outputs)?;
                direct_forwards.extend(std::mem::take(&mut transition.outputs));
            }
            AccountTx::HtlcLock(tx) => {
                if !transition.outputs.is_empty() {
                    return Err(EntityKernelError::output("HTLC_LOCK_OUTPUTS"));
                }
                committed_htlc_lock(
                    state,
                    paybook,
                    commit,
                    tx,
                    context,
                    consumed_htlcs,
                    &mut effects,
                )?;
            }
            AccountTx::HtlcResolve(_) => unreachable!("resolve transitions were pre-applied"),
            AccountTx::SwapOffer {
                offer_id,
                cross_jurisdiction,
                ..
            } => match cross_jurisdiction {
                Some(_) => {
                    // The cross-j route/book was committed by the owning
                    // Entity transition. Account emits no same-j orderbook
                    // projection for this offer.
                    if !transition.outputs.is_empty() {
                        return Err(EntityKernelError::output(format!(
                            "CROSS_J_SWAP_OFFER_OUTPUTS:{}",
                            transition.outputs.len()
                        )));
                    }
                }
                None => {
                    if let Some(delta) = swap_offer_delta(
                        state,
                        &commit.account_id,
                        offer_id,
                        std::mem::take(&mut transition.outputs),
                    )? {
                        deltas.push(delta);
                    }
                }
            },
            AccountTx::SwapResolve { offer_id, .. } => {
                if let Some(delta) = swap_resolve_delta(
                    state,
                    &commit.account_id,
                    offer_id,
                    std::mem::take(&mut transition.outputs),
                )? {
                    deltas.push(delta);
                }
            }
            AccountTx::SwapCancelRequest { offer_id } => {
                if state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .is_some_and(|routes| routes.get(offer_id).is_some())
                {
                    // Cross-j cancellation stays in the route/book lifecycle;
                    // it must never delete a coincident same-J order key.
                    if transition.outputs.len() != 1 {
                        return Err(EntityKernelError::output(format!(
                            "CROSS_J_SWAP_CANCEL:COUNT:{}",
                            transition.outputs.len()
                        )));
                    }
                } else {
                    deltas.push(swap_cancel_delta(
                        &commit.account_id,
                        offer_id,
                        &transition.outputs,
                    )?);
                }
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
            AccountTx::AddDelta { .. }
            | AccountTx::SetCreditLimit { .. }
            | AccountTx::ReserveToCollateral { .. }
            | AccountTx::RequestCollateral { .. }
            | AccountTx::RebalanceRefund { .. }
            | AccountTx::RebalancePolicy { .. } => {
                if !transition.outputs.is_empty() {
                    return Err(EntityKernelError::output("STATE_ONLY_TX_OUTPUTS"));
                }
            }
            AccountTx::LendingFund { .. }
            | AccountTx::LendingBorrowRequest { .. }
            | AccountTx::LendingRepay { .. }
            | AccountTx::LendingCredit { .. }
            | AccountTx::LendingCloseRequest { .. }
            | AccountTx::LendingClosePayout { .. } => {
                return Err(EntityKernelError::lending(format!(
                    "COMMITTED_FOLLOWUP_NOT_HANDLED:{}",
                    transition.tx.wire_name()
                )));
            }
            AccountTx::CrossPullLock { .. }
            | AccountTx::CrossPullClose { .. }
            | AccountTx::CrossPullProgress { .. }
            | AccountTx::CrossSwapFillAck { .. } => {
                return Err(EntityKernelError::output(format!(
                    "CROSS_J_COMMITTED_FOLLOWUP_NOT_HANDLED:{}",
                    transition.tx.wire_name()
                )));
            }
            AccountTx::SettleTransition { .. } => {
                return Err(EntityKernelError::output(
                    "SETTLEMENT_COMMITTED_FOLLOWUP_NOT_HANDLED",
                ));
            }
        }
    }
    account_txs.extend(
        initial_policy_txs
            .into_iter()
            .map(|tx| (commit.account_id.clone(), tx)),
    );
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
        timed_out_followup(state, paybook, output, &mut effects)?;
    }
    for output in &revealed {
        revealed_secret_followup(
            state,
            paybook,
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
    // The map is lookup-only; canonical proposal order lives in `grouped`, so
    // randomized hash iteration can never affect committed bytes.
    let mut positions = HashMap::<String, usize>::new();
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
            SchedulerCommand::AutoFinalizeDispute { .. }
            | SchedulerCommand::BroadcastQueuedDisputeFinalization
            | SchedulerCommand::HubRebalance => {}
        }
    }
    Ok(())
}

fn append_scheduled_entity_outputs(
    state: &EntityStateSlice,
    commands: &[SchedulerCommand],
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<(), EntityKernelError> {
    let mut entity_txs = Vec::new();
    let mut broadcast = false;
    for command in commands {
        match command {
            SchedulerCommand::AutoFinalizeDispute {
                counterparty_entity_id,
            } => {
                entity_txs.push(LocalEntityOutputTx::Projected(
                    CanonicalEntityTx::from_frame_projection(
                        EntityTxKind::DisputeFinalize,
                        CanonicalValue::Object(vec![
                            (
                                "counterpartyEntityId".into(),
                                CanonicalValue::String(counterparty_entity_id.clone()),
                            ),
                            (
                                "description".into(),
                                CanonicalValue::String("auto-finalize-after-timeout".into()),
                            ),
                            ("useOnchainRegistry".into(), CanonicalValue::Bool(true)),
                        ]),
                    )
                    .map_err(|error| {
                        EntityKernelError::local("scheduledWake", error.to_string())
                    })?,
                ));
                broadcast = true;
            }
            SchedulerCommand::BroadcastQueuedDisputeFinalization => broadcast = true,
            SchedulerCommand::ProcessHtlcTimeouts { .. } | SchedulerCommand::HubRebalance => {}
        }
    }
    if broadcast
        && !outputs.iter().any(|output| {
            output.entity_id.eq_ignore_ascii_case(&state.entity_id)
                && output.entity_txs.iter().any(|tx| {
                    matches!(tx, LocalEntityOutputTx::Projected(tx) if tx.kind == EntityTxKind::JBroadcast)
                })
        })
    {
        entity_txs.push(LocalEntityOutputTx::Projected(
            CanonicalEntityTx::from_frame_projection(
                EntityTxKind::JBroadcast,
                CanonicalValue::Object(Vec::new()),
            )
            .map_err(|error| EntityKernelError::local("scheduledWake", error.to_string()))?,
        ));
    }
    if !entity_txs.is_empty() {
        outputs.push(LocalEntityOutput {
            entity_id: state.entity_id.clone(),
            target_signer_id: None,
            entity_txs,
        });
    }
    Ok(())
}

pub(crate) struct EntityTransitionResult {
    pub(crate) state: EntityStateSlice,
    pub(crate) account_creates: Vec<xln_rscore_batch::AccountSeed>,
    pub(crate) proposal_work: Vec<AccountProposalWork>,
    pub(crate) outputs: Vec<EntityKernelOutput>,
    pub(crate) local_events: Vec<crate::EntityFrameEvent>,
    pub(crate) non_mutating_wake_targets: Vec<String>,
    pub(crate) routed_entity_outputs: Vec<LocalEntityOutput>,
    pub(crate) j_outputs: Vec<crate::EntityJOutput>,
    pub(crate) local_hashes_to_sign: Vec<crate::HashToSign>,
    pub(crate) account_envelope_mutations: Vec<(String, crate::AccountEnvelopeMutation)>,
    pub(crate) paybook_changes: PaybookChanges,
    pub(crate) orderbook_deltas: Vec<SameJOutputDelta>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "the canonical pure Entity transition keeps all input branches explicit"
)]
pub(crate) fn apply_entity_transitions(
    mut state: EntityStateSlice,
    mut paybook_changes: PaybookChanges,
    commits: Vec<OrderedAccountCommit>,
    created_accounts: &BTreeSet<String>,
    local_txs: Vec<crate::AdmittedLocalEntityTx>,
    local_account_views: &BTreeMap<String, LocalAccountFinancialView>,
    local_account_genesis_policy: Option<&xln_rscore_batch::EntityAccountGenesisPolicy>,
    entity_authority: Option<&crate::EntityFrameAuthority>,
    runtime_seed: Option<&str>,
    context: &DeterministicContext,
) -> Result<EntityTransitionResult, EntityKernelError> {
    let total_started = Instant::now();
    let profile = profile_entity();
    let paybook_rows_before = state.paybook.entries.len();
    // This cardinality exists only for the opt-in profiler. Keeping the scan
    // outside the guard made ordinary production walk every committed Account
    // transition once before the real Entity transition began.
    let (
        transition_count,
        resolve_transition_count,
        resolve_commit_count,
        lock_transition_count,
        lock_new_frame_count,
        lock_envelope_count,
    ) = if profile {
        commits.iter().fold(
            (0_usize, 0_usize, 0_usize, 0_usize, 0_usize, 0_usize),
            |(transitions, resolves, resolve_commits, locks, new_locks, enveloped_locks),
             commit| {
                let commit_resolves = commit
                    .transitions
                    .iter()
                    .filter(|transition| matches!(transition.tx, AccountTx::HtlcResolve(_)))
                    .count();
                let (commit_locks, commit_enveloped_locks) = commit.transitions.iter().fold(
                    (0_usize, 0_usize),
                    |(locks, enveloped), transition| match &transition.tx {
                        AccountTx::HtlcLock(tx) => (
                            locks.saturating_add(1),
                            enveloped.saturating_add(usize::from(tx.envelope.is_some())),
                        ),
                        _ => (locks, enveloped),
                    },
                );
                (
                    transitions.saturating_add(commit.transitions.len()),
                    resolves.saturating_add(commit_resolves),
                    resolve_commits.saturating_add(usize::from(commit_resolves > 0)),
                    locks.saturating_add(commit_locks),
                    new_locks.saturating_add(if commit.committed_via_new_frame {
                        commit_locks
                    } else {
                        0
                    }),
                    enveloped_locks.saturating_add(commit_enveloped_locks),
                )
            },
        )
    } else {
        (0, 0, 0, 0, 0, 0)
    };
    let mut deltas = Vec::new();
    let mut account_txs = Vec::new();
    let mut outputs = Vec::new();
    let mut routed_entity_outputs = Vec::new();
    let mut committed_events = Vec::new();
    let mut consumed_htlcs = BTreeSet::new();
    let mut preapply_elapsed = Duration::ZERO;
    let mut apply_elapsed = Duration::ZERO;
    let commit_count = commits.len();
    for mut commit in commits {
        validate_commit(&state, &commit)?;
        let started = profile.then(Instant::now);
        let (timed_out, revealed) = preapply_resolves(
            &mut state,
            &mut paybook_changes,
            &mut commit,
            context.jurisdiction_id.as_deref(),
            &mut outputs,
            &mut account_txs,
        )?;
        if let Some(started) = started {
            preapply_elapsed = preapply_elapsed.saturating_add(started.elapsed());
        }
        let started = profile.then(Instant::now);
        apply_commit_transitions(
            &mut state,
            &mut paybook_changes,
            &mut commit,
            context,
            &mut consumed_htlcs,
            &mut deltas,
            &mut account_txs,
            &mut outputs,
            &mut routed_entity_outputs,
            &mut committed_events,
            created_accounts,
            timed_out,
            revealed,
            local_account_views,
        )?;
        if let Some(started) = started {
            apply_elapsed = apply_elapsed.saturating_add(started.elapsed());
        }
    }
    let local_started = Instant::now();
    let mut local_account_txs = Vec::new();
    let mut local_outputs = Vec::new();
    let mut local_events = committed_events;
    let mut local_wake_targets = Vec::new();
    let mut j_outputs = Vec::new();
    let mut local_hashes_to_sign = Vec::new();
    let mut account_envelope_mutations = Vec::new();
    let mut account_creates = Vec::new();
    let mut local_txs = std::collections::VecDeque::from(local_txs);
    while let Some(admitted) = local_txs.pop_front() {
        let signer_id = admitted.signer_id;
        let board_epoch = admitted.board_epoch;
        match admitted.tx {
            LocalEntityTx::Financial(tx) => {
                let applied = apply_local_entity_financial_txs(
                    &mut state,
                    &mut paybook_changes,
                    vec![tx],
                    context,
                    local_account_views,
                    local_account_genesis_policy,
                    runtime_seed,
                )?;
                account_creates.extend(applied.account_creates);
                local_account_txs.extend(applied.account_txs);
                local_outputs.extend(applied.outputs);
                local_events.extend(applied.events);
                local_wake_targets.extend(applied.wake_targets);
                account_envelope_mutations.extend(applied.envelope_mutations);
                routed_entity_outputs.extend(applied.routed_entity_outputs);
                deltas.extend(applied.orderbook_deltas);
            }
            LocalEntityTx::Control(tx) => {
                let authority = entity_authority.ok_or_else(|| {
                    EntityKernelError::local("proposal", "ENTITY_GOVERNANCE_AUTHORITY_REQUIRED")
                })?;
                let applied = apply_local_entity_control_tx(
                    &mut state,
                    tx,
                    &mut local_events,
                    authority,
                    board_epoch,
                )?;
                j_outputs.extend(applied.j_outputs);
                local_hashes_to_sign.extend(applied.hashes_to_sign);
                for approved in applied.approved_entity_txs.into_iter().rev() {
                    local_txs.push_front(crate::AdmittedLocalEntityTx {
                        signer_id: signer_id.clone(),
                        board_epoch,
                        tx: approved,
                    });
                }
            }
            LocalEntityTx::CrossJurisdiction(tx) => {
                let authority = entity_authority.ok_or_else(|| {
                    EntityKernelError::local("crossJurisdiction", "ENTITY_AUTHORITY_REQUIRED")
                })?;
                let applied = apply_cross_jurisdiction_entity_txs(
                    &mut state,
                    local_account_views,
                    &[tx],
                    Some(&signer_id),
                    authority,
                )?;
                deltas.extend(applied.orderbook_deltas);
                for work in applied.proposal_work {
                    for tx in work.txs {
                        local_account_txs.push((work.account_id.clone(), tx));
                    }
                }
                account_envelope_mutations.extend(applied.account_envelope_mutations);
                routed_entity_outputs.extend(applied.outputs);
                local_events.extend(applied.events);
            }
            LocalEntityTx::RuntimeOutput(output) => {
                // Authorization observes the pre-output state, exactly like TS
                // applyRuntimeOutput. Only after the entire wrapper is proven
                // do its nested transactions execute in their original order.
                let authority = entity_authority.ok_or_else(|| {
                    EntityKernelError::local("runtimeOutput", "ENTITY_AUTHORITY_REQUIRED")
                })?;
                authorize_runtime_output(&state, &output, authority)?;
                // Re-enter the one canonical Entity dispatcher. In particular,
                // nested disputeStart is the same financial transition as a
                // locally admitted disputeStart; sending the whole wrapper to
                // cross_j used to strand it behind a second, incomplete path.
                for nested in output.entity_txs.into_iter().rev() {
                    let decoded = crate::decode_local_entity_tx(&nested)?.ok_or_else(|| {
                        EntityKernelError::local(
                            "runtimeOutput",
                            format!("NESTED_TX_UNSUPPORTED:{}", nested.kind.as_str()),
                        )
                    })?;
                    if matches!(decoded, LocalEntityTx::RuntimeOutput(_)) {
                        return Err(EntityKernelError::local(
                            "runtimeOutput",
                            "NESTED_RUNTIME_OUTPUT_FORBIDDEN",
                        ));
                    }
                    local_txs.push_front(crate::AdmittedLocalEntityTx {
                        signer_id: signer_id.clone(),
                        board_epoch,
                        tx: decoded,
                    });
                }
            }
        }
    }
    let mut seen_wake_targets = BTreeSet::new();
    local_wake_targets.retain(|target| seen_wake_targets.insert(target.clone()));
    let local_elapsed = local_started.elapsed();
    account_txs.extend(local_account_txs);
    outputs.extend(local_outputs);
    let orderbook_elapsed = Duration::ZERO;
    let group_started = Instant::now();
    let account_tx_count = account_txs.len();
    let proposal_work = group_proposal_work(account_txs);
    let group_elapsed = group_started.elapsed();
    if profile {
        eprintln!(
            "RSCORE_ENTITY_TRANSITION_PHASE preapply={} apply={} orderbook={} local={} group={} total={} commits={} transitions={} resolveTransitions={} resolveCommits={} lockTransitions={} lockNewFrames={} lockEnvelopes={} deltas={} accountTxs={} proposals={} paybookBefore={} paybookMutations={}",
            preapply_elapsed.as_micros(),
            apply_elapsed.as_micros(),
            orderbook_elapsed.as_micros(),
            local_elapsed.as_micros(),
            group_elapsed.as_micros(),
            total_started.elapsed().as_micros(),
            commit_count,
            transition_count,
            resolve_transition_count,
            resolve_commit_count,
            lock_transition_count,
            lock_new_frame_count,
            lock_envelope_count,
            deltas.len(),
            account_tx_count,
            proposal_work.len(),
            paybook_rows_before,
            paybook_changes.mutation_count(),
        );
    }
    Ok(EntityTransitionResult {
        state,
        account_creates,
        proposal_work,
        outputs,
        local_events,
        non_mutating_wake_targets: local_wake_targets,
        routed_entity_outputs,
        j_outputs,
        local_hashes_to_sign,
        account_envelope_mutations,
        paybook_changes,
        orderbook_deltas: deltas,
    })
}

pub(crate) struct PreparedEntityBookStage {
    orderbook: Option<PreparedOrderbookStage>,
}

impl PreparedEntityBookStage {
    pub(crate) fn take_orderbook_jobs(&mut self) -> Vec<OrderbookPairJob> {
        self.orderbook
            .as_mut()
            .map(PreparedOrderbookStage::take_jobs)
            .unwrap_or_default()
    }
}

pub(crate) fn prepare_orderbook_stage(
    result: &mut EntityTransitionResult,
    context: &DeterministicContext,
) -> Result<PreparedEntityBookStage, EntityKernelError> {
    if !result.orderbook_deltas.is_empty() && result.state.orderbook.is_none() {
        return Err(EntityKernelError::orderbook("ORDERBOOK_EXTENSION_REQUIRED"));
    }
    let orderbook = if let Some(orderbook) = &mut result.state.orderbook {
        Some(prepare_orderbook_outputs(
            orderbook,
            &result.orderbook_deltas,
            context,
            &result.state.entity_id,
            result
                .state
                .orderbook_metadata
                .as_ref()
                .map(|metadata| &metadata.hub_profile),
        )?)
    } else {
        None
    };
    Ok(PreparedEntityBookStage { orderbook })
}

pub(crate) fn finish_orderbook_stage(
    result: &mut EntityTransitionResult,
    prepared: PreparedEntityBookStage,
    pair_results: Vec<OrderbookPairResult>,
    scheduled_commands: &[SchedulerCommand],
) -> Result<(), EntityKernelError> {
    let mut account_txs = Vec::new();
    if let Some(prepared) = prepared.orderbook {
        let validated = validate_orderbook_outputs(prepared, pair_results)?;
        let orderbook = result
            .state
            .orderbook
            .as_mut()
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_EXTENSION_REQUIRED"))?;
        let effects = install_orderbook_outputs(orderbook, validated);
        account_txs.extend(effects.account_txs);
        result
            .routed_entity_outputs
            .extend(effects.routed_entity_outputs);
        for fill in effects.cross_jurisdiction_fills {
            let applied =
                crate::cross_j::commit_cross_jurisdiction_book_fill(&mut result.state, fill)?;
            for work in applied.proposal_work {
                account_txs.extend(work.txs.into_iter().map(|tx| (work.account_id.clone(), tx)));
            }
            result.routed_entity_outputs.extend(applied.outputs);
        }
        if effects.matched_swaps > 0 {
            result.outputs.push(EntityKernelOutput::SwapMatched {
                entity_id: result.state.entity_id.clone(),
                count: effects.matched_swaps,
            });
        }
    }
    append_scheduled_account_txs(scheduled_commands, &mut account_txs)?;
    append_scheduled_entity_outputs(
        &result.state,
        scheduled_commands,
        &mut result.routed_entity_outputs,
    )?;
    for appended in group_proposal_work(account_txs) {
        if let Some(existing) = result
            .proposal_work
            .iter_mut()
            .find(|existing| existing.account_id == appended.account_id)
        {
            existing.txs.extend(appended.txs);
        } else {
            result.proposal_work.push(appended);
        }
    }
    result.orderbook_deltas.clear();
    Ok(())
}

pub fn apply_entity_kernel(
    state: EntityStateSlice,
    commits: &[OrderedAccountCommit],
    context: &DeterministicContext,
) -> Result<EntityKernelResult, EntityKernelError> {
    let mut result = apply_entity_transitions(
        state,
        PaybookChanges::default(),
        commits.to_vec(),
        &BTreeSet::new(),
        Vec::new(),
        &BTreeMap::new(),
        None,
        None,
        None,
        context,
    )?;
    let mut prepared = prepare_orderbook_stage(&mut result, context)?;
    let pair_results = prepared
        .take_orderbook_jobs()
        .into_iter()
        .map(|job| job.apply(context))
        .collect();
    finish_orderbook_stage(&mut result, prepared, pair_results, &[])?;
    std::mem::take(&mut result.paybook_changes).commit_sequential(&mut result.state)?;
    let commitments = compute_commitments(&result.state, &result.proposal_work, &result.outputs)?;
    Ok(EntityKernelResult {
        state: result.state,
        proposal_work: result.proposal_work,
        outputs: result.outputs,
        commitments,
    })
}
