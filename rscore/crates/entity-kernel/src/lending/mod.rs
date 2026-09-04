mod codec;
mod followups;
mod state;
mod terminal;

use xln_rscore_engine::AccountTx;

use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;
use crate::{EntityKernelError, EntityStateSlice, OrderedAccountCommit};

pub use codec::decode_canonical_lending_state;
pub use state::{
    LendingLoan, LendingLoanStatus, LendingPoolPosition, LendingPoolStatus, LendingState,
    canonical_lending_state,
};

fn hub_entity_id(tx: &AccountTx) -> &str {
    match tx {
        AccountTx::LendingFund { hub_entity_id, .. }
        | AccountTx::LendingBorrowRequest { hub_entity_id, .. }
        | AccountTx::LendingRepay { hub_entity_id, .. }
        | AccountTx::LendingCredit { hub_entity_id, .. }
        | AccountTx::LendingCloseRequest { hub_entity_id, .. }
        | AccountTx::LendingClosePayout { hub_entity_id, .. } => hub_entity_id,
        _ => unreachable!("lending transaction required"),
    }
}

pub(crate) fn apply_committed_lending_followup(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    transition: &crate::CommittedAccountTransition,
    account_view: Option<&LocalAccountFinancialView>,
    account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<bool, EntityKernelError> {
    if !matches!(
        transition.tx,
        AccountTx::LendingFund { .. }
            | AccountTx::LendingBorrowRequest { .. }
            | AccountTx::LendingRepay { .. }
            | AccountTx::LendingCredit { .. }
            | AccountTx::LendingCloseRequest { .. }
            | AccountTx::LendingClosePayout { .. }
    ) {
        return Ok(false);
    }
    followups::require_empty_outputs(transition)?;
    let hub = state.entity_id.clone();
    if !state.profile.is_hub || hub_entity_id(&transition.tx) != hub {
        return Ok(true);
    }
    let proposer = if commit.committed_via_new_frame {
        commit.account_id.as_str()
    } else {
        hub.as_str()
    };
    let now = commit.frame_timestamp.max(state.timestamp);
    let lending = state.lending.get_or_insert_with(LendingState::empty);
    match &transition.tx {
        tx @ AccountTx::LendingFund { .. } => {
            followups::apply_fund(lending, tx, proposer, &commit.account_id, &hub, now)?
        }
        tx @ AccountTx::LendingBorrowRequest { .. } => followups::apply_borrow(
            lending,
            tx,
            proposer,
            &commit.account_id,
            &hub,
            now,
            &commit.account_id,
            account_view.ok_or_else(|| EntityKernelError::lending("ACCOUNT_VIEW_MISSING"))?,
            account_txs,
        )?,
        tx @ AccountTx::LendingCredit { .. } => {
            followups::apply_credit(lending, tx, proposer, &hub, now)?
        }
        tx @ AccountTx::LendingRepay { .. } => terminal::apply_repay(
            lending,
            tx,
            proposer,
            &commit.account_id,
            &hub,
            now,
            account_view.ok_or_else(|| EntityKernelError::lending("ACCOUNT_VIEW_MISSING"))?,
            account_txs,
        )?,
        tx @ AccountTx::LendingCloseRequest { .. } => terminal::apply_close_request(
            lending,
            tx,
            proposer,
            &commit.account_id,
            &hub,
            now,
            account_view.ok_or_else(|| EntityKernelError::lending("ACCOUNT_VIEW_MISSING"))?,
            account_txs,
        )?,
        tx @ AccountTx::LendingClosePayout { .. } => {
            terminal::apply_close_payout(lending, tx, proposer, &hub, now)?
        }
        _ => unreachable!(),
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use num_bigint::BigInt;
    use xln_rscore_engine::{
        AccountDomain, AccountTx, DepositoryAddress, LendingAction, LendingTermId, TokenId,
    };

    use super::*;
    use crate::{CommittedAccountTransition, JurisdictionScope};

    const HUB: &str = "0x1010101010101010101010101010101010101010101010101010101010101010";
    const LENDER: &str = "0x2020202020202020202020202020202020202020202020202020202020202020";
    const BORROWER: &str = "0x3030303030303030303030303030303030303030303030303030303030303030";

    fn token() -> TokenId {
        TokenId::new(1).expect("token")
    }

    fn commit(
        account_id: &str,
        timestamp: u64,
        local: bool,
        tx: AccountTx,
    ) -> OrderedAccountCommit {
        OrderedAccountCommit {
            account_id: account_id.to_string(),
            domain: AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            scope: JurisdictionScope::Same,
            committed_via_new_frame: !local,
            frame_state_hash: format!("0x{}", "55".repeat(32)),
            frame_height: timestamp,
            frame_timestamp: timestamp,
            inbound_position: 0,
            transitions: vec![CommittedAccountTransition {
                tx,
                outputs: Vec::new(),
            }],
        }
    }

    fn apply(
        state: &mut EntityStateSlice,
        commit: OrderedAccountCommit,
        view: Option<&LocalAccountFinancialView>,
        queued: &mut Vec<TargetedAccountTx>,
    ) {
        let transition = commit.transitions[0].clone();
        assert!(
            apply_committed_lending_followup(state, &commit, &transition, view, queued)
                .expect("lending followup")
        );
    }

    #[test]
    fn exact_ts_fund_borrow_repay_and_close_lifecycle() {
        let mut state = EntityStateSlice::empty(HUB, 1_000);
        state.profile.is_hub = true;
        state
            .known_accounts
            .extend([LENDER.to_string(), BORROWER.to_string()]);
        let view = LocalAccountFinancialView {
            active: true,
            owner_side: xln_rscore_engine::Side::Left,
            owner_out_capacity: BTreeMap::from([(token(), BigInt::from(50_000))]),
            owner_peer_credit_limit: BTreeMap::from([(token(), BigInt::from(20_000))]),
            settlement_workspace: None,
            settlement_transition_pending: false,
            settlement_execution: Err("SETTLEMENT_WORKSPACE_MISSING".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::new(),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: Default::default(),
            dispute: None,
        };
        let mut queued = Vec::new();

        apply(
            &mut state,
            commit(
                LENDER,
                1_000,
                false,
                AccountTx::LendingFund {
                    position_id: "lend-1111111111111111".into(),
                    hub_entity_id: HUB.into(),
                    lender_entity_id: LENDER.into(),
                    token_id: token(),
                    amount: BigInt::from(10_000),
                    term_id: LendingTermId::OneDay,
                    interest_bps: 100,
                },
            ),
            None,
            &mut queued,
        );
        apply(
            &mut state,
            commit(
                BORROWER,
                2_000,
                false,
                AccountTx::LendingBorrowRequest {
                    request_id: "borrow-2222222222222222".into(),
                    hub_entity_id: HUB.into(),
                    borrower_entity_id: BORROWER.into(),
                    token_id: 1,
                    amount: BigInt::from(2_500),
                    term_id: LendingTermId::OneDay,
                    max_interest_bps: 150,
                },
            ),
            Some(&view),
            &mut queued,
        );
        let grant = queued.pop().expect("grant").1;
        let AccountTx::LendingCredit {
            loan_id,
            credit_limit,
            ..
        } = &grant
        else {
            panic!("grant")
        };
        assert_eq!(loan_id, "loan-0327fd9035d42518");
        assert_eq!(credit_limit, &BigInt::from(22_500));
        apply(
            &mut state,
            commit(BORROWER, 2_001, true, grant),
            None,
            &mut queued,
        );

        let loan_id = "loan-0327fd9035d42518".to_string();
        apply(
            &mut state,
            commit(
                BORROWER,
                3_000,
                false,
                AccountTx::LendingRepay {
                    loan_id: loan_id.clone(),
                    hub_entity_id: HUB.into(),
                    borrower_entity_id: BORROWER.into(),
                    token_id: token(),
                    amount: BigInt::from(2_525),
                },
            ),
            Some(&LocalAccountFinancialView {
                active: true,
                owner_side: xln_rscore_engine::Side::Left,
                owner_out_capacity: BTreeMap::new(),
                owner_peer_credit_limit: BTreeMap::from([(token(), BigInt::from(22_500))]),
                settlement_workspace: None,
                settlement_transition_pending: false,
                settlement_execution: Err("SETTLEMENT_WORKSPACE_MISSING".into()),
                rebalance_active_quote: None,
                htlc_locks: BTreeMap::new(),
                pulls: BTreeMap::new(),
                swap_offers: BTreeMap::new(),
                pending_cross_pull_close_ids: Default::default(),
                dispute: None,
            }),
            &mut queued,
        );
        let revoke = queued.pop().expect("revoke").1;
        assert!(matches!(
            &revoke,
            AccountTx::LendingCredit {
                action: LendingAction::Revoke,
                credit_limit,
                ..
            } if credit_limit == &BigInt::from(20_000)
        ));
        apply(
            &mut state,
            commit(BORROWER, 3_001, true, revoke),
            None,
            &mut queued,
        );
        let loan = state.lending.as_ref().unwrap().loan(&loan_id).unwrap();
        assert_eq!(loan.status, LendingLoanStatus::Repaid);
        assert_eq!(loan.repaid_amount, BigInt::from(2_525));

        apply(
            &mut state,
            commit(
                LENDER,
                4_000,
                false,
                AccountTx::LendingCloseRequest {
                    position_id: "lend-1111111111111111".into(),
                    hub_entity_id: HUB.into(),
                    lender_entity_id: LENDER.into(),
                },
            ),
            Some(&view),
            &mut queued,
        );
        let payout = queued.pop().expect("payout").1;
        apply(
            &mut state,
            commit(LENDER, 4_001, true, payout),
            None,
            &mut queued,
        );
        let pool = state
            .lending
            .as_ref()
            .unwrap()
            .pool("lend-1111111111111111")
            .unwrap();
        assert_eq!(pool.status, LendingPoolStatus::Closed);
        assert_eq!(pool.available_amount, BigInt::from(0));
        assert_eq!(pool.borrowed_amount, BigInt::from(0));
    }
}
