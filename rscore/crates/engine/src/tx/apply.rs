use crate::tx::apply_types::MutationDecision;
use crate::tx::handlers::balance::{self, DirectPayment};
use crate::{
    AccountExecutionContext, AccountOutput, AccountRejection, AccountReplica, AccountTx, Side,
    TransitionError,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountVerdict {
    Applied,
    Rejected(AccountRejection),
}

pub struct AccountTransition {
    verdict: AccountVerdict,
    candidate: Option<AccountReplica>,
    events: Vec<String>,
    outputs: Vec<AccountOutput>,
}

impl AccountTransition {
    pub const fn verdict(&self) -> &AccountVerdict {
        &self.verdict
    }

    pub fn candidate(&self) -> Option<&AccountReplica> {
        self.candidate.as_ref()
    }

    pub fn events(&self) -> &[String] {
        &self.events
    }

    pub fn outputs(&self) -> &[AccountOutput] {
        &self.outputs
    }

    pub fn committed(self) -> Option<AccountReplica> {
        self.candidate
    }

    fn applied(
        candidate: AccountReplica,
        events: Vec<String>,
        outputs: Vec<AccountOutput>,
    ) -> Self {
        Self {
            verdict: AccountVerdict::Applied,
            candidate: Some(candidate),
            events,
            outputs,
        }
    }

    fn rejected(rejection: AccountRejection, events: Vec<String>) -> Self {
        Self {
            verdict: AccountVerdict::Rejected(rejection),
            candidate: None,
            events,
            outputs: Vec::new(),
        }
    }
}

pub struct SequentialAccountEngine;

impl SequentialAccountEngine {
    pub fn apply(
        base: &AccountReplica,
        proposer: Side,
        tx: &AccountTx,
    ) -> Result<AccountTransition, TransitionError> {
        let mut candidate = base.clone();
        let decision = apply_to_candidate(&mut candidate, proposer, tx, None)?;
        Ok(transition_from_decision(candidate, decision))
    }

    pub fn apply_with_context(
        base: &AccountReplica,
        proposer: Side,
        tx: &AccountTx,
        context: &AccountExecutionContext,
    ) -> Result<AccountTransition, TransitionError> {
        validate_context(context)?;
        let mut candidate = base.clone();
        let decision = apply_to_candidate(&mut candidate, proposer, tx, Some(context))?;
        Ok(transition_from_decision(candidate, decision))
    }

    pub fn apply_atomic(
        base: &AccountReplica,
        transactions: &[(Side, AccountTx)],
    ) -> Result<AccountTransition, TransitionError> {
        let mut candidate = base.clone();
        let mut events = Vec::new();
        let mut outputs = Vec::new();
        for (proposer, tx) in transactions {
            match apply_to_candidate(&mut candidate, *proposer, tx, None)? {
                MutationDecision::Applied {
                    events: next_events,
                    outputs: next_outputs,
                    consensus_effects: _,
                } => {
                    events.extend(next_events);
                    outputs.extend(next_outputs);
                }
                MutationDecision::Rejected { rejection, events } => {
                    return Ok(AccountTransition::rejected(rejection, events));
                }
            }
        }
        Ok(AccountTransition::applied(candidate, events, outputs))
    }

    pub fn apply_atomic_with_context(
        base: &AccountReplica,
        transactions: &[(Side, AccountTx)],
        context: &AccountExecutionContext,
    ) -> Result<AccountTransition, TransitionError> {
        validate_context(context)?;
        let mut candidate = base.clone();
        let mut events = Vec::new();
        let mut outputs = Vec::new();
        for (proposer, tx) in transactions {
            match apply_to_candidate(&mut candidate, *proposer, tx, Some(context))? {
                MutationDecision::Applied {
                    events: next_events,
                    outputs: next_outputs,
                    consensus_effects: _,
                } => {
                    events.extend(next_events);
                    outputs.extend(next_outputs);
                }
                MutationDecision::Rejected { rejection, events } => {
                    return Ok(AccountTransition::rejected(rejection, events));
                }
            }
        }
        Ok(AccountTransition::applied(candidate, events, outputs))
    }
}

fn transition_from_decision(
    candidate: AccountReplica,
    decision: MutationDecision,
) -> AccountTransition {
    match decision {
        MutationDecision::Applied {
            events,
            outputs,
            consensus_effects: _,
        } => AccountTransition::applied(candidate, events, outputs),
        MutationDecision::Rejected { rejection, events } => {
            AccountTransition::rejected(rejection, events)
        }
    }
}

pub(crate) fn apply_to_candidate(
    candidate: &mut AccountReplica,
    proposer: Side,
    tx: &AccountTx,
    context: Option<&AccountExecutionContext>,
) -> Result<MutationDecision, TransitionError> {
    if let Some(crate::CanonicalValue::String(status)) = candidate.envelope().field("status")
        && status != "active"
    {
        // Parity target: mutation.ts rejects before routing every AccountTx.
        // Checking here, rather than only at local enqueue or peer ingress,
        // keeps direct execution, signed-frame validation and proposal work on
        // one freeze rule and prevents a late queued tx from crossing dispute.
        return Ok(MutationDecision::rejected(
            AccountRejection::ClosedForDispute {
                status: status.clone(),
                tx_type: tx.wire_name(),
            },
        ));
    }
    // Parity target: mutation.ts checks the signed-settlement freeze right
    // after the dispute status, still before routing. Without this gate a
    // Rust proposer would include a payment, lock or offer over a signed
    // workspace and the TypeScript validator would reject the frame.
    if let Some(rejection) = crate::tx::handlers::settlement::signed_workspace_freeze(candidate, tx)
    {
        return Ok(MutationDecision::rejected(rejection));
    }
    let previous_dispute_gas = super::dispute_gas_budget::charge(candidate)?;
    let decision = match tx {
        AccountTx::JEventClaim(tx) => {
            crate::tx::handlers::j_events::apply_j_event_claim(candidate, tx, proposer)
        }
        AccountTx::AddDelta { token_id } => balance::add_delta(candidate, *token_id),
        AccountTx::SetCreditLimit { token_id, amount } => {
            balance::set_credit_limit(candidate, *token_id, amount, proposer)
        }
        AccountTx::RebalancePolicy {
            token_id,
            policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
        } => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired(
                "rebalance_policy",
            ))?;
            crate::tx::handlers::rebalance::apply_policy(
                candidate,
                crate::tx::handlers::rebalance::RebalancePolicyTx {
                    token_id: *token_id,
                    policy_version: *policy_version,
                    base_fee,
                    liquidity_fee_bps,
                    gas_fee,
                },
                proposer,
                context.committed_timestamp,
            )
        }
        AccountTx::SwapOffer {
            offer_id,
            give_token_id,
            give_token_decimals,
            give_amount,
            want_token_id,
            want_token_decimals,
            want_amount,
            max_fee,
            min_net_receive,
            time_in_force,
            price_ticks,
            cross_jurisdiction,
        } => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired("swap_offer"))?;
            crate::swap::apply_offer(
                candidate,
                &context.swap_market,
                crate::swap::SwapOfferTx {
                    offer_id,
                    give_token_id: *give_token_id,
                    give_token_decimals: *give_token_decimals,
                    give_amount,
                    want_token_id: *want_token_id,
                    want_token_decimals: *want_token_decimals,
                    want_amount,
                    max_fee,
                    min_net_receive,
                    time_in_force: *time_in_force,
                    price_ticks: price_ticks.as_ref(),
                    cross_jurisdiction: cross_jurisdiction.as_ref(),
                },
                proposer,
                // core/account/tx/mutation.ts routes swap_offer with the
                // signed frame's J height, never the account frame height and
                // never the Entity enforcement clock.
                context.frame_j_height,
            )
        }
        AccountTx::SwapResolve {
            offer_id,
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            // The comment is carried only for the frame hash.
            comment: _,
            resting_give_token_id,
            resting_want_token_id,
            fee_token_id,
            fee_amount,
            execution_give_amount,
            execution_want_amount,
            resting_price_ticks,
            resting_give_amount,
            resting_want_amount,
            resting_quantized_give,
            resting_quantized_want,
        } => {
            let context =
                context.ok_or(TransitionError::ExecutionContextRequired("swap_resolve"))?;
            crate::swap::apply_resolve(
                candidate,
                &context.swap_market,
                crate::swap::SwapResolveTx {
                    offer_id,
                    fill_ratio: *fill_ratio,
                    fill_numerator: fill_numerator.clone(),
                    fill_denominator: fill_denominator.clone(),
                    cancel_remainder: *cancel_remainder,
                    resting_give_token_id: *resting_give_token_id,
                    resting_want_token_id: *resting_want_token_id,
                    fee_token_id: *fee_token_id,
                    fee_amount: fee_amount.clone(),
                    execution_give_amount: execution_give_amount.clone(),
                    execution_want_amount: execution_want_amount.clone(),
                    resting_price_ticks: resting_price_ticks.clone(),
                    resting_give_amount: resting_give_amount.clone(),
                    resting_want_amount: resting_want_amount.clone(),
                    resting_quantized_give: resting_quantized_give.clone(),
                    resting_quantized_want: resting_quantized_want.clone(),
                },
                proposer,
            )
        }
        AccountTx::SwapCancelRequest { offer_id } => {
            crate::swap::apply_cancel_request(candidate, offer_id, proposer)
        }
        AccountTx::DirectPayment {
            token_id,
            amount,
            route,
            description,
            from_entity_id,
            to_entity_id,
            delivery_mode,
            trusted_gateway_entity_id,
        } => balance::direct_payment(
            candidate,
            DirectPayment {
                token_id: *token_id,
                amount,
                route,
                description: description.as_ref(),
                from_entity_id,
                to_entity_id,
                delivery_mode: *delivery_mode,
                trusted_gateway_entity_id: trusted_gateway_entity_id.as_ref(),
            },
            proposer,
        ),
        AccountTx::LendingFund { .. }
        | AccountTx::LendingRate { .. }
        | AccountTx::LendingBorrowRequest { .. }
        | AccountTx::LendingRepay { .. }
        | AccountTx::LendingDisburse { .. }
        | AccountTx::LendingCloseRequest { .. }
        | AccountTx::LendingClosePayout { .. }
        | AccountTx::CreditRequest { .. } => {
            crate::tx::handlers::lending::apply(candidate, tx, proposer, context)
        }
        AccountTx::RequestCollateral {
            token_id,
            amount,
            fee_token_id,
            fee_amount,
            policy_version,
        } => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired(
                "request_collateral",
            ))?;
            crate::tx::handlers::rebalance::apply_request_collateral(
                candidate,
                proposer,
                *token_id,
                amount,
                *fee_token_id,
                fee_amount,
                *policy_version,
                context.committed_timestamp,
                context.current_account_height,
            )
        }
        AccountTx::RebalanceRefund {
            request_id,
            request_token_id,
            amount,
            reason,
        } => crate::tx::handlers::rebalance::apply_rebalance_refund(
            candidate,
            proposer,
            request_id,
            *request_token_id,
            amount,
            *reason,
        ),
        AccountTx::CrossPullLock { data } => {
            let context =
                context.ok_or(TransitionError::ExecutionContextRequired("cross_pull_lock"))?;
            crate::tx::handlers::cross_j::apply_pull_lock(
                candidate,
                data,
                proposer,
                // Pull.createdHeight follows the signed frame's J clock, as
                // does TS mutation.ts; Account height differs in R6 h43.
                context.frame_j_height,
                context.committed_timestamp,
            )
        }
        AccountTx::CrossPullClose { data } => {
            crate::tx::handlers::cross_j::apply_pull_close(candidate, data, proposer)
        }
        AccountTx::SettleTransition { data } => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired(
                "settle_transition",
            ))?;
            crate::tx::handlers::settlement::apply(candidate, data, proposer, context)
        }
        AccountTx::HtlcLock(tx) => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired("htlc_lock"))?;
            crate::tx::handlers::htlc::apply_lock(candidate, proposer, tx, context)
        }
        AccountTx::HtlcResolve(tx) => {
            let context =
                context.ok_or(TransitionError::ExecutionContextRequired("htlc_resolve"))?;
            crate::tx::handlers::htlc::apply_resolve(candidate, proposer, tx, context)
        }
    };
    let decision = sender_delta_rejection(decision)?;
    if matches!(&decision, MutationDecision::Applied { .. }) {
        let after = super::dispute_gas_budget::charge(candidate)?;
        if let Some(message) =
            super::dispute_gas_budget::admission_error(previous_dispute_gas, after, tx)
        {
            return Ok(MutationDecision::rejected_with_events(
                AccountRejection::Validation(crate::ValidationRejection::AccountTx {
                    message: message.clone(),
                }),
                vec![message],
            ));
        }
    }
    Ok(decision)
}

