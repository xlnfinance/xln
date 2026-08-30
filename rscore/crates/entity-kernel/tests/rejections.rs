mod support;

use std::collections::BTreeSet;

use num_bigint::BigInt;
use support::{MAKER, commit, token};
use xln_rscore_engine::{AccountTx, RebalanceRefundReason, ReserveSide};
use xln_rscore_entity_kernel::{
    DeterministicContext, EntityKernelError, EntityStateSlice, JurisdictionScope,
    apply_entity_kernel,
};

#[test]
fn state_only_transactions_are_inert_but_cross_j_fails_loudly() {
    let mut state = EntityStateSlice::empty(support::HUB, 1);
    state.known_accounts = BTreeSet::from([MAKER.to_string()]).into();
    let unknown = commit(
        MAKER,
        0x61,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    let applied = apply_entity_kernel(
        state.clone(),
        &[unknown],
        &DeterministicContext::hlt_default(),
    )
    .expect("Account-only genesis transaction has no Entity effect");
    assert_eq!(applied.state, state);
    assert!(applied.outputs.is_empty());
    assert!(applied.proposal_work.is_empty());

    for tx in [
        AccountTx::ReserveToCollateral {
            token_id: token(1),
            collateral: "100".into(),
            ondelta: "0".into(),
            side: ReserveSide::Receiving,
            block_number: 7,
            transaction_hash: format!("0x{}", "33".repeat(32)),
        },
        AccountTx::RequestCollateral {
            token_id: token(1),
            amount: BigInt::from(100),
            fee_token_id: Some(token(1)),
            fee_amount: BigInt::from(1),
            policy_version: 1,
        },
        AccountTx::RebalanceRefund {
            request_id: "refund-1".into(),
            request_token_id: token(1),
            amount: BigInt::from(100),
            reason: RebalanceRefundReason::Timeout,
        },
    ] {
        let account_only = commit(MAKER, 0x63, 2, tx, Vec::new());
        let applied = apply_entity_kernel(
            state.clone(),
            &[account_only],
            &DeterministicContext::hlt_default(),
        )
        .expect("committed Account-only transition must not invent an Entity effect");
        assert_eq!(applied.state, state);
        assert!(applied.outputs.is_empty());
        assert!(applied.proposal_work.is_empty());
    }

    let mut cross = commit(
        MAKER,
        0x62,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    cross.scope = JurisdictionScope::Cross;
    assert_eq!(
        apply_entity_kernel(state, &[cross], &DeterministicContext::hlt_default()),
        Err(EntityKernelError::CrossJurisdictionUnsupported {
            account_id: MAKER.to_string(),
        })
    );
}
