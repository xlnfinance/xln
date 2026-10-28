mod covenants;
mod credit_request;
mod validation;

use crate::tx::apply_types::MutationDecision;
use crate::{AccountReplica, AccountTx, Side, TransitionError};

pub(crate) fn apply(
    replica: &mut AccountReplica,
    tx: &AccountTx,
    proposer: Side,
    context: Option<&crate::AccountExecutionContext>,
) -> Result<MutationDecision, TransitionError> {
    match tx {
        AccountTx::CreditRequest {
            request_id,
            requester_entity_id,
            token_id,
            amount,
        } => credit_request::apply(
            replica,
            proposer,
            request_id,
            requester_entity_id,
            *token_id,
            amount,
        ),
        AccountTx::LendingFund { .. }
        | AccountTx::LendingRate { .. }
        | AccountTx::LendingBorrowRequest { .. }
        | AccountTx::LendingRepay { .. }
        | AccountTx::LendingDisburse { .. }
        | AccountTx::LendingCloseRequest { .. }
        | AccountTx::LendingClosePayout { .. } => covenants::apply(
            replica,
            tx,
            proposer,
            context
                .ok_or(TransitionError::ExecutionContextRequired(tx.wire_name()))?
                .committed_timestamp,
        ),
        _ => Err(TransitionError::LendingRouteMismatch),
    }
}
