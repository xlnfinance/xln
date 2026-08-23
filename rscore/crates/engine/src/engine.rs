use crate::balance::{self, DirectPayment};
use crate::mutation::MutationDecision;
use crate::{AccountOutput, AccountRejection, AccountReplica, AccountTx, Side, TransitionError};

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
        let decision = apply_to_candidate(&mut candidate, proposer, tx)?;
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
            match apply_to_candidate(&mut candidate, *proposer, tx)? {
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
) -> Result<MutationDecision, TransitionError> {
    match tx {
        AccountTx::AddDelta { token_id } => balance::add_delta(candidate, *token_id),
        AccountTx::SetCreditLimit { token_id, amount } => {
            balance::set_credit_limit(candidate, *token_id, amount, proposer)
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
        | AccountTx::LendingClosePayout { .. } => crate::lending::apply(candidate, tx, proposer),
        AccountTx::ReserveToCollateral { .. } => Ok(balance::reserve_to_collateral()),
    }
}
