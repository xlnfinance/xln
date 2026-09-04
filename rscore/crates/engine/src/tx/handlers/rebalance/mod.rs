pub(crate) mod policy;

use num_bigint::BigInt;

use crate::state::{RebalanceRefundState, RebalanceRequestFeeState};
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountOutput, AccountRejection, AccountReplica, RebalanceRefundReason, Side, TokenId,
    TransitionError, ValidationRejection,
};

pub use policy::*;

fn reject(message: impl Into<String>) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(
        ValidationRejection::AccountTx {
            message: message.into(),
        },
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_request_collateral(
    replica: &mut AccountReplica,
    proposer: Side,
    token_id: TokenId,
    amount: &BigInt,
    fee_token_id: Option<TokenId>,
    fee_amount: &BigInt,
    policy_version: u64,
    timestamp: u64,
    current_height: u64,
) -> Result<MutationDecision, TransitionError> {
    if amount <= &BigInt::from(0) {
        return Ok(reject("request_collateral: amount must be > 0"));
    }
    if fee_amount < &BigInt::from(0) {
        return Ok(reject("request_collateral: feeAmount must be >= 0"));
    }
    if policy_version < 1 {
        return Ok(reject(format!(
            "request_collateral: invalid policyVersion {policy_version}"
        )));
    }
    if replica.state().delta(token_id).is_none() {
        return Ok(reject(format!(
            "request_collateral: no delta for token {token_id}"
        )));
    }
    if let Some(existing) = replica.state().requested_rebalance(token_id)
        && existing > &BigInt::from(0)
    {
        return Ok(MutationDecision::applied(vec![format!(
            "ℹ️ request_collateral skipped: pending request is immutable token={token_id} amount={existing}"
        )]));
    }
    if fee_amount <= &BigInt::from(0) {
        return Ok(reject(
            "request_collateral: feeAmount must produce effectiveFee > 0",
        ));
    }
    let fee_token = fee_token_id.unwrap_or(token_id);
    let Some(fee_delta) = replica.state().delta(fee_token) else {
        return Ok(reject(format!(
            "request_collateral: no delta for fee token {fee_token}"
        )));
    };
    let effective_request = if fee_token == token_id {
        (amount - fee_amount).max(BigInt::from(0))
    } else {
        amount.clone()
    };
    if effective_request <= BigInt::from(0) {
        return Ok(MutationDecision::applied(vec![format!(
            "ℹ️ Collateral request skipped: prepaid fee consumes the full request (fee={fee_amount}, token={fee_token})"
        )]));
    }
    let available = fee_delta.perspective(proposer).out_capacity;
    if fee_amount > &available {
        return Ok(reject(format!(
            "request_collateral: insufficient fee capacity in token {fee_token} ({available} < {fee_amount})"
        )));
    }
    let mut next_delta = fee_delta.clone();
    next_delta.apply_transfer(proposer, fee_amount)?;
    replica.state_mut().put_delta(next_delta)?;
    replica
        .state_mut()
        .put_requested_rebalance(token_id, effective_request.clone())?;
    replica.state_mut().put_requested_rebalance_fee_state(
        token_id,
        RebalanceRequestFeeState {
            request_id: format!(
                "rebalance:{}:{token_id}:{}",
                if proposer == Side::Left {
                    "left"
                } else {
                    "right"
                },
                current_height + 1
            ),
            fee_token_id: fee_token,
            fee_paid_upfront: fee_amount.clone(),
            requested_amount: effective_request.clone(),
            policy_version,
            requested_at: timestamp,
            requested_by_left: proposer == Side::Left,
            refund: None,
        },
    )?;
    Ok(MutationDecision::with_outputs(
        vec![format!(
            "🔄 Collateral requested: {effective_request} token {token_id}, prepaidFee={fee_amount} (hub will deposit R→C)"
        )],
        vec![AccountOutput::RequestCollateralCommitted {
            entity_id: replica.owner().to_string(),
            account_id: replica.counterparty().to_string(),
            token_id,
            requested_amount: effective_request,
            prepaid_fee: fee_amount.clone(),
            requested_at: timestamp,
        }],
    ))
}

pub(crate) fn apply_rebalance_refund(
    replica: &mut AccountReplica,
    proposer: Side,
    request_id: &str,
    request_token_id: TokenId,
    amount: &BigInt,
    reason: RebalanceRefundReason,
) -> Result<MutationDecision, TransitionError> {
    if request_id.is_empty() || amount <= &BigInt::from(0) {
        return Ok(reject(
            "rebalance_refund: requestId and positive amount required",
        ));
    }
    let Some(fee_state) = replica
        .state()
        .requested_rebalance_fee_state(request_token_id)
        .cloned()
    else {
        return Ok(reject(format!(
            "rebalance_refund: pending request not found ({request_id})"
        )));
    };
    let requested = replica
        .state()
        .requested_rebalance(request_token_id)
        .cloned()
        .unwrap_or_default();
    if requested <= BigInt::from(0) || fee_state.request_id != request_id {
        return Ok(reject(format!(
            "rebalance_refund: pending request not found ({request_id})"
        )));
    }
    if (proposer == Side::Left) == fee_state.requested_by_left {
        return Ok(reject("rebalance_refund: requester cannot refund itself"));
    }
    if fee_state
        .refund
        .as_ref()
        .is_some_and(|refund| refund.reason != reason)
    {
        return Ok(reject(
            "rebalance_refund: reason conflicts with partial refund",
        ));
    }
    let refunded = fee_state
        .refund
        .as_ref()
        .map_or_else(BigInt::default, |value| value.refunded_amount.clone());
    let outstanding = &fee_state.fee_paid_upfront - &refunded;
    if outstanding <= BigInt::from(0) {
        return Err(crate::StateError::TransitionFailed(format!(
            "REBALANCE_REFUND_STATE_CORRUPT:{request_id}"
        ))
        .into());
    }
    if amount > &outstanding {
        return Ok(reject(format!(
            "rebalance_refund: amount {amount} exceeds outstanding {outstanding}"
        )));
    }
    let Some(delta) = replica.state().delta(fee_state.fee_token_id) else {
        return Ok(reject(format!(
            "rebalance_refund: fee token {} missing",
            fee_state.fee_token_id
        )));
    };
    let available = delta.perspective(proposer).out_capacity;
    if amount > &available {
        return Ok(reject(format!(
            "rebalance_refund: insufficient capacity ({available} < {amount})"
        )));
    }
    let mut next_delta = delta.clone();
    next_delta.apply_transfer(proposer, amount)?;
    replica.state_mut().put_delta(next_delta)?;
    let next_refunded = refunded + amount;
    if next_refunded == fee_state.fee_paid_upfront {
        replica
            .state_mut()
            .remove_requested_rebalance(request_token_id)?;
    } else {
        let total = fee_state.fee_paid_upfront.clone();
        replica.state_mut().put_requested_rebalance_fee_state(
            request_token_id,
            RebalanceRequestFeeState {
                refund: Some(RebalanceRefundState {
                    reason,
                    refunded_amount: next_refunded.clone(),
                }),
                ..fee_state
            },
        )?;
        return Ok(MutationDecision::applied(vec![format!(
            "Rebalance refund {request_id}: {next_refunded}/{total}"
        )]));
    }
    Ok(MutationDecision::applied(vec![format!(
        "Rebalance refund {request_id}: {next_refunded}/{next_refunded}"
    )]))
}
