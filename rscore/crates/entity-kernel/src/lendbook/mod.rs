mod codec;
mod followups;
mod state;
mod terminal;

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, TokenId};

use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;
use crate::{EntityKernelError, EntityStateSlice, OrderedAccountCommit};

pub use codec::decode_canonical_lending_state;
pub use state::{
    LendingLoan, LendingLoanStatus, LendingPoolPosition, LendingPoolStatus, LendingState,
    canonical_lending_state,
};

/// One loan whose committed term has passed unpaid, with the hub's committed
/// credit grant on the borrower Account. The caller reads the grant where the
/// Account views live; the transition itself stays pure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverdueLendingLoan {
    pub loan_id: String,
    pub borrower_entity_id: String,
    pub token_id: TokenId,
    pub committed_credit_limit: BigInt,
}

/// Loans due for settlement, in derived-deadline order — `(due_at, loan id)`,
/// exactly the order TS `collectDerivedDeadlines` drains them in.
pub fn overdue_lending_loans(
    state: &EntityStateSlice,
    now: u64,
) -> Result<Vec<(String, String, TokenId)>, EntityKernelError> {
    let Some(lending) = state.lending.as_ref() else {
        return Ok(Vec::new());
    };
    let mut rows = lending
        .loans()
        .filter(|loan| loan.status == LendingLoanStatus::Active && loan.due_at <= now)
        .map(|loan| {
            Ok((
                loan.due_at,
                loan.loan_id.clone(),
                loan.borrower_entity_id.clone(),
                TokenId::new(u32::from(loan.token_id))
                    .map_err(|_| EntityKernelError::lending("TOKEN_ID"))?,
            ))
        })
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    rows.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(rows
        .into_iter()
        .map(|(_, loan_id, borrower, token)| (loan_id, borrower, token))
        .collect())
}

/// Settle every overdue loan of this Entity. See `terminal::settle_overdue`.
pub fn settle_overdue_lending_loans(
    state: &mut EntityStateSlice,
    loans: &[OverdueLendingLoan],
    _account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let now = state.timestamp;
    let Some(lending) = state.lending.as_mut() else {
        return Ok(());
    };
    for loan in loans {
        terminal::settle_overdue(lending, &loan.loan_id, now)?;
    }
    Ok(())
}

fn hub_entity_id(tx: &AccountTx) -> &str {
    match tx {
        AccountTx::LendingFund { hub_entity_id, .. }
        | AccountTx::LendingBorrowRequest { hub_entity_id, .. }
        | AccountTx::LendingRepay { hub_entity_id, .. }
        | AccountTx::LendingDisburse { hub_entity_id, .. }
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
            | AccountTx::LendingDisburse { .. }
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
            account_txs,
        )?,
        tx @ AccountTx::LendingDisburse { .. } => {
            followups::apply_disburse(lending, tx, proposer, &hub, now)?
        }
        tx @ AccountTx::LendingRepay { .. } => {
            terminal::apply_repay(lending, tx, proposer, &commit.account_id, now)?
        }
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
    use xln_rscore_engine::{AccountDomain, AccountTx, DepositoryAddress, LendingTermId, TokenId};

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
        let AccountTx::LendingDisburse {
            loan_id, amount, ..
        } = &grant
        else {
            panic!("grant")
        };
        assert_eq!(loan_id, "loan-0327fd9035d42518");
        assert_eq!(amount, &BigInt::from(2_500));
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
        assert!(queued.is_empty());
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

    /// Same fixture and same numbers as the TypeScript
    /// `an overdue loan defaults` case in
    /// core/__tests__/finance/state/lending.test.ts.
    #[test]
    fn exact_ts_overdue_loan_default_settlement() {
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
        apply(
            &mut state,
            commit(BORROWER, 2_001, true, grant),
            None,
            &mut queued,
        );
        let loan_id = "loan-0327fd9035d42518".to_string();
        let due_at = state
            .lending
            .as_ref()
            .unwrap()
            .loan(&loan_id)
            .unwrap()
            .due_at;
        assert_eq!(due_at, 2_000 + 86_400_000);

        // Nothing is due before the term ends.
        assert!(
            overdue_lending_loans(&state, due_at - 1)
                .expect("overdue")
                .is_empty()
        );
        state.timestamp = due_at;
        let overdue = overdue_lending_loans(&state, due_at).expect("overdue");
        assert_eq!(
            overdue,
            vec![(loan_id.clone(), BORROWER.to_string(), token())]
        );

        settle_overdue_lending_loans(
            &mut state,
            &[OverdueLendingLoan {
                loan_id: loan_id.clone(),
                borrower_entity_id: BORROWER.to_string(),
                token_id: token(),
                committed_credit_limit: BigInt::from(22_500),
            }],
            &mut queued,
        )
        .expect("settle");
        let loan = state.lending.as_ref().unwrap().loan(&loan_id).unwrap();
        assert_eq!(loan.status, LendingLoanStatus::Defaulted);
        assert_eq!(loan.repaid_amount, BigInt::from(0));
        assert_eq!(loan.repayment_amount, BigInt::from(2_525));
        let pool = state
            .lending
            .as_ref()
            .unwrap()
            .pool("lend-1111111111111111")
            .unwrap();
        assert_eq!(pool.available_amount, BigInt::from(10_000));
        assert_eq!(pool.borrowed_amount, BigInt::from(0));
        assert!(queued.is_empty());
        assert!(
            overdue_lending_loans(&state, due_at)
                .expect("overdue")
                .is_empty()
        );

        // The lender withdraws the released capital.
        apply(
            &mut state,
            commit(
                LENDER,
                due_at + 2,
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
        assert!(matches!(
            &payout,
            AccountTx::LendingClosePayout { amount, .. } if amount == &BigInt::from(10_000)
        ));
        apply(
            &mut state,
            commit(LENDER, due_at + 3, true, payout),
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
    }
}
