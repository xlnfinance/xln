use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;

use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::{
    LendingBorrowEntityTx, LendingClosePositionEntityTx, LendingOfferEntityTx,
    LendingRepayEntityTx, LocalAccountFinancialView,
};

fn valid_intent(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .and_then(|value| value.strip_prefix('-'))
        .is_some_and(|suffix| {
            suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn require_account(state: &EntityStateSlice, hub: &str) -> Result<(), EntityKernelError> {
    if !state.known_accounts.contains(hub) {
        return Err(EntityKernelError::lending("HUB_ACCOUNT_MISSING"));
    }
    Ok(())
}

fn queue(
    state: &EntityStateSlice,
    hub: String,
    tx: AccountTx,
    message: String,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) {
    account_txs.push((hub, tx));
    events.push(EntityFrameEvent::Status { message });
    wakes.push(state.entity_id.clone());
}

pub(super) fn apply_offer(
    state: &EntityStateSlice,
    tx: LendingOfferEntityTx,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.hub_entity_id)?;
    let view = views
        .get(&tx.hub_entity_id)
        .ok_or_else(|| EntityKernelError::lending("ACCOUNT_VIEW_MISSING"))?;
    if !valid_intent(&tx.position_id, "lend") {
        return Err(EntityKernelError::lending("INTENT_ID_INVALID"));
    }
    if tx.amount <= BigInt::from(0) {
        return Err(EntityKernelError::lending("FUND_AMOUNT_MUST_BE_POSITIVE"));
    }
    if !view.owner_out_capacity.contains_key(&tx.token_id) {
        return Err(EntityKernelError::lending("TOKEN_NOT_ENABLED"));
    }
    let hub = tx.hub_entity_id.clone();
    queue(
        state,
        hub.clone(),
        AccountTx::LendingFund {
            position_id: tx.position_id,
            hub_entity_id: hub,
            lender_entity_id: state.entity_id.clone(),
            token_id: tx.token_id,
            amount: tx.amount.clone(),
            term_id: tx.term_id,
            interest_bps: i64::from(tx.interest_bps),
        },
        format!(
            "Lending pool funding requested: {} token={}",
            tx.amount,
            tx.token_id.get()
        ),
        account_txs,
        events,
        wakes,
    );
    Ok(())
}

pub(super) fn apply_borrow(
    state: &EntityStateSlice,
    tx: LendingBorrowEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.hub_entity_id)?;
    if !valid_intent(&tx.request_id, "borrow") {
        return Err(EntityKernelError::lending("INTENT_ID_INVALID"));
    }
    if tx.amount <= BigInt::from(0) {
        return Err(EntityKernelError::lending("BORROW_AMOUNT_MUST_BE_POSITIVE"));
    }
    let hub = tx.hub_entity_id.clone();
    queue(
        state,
        hub.clone(),
        AccountTx::LendingBorrowRequest {
            request_id: tx.request_id,
            hub_entity_id: hub,
            borrower_entity_id: state.entity_id.clone(),
            token_id: tx.token_id,
            amount: tx.amount.clone(),
            term_id: tx.term_id,
            max_interest_bps: i64::from(tx.max_interest_bps),
        },
        format!("Loan requested: {} token={}", tx.amount, tx.token_id),
        account_txs,
        events,
        wakes,
    );
    Ok(())
}

pub(super) fn apply_repay(
    state: &EntityStateSlice,
    tx: LendingRepayEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.hub_entity_id)?;
    if !valid_intent(&tx.loan_id, "loan") {
        return Err(EntityKernelError::lending("INTENT_ID_INVALID"));
    }
    if tx.amount <= BigInt::from(0) {
        return Err(EntityKernelError::lending("REPAY_AMOUNT_MUST_BE_POSITIVE"));
    }
    let hub = tx.hub_entity_id.clone();
    let loan_id = tx.loan_id.clone();
    queue(
        state,
        hub.clone(),
        AccountTx::LendingRepay {
            loan_id: tx.loan_id,
            hub_entity_id: hub,
            borrower_entity_id: state.entity_id.clone(),
            token_id: tx.token_id,
            amount: tx.amount,
        },
        format!("Loan repayment requested: {loan_id}"),
        account_txs,
        events,
        wakes,
    );
    Ok(())
}

pub(super) fn apply_close(
    state: &EntityStateSlice,
    tx: LendingClosePositionEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wakes: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    require_account(state, &tx.hub_entity_id)?;
    if !valid_intent(&tx.position_id, "lend") {
        return Err(EntityKernelError::lending("INTENT_ID_INVALID"));
    }
    let hub = tx.hub_entity_id.clone();
    let position_id = tx.position_id.clone();
    queue(
        state,
        hub.clone(),
        AccountTx::LendingCloseRequest {
            position_id: tx.position_id,
            hub_entity_id: hub,
            lender_entity_id: state.entity_id.clone(),
        },
        format!("Lending position close requested: {position_id}"),
        account_txs,
        events,
        wakes,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use xln_rscore_engine::{LendingTermId, TokenId};

    use super::*;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn offer_projects_the_exact_typescript_account_transaction_and_wake() {
        let owner = entity("20");
        let hub = entity("10");
        let token = TokenId::new(1).expect("token");
        let mut state = EntityStateSlice::empty(owner.clone(), 1_000);
        state.known_accounts.insert(hub.clone());
        let views = BTreeMap::from([(
            hub.clone(),
            LocalAccountFinancialView {
                active: true,
                owner_side: xln_rscore_engine::Side::Left,
                owner_out_capacity: BTreeMap::from([(token, BigInt::from(20_000))]),
                owner_peer_credit_limit: BTreeMap::new(),
                settlement_workspace: None,
                settlement_transition_pending: false,
                settlement_execution: Err("SETTLEMENT_WORKSPACE_MISSING".into()),
                rebalance_active_quote: None,
                htlc_locks: BTreeMap::new(),
                pulls: BTreeMap::new(),
                swap_offers: BTreeMap::new(),
                pending_cross_pull_close_ids: Default::default(),
                pending_cross_swap_ack_ids: Default::default(),
                dispute: None,
            },
        )]);
        let (mut account_txs, mut events, mut wakes) = (Vec::new(), Vec::new(), Vec::new());
        apply_offer(
            &state,
            LendingOfferEntityTx {
                position_id: "lend-1111111111111111".into(),
                hub_entity_id: hub.clone(),
                token_id: token,
                amount: BigInt::from(1_000),
                term_id: LendingTermId::OneDay,
                interest_bps: 100,
            },
            &views,
            &mut account_txs,
            &mut events,
            &mut wakes,
        )
        .expect("offer");
        assert!(matches!(
            account_txs.as_slice(),
            [(target, AccountTx::LendingFund {
                position_id,
                lender_entity_id,
                amount,
                ..
            })] if target == &hub
                && position_id == "lend-1111111111111111"
                && lender_entity_id == &owner
                && amount == &BigInt::from(1_000)
        ));
        assert_eq!(wakes, vec![owner]);
        assert!(matches!(
            events.as_slice(),
            [EntityFrameEvent::Status { message }]
                if message == "Lending pool funding requested: 1000 token=1"
        ));
    }
}
