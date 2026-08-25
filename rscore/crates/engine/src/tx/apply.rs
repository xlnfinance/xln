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
        MutationDecision::Applied { events, outputs } => {
            AccountTransition::applied(candidate, events, outputs)
        }
        MutationDecision::Rejected { rejection, events } => {
            AccountTransition::rejected(rejection, events)
        }
    }
}

fn apply_to_candidate(
    candidate: &mut AccountReplica,
    proposer: Side,
    tx: &AccountTx,
    context: Option<&AccountExecutionContext>,
) -> Result<MutationDecision, TransitionError> {
    match tx {
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
            // Carried for the frame hash; the transition does not read them.
            comment: _,
            resting_give_token_id: _,
            resting_want_token_id: _,
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
        | AccountTx::LendingBorrowRequest { .. }
        | AccountTx::LendingRepay { .. }
        | AccountTx::LendingCredit { .. }
        | AccountTx::LendingCloseRequest { .. }
        | AccountTx::LendingClosePayout { .. } => {
            crate::tx::handlers::lending::apply(candidate, tx, proposer)
        }
        AccountTx::ReserveToCollateral { .. } => Ok(balance::reserve_to_collateral()),
        AccountTx::HtlcLock(tx) => {
            let context = context.ok_or(TransitionError::ExecutionContextRequired("htlc_lock"))?;
            crate::tx::handlers::htlc::apply_lock(candidate, proposer, tx, context)
        }
        AccountTx::HtlcResolve(tx) => {
            let context =
                context.ok_or(TransitionError::ExecutionContextRequired("htlc_resolve"))?;
            crate::tx::handlers::htlc::apply_resolve(candidate, proposer, tx, context)
        }
    }
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
