mod payment;

use num_bigint::BigInt;

use crate::delta::{MAX_ACCOUNT_TOKEN_ROWS, max_credit_limit};
use crate::mutation::MutationDecision;
use crate::{
    AccountRejection, AccountReplica, Side, TokenId, TransitionError, ValidationRejection,
};

pub(crate) use payment::{DirectPayment, direct_payment};

pub(crate) fn add_delta(
    replica: &mut AccountReplica,
    token_id: TokenId,
) -> Result<MutationDecision, TransitionError> {
    if replica.state().delta(token_id).is_some() {
        return Ok(MutationDecision::applied(Vec::new()));
    }
    let count = replica.state().delta_count();
    if count >= MAX_ACCOUNT_TOKEN_ROWS {
        let rejection = AccountRejection::DeltaRowLimitExceeded {
            attempted: count + 1,
            maximum: MAX_ACCOUNT_TOKEN_ROWS,
        };
        let message = rejection.message();
        return Ok(MutationDecision::rejected_with_events(
            rejection,
            vec![message],
        ));
    }
    replica
        .state_mut()
        .put_delta(crate::Delta::zero(token_id))?;
    Ok(MutationDecision::applied(vec![format!(
        "➕ Added token {token_id} to account"
    )]))
}

pub(crate) fn set_credit_limit(
    replica: &mut AccountReplica,
    token_id: TokenId,
    amount: &BigInt,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    if amount < &BigInt::from(0) {
        return Ok(rejected(ValidationRejection::CreditLimitNegative {
            amount: amount.clone(),
        }));
    }
    let maximum = max_credit_limit();
    if amount > &maximum {
        return Ok(rejected(ValidationRejection::CreditLimitAboveMaximum {
            amount: amount.clone(),
            maximum,
        }));
    }
    let existed = replica.state().delta(token_id).is_some();
    let mut delta = replica.state().delta_or_zero(token_id)?;
    delta.set_credit_limit(proposer, amount.clone());
    replica.state_mut().put_delta(delta)?;
    let mut events = Vec::with_capacity(2);
    if !existed {
        events.push(format!("📊 Created delta for token {token_id}"));
    }
    let side = if proposer == Side::Left {
        "Right"
    } else {
        "Left"
    };
    events.push(format!(
        "💳 {side} credit limit = {amount} for token {token_id}"
    ));
    Ok(MutationDecision::applied(events))
}

pub(crate) fn reserve_to_collateral() -> MutationDecision {
    rejected(ValidationRejection::ReserveToCollateralBlocked)
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}