/// Parity target: `senderDeltaRejection` (core/account/tx/apply-result.ts).
/// The tx author chooses the token row, so inserting a 129th row is a typed
/// reject at this one router whichever handler drafted it (payment, HTLC
/// lock, swap, credit limit). Before, `delta_or_zero(..)?` made it a fatal
/// `TransitionError` and a peer frame could halt the Runtime.
fn sender_delta_rejection(
    decision: Result<MutationDecision, TransitionError>,
) -> Result<MutationDecision, TransitionError> {
    match decision {
        Err(TransitionError::InvalidState(crate::error::StateError::DeltaRowLimitExceeded {
            context: "insert",
            attempted,
            maximum,
        })) => {
            let rejection = AccountRejection::DeltaRowLimitExceeded { attempted, maximum };
            let message = rejection.message();
            Ok(MutationDecision::rejected_with_events(
                rejection,
                vec![message],
            ))
        }
        Err(error) if is_sender_lending_error(&error) => {
            // Parity target: core/account/tx/apply.ts (`senderFailureRejection`)
            // and credit-request.ts reject with the same ACCOUNT_TX_VALIDATION
            // text. Rejected-tx events are never committed.
            let message = error.to_string();
            Ok(MutationDecision::rejected_with_events(
                AccountRejection::Validation(crate::ValidationRejection::AccountTx {
                    message: message.clone(),
                }),
                vec![message],
            ))
        }
        other => other,
    }
}

