mod credit_request;
mod validation;

use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountRejection, AccountReplica, AccountTx, Side, TransitionError, ValidationRejection,
};

pub(crate) fn apply(
    replica: &mut AccountReplica,
    tx: &AccountTx,
    proposer: Side,
    _context: Option<&crate::AccountExecutionContext>,
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
        // TS signed bank covenants are not implemented here. Reject before touching
        // money, intent nonces or outputs; the retired pool model is not parity.
        AccountTx::LendingFund { .. }
        | AccountTx::LendingRate { .. }
        | AccountTx::LendingBorrowRequest { .. }
        | AccountTx::LendingRepay { .. }
        | AccountTx::LendingDisburse { .. }
        | AccountTx::LendingCloseRequest { .. }
        | AccountTx::LendingClosePayout { .. } => Ok(MutationDecision::rejected(
            AccountRejection::Validation(ValidationRejection::AccountTx {
                message: format!("LENDING_UNSUPPORTED:{}", tx.wire_name()),
            }),
        )),
        _ => Err(TransitionError::LendingRouteMismatch),
    }
}
