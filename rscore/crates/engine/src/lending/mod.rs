mod payment;
mod validation;

use num_bigint::BigInt;

use crate::balance::set_credit_limit;
use crate::mutation::MutationDecision;
use crate::{
    AccountReplica, AccountTx, LendingAction, LendingIntentKind, Side, TokenId, TransitionError,
};
use payment::{consume_if_applied, payment};
use validation::{
    consume_intent, normalize, positive_amount, require_counterparty, require_intent_id,
    require_role, require_unused_intent, validate_interest_bps,
};

pub(crate) fn apply(
    replica: &mut AccountReplica,
    tx: &AccountTx,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    match tx {
        AccountTx::LendingFund {
            position_id,
            hub_entity_id,
            lender_entity_id,
            token_id,
            amount,
            interest_bps,
            ..
        } => fund(
            replica,
            proposer,
            FundArgs {
                position_id,
                hub_entity_id,
                lender_entity_id,
                token_id: *token_id,
                amount,
                interest_bps: *interest_bps,
            },
        ),
        AccountTx::LendingBorrowRequest {
            request_id,
            hub_entity_id,
            borrower_entity_id,
            amount,
            max_interest_bps,
            ..
        } => borrow_request(
            replica,
            proposer,
            request_id,
            hub_entity_id,
            borrower_entity_id,
            amount,
            *max_interest_bps,
        ),
        AccountTx::LendingRepay {
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            amount,
        } => repay(
            replica,
            proposer,
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            *token_id,
            amount,
        ),
        AccountTx::LendingCredit {
            action,
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            token_id,
            credit_limit,
        } => credit(
            replica,
            proposer,
            *action,
            loan_id,
            hub_entity_id,
            borrower_entity_id,
            *token_id,
            credit_limit,
        ),
        AccountTx::LendingCloseRequest {
            position_id,
            hub_entity_id,
            lender_entity_id,
        } => close_request(
            replica,
            proposer,
            position_id,
            hub_entity_id,
            lender_entity_id,
        ),
        AccountTx::LendingClosePayout {
            position_id,
            hub_entity_id,
            lender_entity_id,
            token_id,
            amount,
        } => close_payout(
            replica,
            proposer,
            position_id,
            hub_entity_id,
            lender_entity_id,
            *token_id,
            amount,
        ),
        _ => Err(TransitionError::LendingRouteMismatch),
    }
}

struct FundArgs<'a> {
    position_id: &'a str,
    hub_entity_id: &'a str,
    lender_entity_id: &'a str,
    token_id: TokenId,
    amount: &'a BigInt,
    interest_bps: i64,
}

fn fund(
    replica: &mut AccountReplica,
    proposer: Side,
    args: FundArgs<'_>,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(args.position_id, "lend")?;
    require_role(replica, proposer, "LENDER", args.lender_entity_id)?;
    require_counterparty(replica, args.lender_entity_id, args.hub_entity_id)?;
    positive_amount(args.amount, "LENDING_FUND")?;
    validate_interest_bps(args.interest_bps)?;
    let key = format!("fund:{}", normalize(args.position_id));
    require_unused_intent(replica, &key)?;
    let result = payment(
        replica,
        proposer,
        args.token_id,
        args.amount,
        args.lender_entity_id,
        args.hub_entity_id,
        "lending_fund",
    )?;
    consume_if_applied(replica, result, key, LendingIntentKind::Fund)
}

fn borrow_request(
    replica: &mut AccountReplica,
    proposer: Side,
    request_id: &str,
    hub: &str,
    borrower: &str,
    amount: &BigInt,
    interest_bps: i64,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(request_id, "borrow")?;
    require_role(replica, proposer, "BORROWER", borrower)?;
    require_counterparty(replica, borrower, hub)?;
    positive_amount(amount, "LENDING_BORROW")?;
    validate_interest_bps(interest_bps)?;
    consume_intent(
        replica,
        format!("borrow:{}", normalize(request_id)),
        LendingIntentKind::Borrow,
    )?;
    Ok(MutationDecision::applied(vec![format!(
        "Lending borrow request {request_id} committed"
    )]))
}

#[allow(clippy::too_many_arguments)]
fn repay(
    replica: &mut AccountReplica,
    proposer: Side,
    loan_id: &str,
    hub: &str,
    borrower: &str,
    token_id: TokenId,
    amount: &BigInt,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(loan_id, "loan")?;
    require_role(replica, proposer, "BORROWER", borrower)?;
    require_counterparty(replica, borrower, hub)?;
    positive_amount(amount, "LENDING_REPAY")?;
    let key = format!("repay:{}", normalize(loan_id));
    require_unused_intent(replica, &key)?;
    let result = payment(
        replica,
        proposer,
        token_id,
        amount,
        borrower,
        hub,
        "lending_repay",
    )?;
    consume_if_applied(replica, result, key, LendingIntentKind::Repay)
}

#[allow(clippy::too_many_arguments)]
fn credit(
    replica: &mut AccountReplica,
    proposer: Side,
    action: LendingAction,
    loan_id: &str,
    hub: &str,
    borrower: &str,
    token_id: TokenId,
    credit_limit: &BigInt,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(loan_id, "loan")?;
    require_role(replica, proposer, "HUB", hub)?;
    require_counterparty(replica, hub, borrower)?;
    if credit_limit < &BigInt::from(0) {
        return Err(TransitionError::LendingCreditLimitNegative(
            credit_limit.clone(),
        ));
    }
    let result = set_credit_limit(replica, token_id, credit_limit, proposer)?;
    let (prefix, kind) = match action {
        LendingAction::Grant => ("grant", LendingIntentKind::CreditGrant),
        LendingAction::Revoke => ("revoke", LendingIntentKind::CreditRevoke),
    };
    consume_if_applied(
        replica,
        result,
        format!("{prefix}:{}", normalize(loan_id)),
        kind,
    )
}

fn close_request(
    replica: &mut AccountReplica,
    proposer: Side,
    position_id: &str,
    hub: &str,
    lender: &str,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(position_id, "lend")?;
    require_role(replica, proposer, "LENDER", lender)?;
    require_counterparty(replica, lender, hub)?;
    consume_intent(
        replica,
        format!("close:{}", normalize(position_id)),
        LendingIntentKind::CloseRequest,
    )?;
    Ok(MutationDecision::applied(vec![format!(
        "Lending close request {position_id} committed"
    )]))
}

#[allow(clippy::too_many_arguments)]
fn close_payout(
    replica: &mut AccountReplica,
    proposer: Side,
    position_id: &str,
    hub: &str,
    lender: &str,
    token_id: TokenId,
    amount: &BigInt,
) -> Result<MutationDecision, TransitionError> {
    require_intent_id(position_id, "lend")?;
    require_role(replica, proposer, "HUB", hub)?;
    require_counterparty(replica, hub, lender)?;
    positive_amount(amount, "LENDING_CLOSE_PAYOUT")?;
    let key = format!("payout:{}", normalize(position_id));
    require_unused_intent(replica, &key)?;
    let result = payment(
        replica,
        proposer,
        token_id,
        amount,
        hub,
        lender,
        "lending_close_payout",
    )?;
    consume_if_applied(replica, result, key, LendingIntentKind::ClosePayout)
}