/// The transaction author chooses every field these variants judge (role ids,
/// counterparty, intent id, amount, rate, credit-request id and token). A peer
/// frame carrying one is a rejected frame, never a Runtime fault.
const fn is_sender_lending_error(error: &TransitionError) -> bool {
    matches!(
        error,
        TransitionError::LendingRoleInvalid { .. }
            | TransitionError::LendingRoleNotProposer { .. }
            | TransitionError::LendingCounterpartyInvalid { .. }
            | TransitionError::LendingIntentIdInvalid(_)
            | TransitionError::LendingIntentReplay(_)
            | TransitionError::LendingAmountNotPositive { .. }
            | TransitionError::LendingInterestBpsInvalid(_)
            | TransitionError::CreditRequestIdInvalid(_)
            | TransitionError::CreditRequestRequesterNotProposer { .. }
            | TransitionError::CreditRequestTokenNotEnabled(_)
    )
}

fn validate_context(context: &AccountExecutionContext) -> Result<(), TransitionError> {
    for (field, value) in [
        ("committedTimestamp", context.committed_timestamp),
        ("enforcementTimestamp", context.enforcement_timestamp),
        ("enforcementJHeight", context.enforcement_j_height),
        ("currentAccountHeight", context.current_account_height),
    ] {
        if value > MAX_SAFE_INTEGER {
            return Err(TransitionError::ExecutionContextOutOfRange { field, value });
        }
    }
    Ok(())
}
