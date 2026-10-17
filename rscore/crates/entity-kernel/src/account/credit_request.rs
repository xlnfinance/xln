//! Hub answer to a committed counterparty `credit_request`. Mirrors
//! `applyCommittedCreditRequestFollowup` in
//! `core/entity/tx/handlers/account/credit-request.ts`.
//!
//! Authority: only a hub answers, and only a request the counterparty
//! proposed (`committed_via_new_frame`); a hub's own request to a peer hub is
//! answered by that peer. The answer raises the hub's line to
//! `max(projected line, min(requested, cap))`, so it never lowers a larger
//! existing grant. Replays never reach here: the Account intent ledger rejects
//! a second `credit:<requestId>` before commit.

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, TokenId};

use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;
use crate::{
    CommittedAccountTransition, EntityKernelError, EntityStateSlice, OrderedAccountCommit,
};

/// TS `CREDIT_REQUEST_CAP_WHOLE` in `core/account/config/defaults.ts`.
const CREDIT_REQUEST_CAP_WHOLE: u16 = 1_000;

/// `None` for a token without canonical metadata: no automatic grant.
pub(crate) fn credit_request_cap(token_id: TokenId) -> Option<BigInt> {
    crate::canonical_token_decimals(u32::from(token_id.get()))
        .map(|decimals| BigInt::from(CREDIT_REQUEST_CAP_WHOLE) * BigInt::from(10_u8).pow(decimals))
}

pub(crate) fn apply_committed_credit_request_followup(
    state: &EntityStateSlice,
    commit: &OrderedAccountCommit,
    transition: &CommittedAccountTransition,
    account_view: Option<&LocalAccountFinancialView>,
    account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<bool, EntityKernelError> {
    let AccountTx::CreditRequest {
        token_id, amount, ..
    } = &transition.tx
    else {
        return Ok(false);
    };
    if !transition.outputs.is_empty() {
        return Err(EntityKernelError::output("CREDIT_REQUEST_TX_OUTPUTS"));
    }
    if !state.profile.is_hub || !commit.committed_via_new_frame {
        return Ok(true);
    }
    let Some(cap) = credit_request_cap(*token_id) else {
        return Ok(true);
    };
    let target = std::cmp::min(amount.clone(), cap);
    let view = account_view
        .ok_or_else(|| EntityKernelError::output("CREDIT_REQUEST_ACCOUNT_VIEW_MISSING"))?;
    let current =
        crate::lendbook::projected_credit(view, &commit.account_id, *token_id, account_txs);
    if current >= target {
        return Ok(true);
    }
    account_txs.push((
        commit.account_id.clone(),
        AccountTx::SetCreditLimit {
            token_id: *token_id,
            amount: target,
        },
    ));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use xln_rscore_engine::{AccountDomain, DepositoryAddress};

    use super::*;
    use crate::JurisdictionScope;

    const HUB: &str = "0x1010101010101010101010101010101010101010101010101010101010101010";
    const USER: &str = "0x3030303030303030303030303030303030303030303030303030303030303030";
    const WHOLE: u64 = 1_000_000;

    fn usdc() -> TokenId {
        TokenId::new(1).expect("token")
    }

    fn request(amount: u64) -> AccountTx {
        AccountTx::CreditRequest {
            request_id: "credit-1111111111111111".into(),
            requester_entity_id: USER.into(),
            token_id: usdc(),
            amount: BigInt::from(amount),
        }
    }

    fn commit(via_new_frame: bool, tx: AccountTx) -> OrderedAccountCommit {
        OrderedAccountCommit {
            account_id: USER.to_string(),
            domain: AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            scope: JurisdictionScope::Same,
            committed_via_new_frame: via_new_frame,
            frame_state_hash: format!("0x{}", "55".repeat(32)),
            frame_height: 2,
            frame_timestamp: 2_000,
            inbound_position: 0,
            transitions: vec![CommittedAccountTransition {
                tx,
                outputs: Vec::new(),
            }],
        }
    }

    fn view(hub_grant: u64) -> LocalAccountFinancialView {
        LocalAccountFinancialView {
            active: true,
            owner_side: xln_rscore_engine::Side::Left,
            owner_out_capacity: BTreeMap::new(),
            owner_peer_credit_limit: BTreeMap::from([(usdc(), BigInt::from(hub_grant))]),
            settlement_workspace: None,
            settlement_transition_pending: false,
            settlement_execution: Err("SETTLEMENT_WORKSPACE_MISSING".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::new(),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: Default::default(),
            dispute: None,
        }
    }

    fn answer(
        is_hub: bool,
        via_new_frame: bool,
        amount: u64,
        hub_grant: u64,
    ) -> Vec<TargetedAccountTx> {
        let mut state = EntityStateSlice::empty(HUB, 1_000);
        state.profile.is_hub = is_hub;
        state.known_accounts.insert(USER.to_string());
        let commit = commit(via_new_frame, request(amount));
        let mut queued = Vec::new();
        assert!(
            apply_committed_credit_request_followup(
                &state,
                &commit,
                &commit.transitions[0],
                Some(&view(hub_grant)),
                &mut queued,
            )
            .expect("credit request followup")
        );
        queued
    }

    fn grant(amount: u64) -> Vec<TargetedAccountTx> {
        vec![(
            USER.to_string(),
            AccountTx::SetCreditLimit {
                token_id: usdc(),
                amount: BigInt::from(amount),
            },
        )]
    }

    /// Same numbers as core/__tests__/payments/invariants/credit-request.test.ts.
    #[test]
    fn hub_raises_its_line_to_min_requested_cap() {
        assert_eq!(
            credit_request_cap(usdc()),
            Some(BigInt::from(1_000 * WHOLE))
        );
        assert_eq!(answer(true, true, 25 * WHOLE, 0), grant(25 * WHOLE));
        assert_eq!(answer(true, true, 5_000 * WHOLE, 0), grant(1_000 * WHOLE));
    }

    #[test]
    fn hub_never_lowers_an_existing_larger_line() {
        assert!(answer(true, true, 25 * WHOLE, 2_000 * WHOLE).is_empty());
        assert!(answer(true, true, 25 * WHOLE, 25 * WHOLE).is_empty());
    }

    #[test]
    fn non_hub_and_own_request_are_ignored() {
        assert!(answer(false, true, 25 * WHOLE, 0).is_empty());
        assert!(answer(true, false, 25 * WHOLE, 0).is_empty());
    }

    #[test]
    fn unknown_token_has_no_cap() {
        assert_eq!(credit_request_cap(TokenId::new(999).expect("token")), None);
    }
}
