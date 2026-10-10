use crate::common::{delta, entity, entity_text, replica, token};
use xln_rscore_engine::{AccountTx, AccountVerdict, DeliveryMode, SequentialAccountEngine, Side};

#[test]
fn gas_budget_rejects_only_new_over_budget_work_and_keeps_next_payment_live() {
    let mut account = replica(
        entity(0x11),
        entity(0x11),
        entity(0x22),
        vec![delta(token(1), 0, 0, 0, 1000, 1000)],
    );
    for id in 2..=10 {
        let result = SequentialAccountEngine::apply(
            &account,
            Side::Left,
            &AccountTx::AddDelta {
                token_id: token(id),
            },
        )
        .unwrap();
        assert_eq!(result.verdict(), &AccountVerdict::Applied);
        account = result.committed().unwrap();
    }
    let before = account.state().deltas_root();
    let result = SequentialAccountEngine::apply(
        &account,
        Side::Left,
        &AccountTx::AddDelta {
            token_id: token(11),
        },
    )
    .unwrap();
    let AccountVerdict::Rejected(reason) = result.verdict() else {
        panic!("oversized proof admitted")
    };
    assert_eq!(reason.code(), "ACCOUNT_TX_VALIDATION");
    assert_eq!(
        reason.message(),
        "ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5200000/5000000"
    );
    assert!(result.candidate().is_none());
    assert!(result.outputs().is_empty());
    assert_eq!(account.state().deltas_root(), before);
    let payment = AccountTx::DirectPayment {
        token_id: token(1),
        amount: 1.into(),
        route: vec![entity_text(0x22)],
        description: None,
        from_entity_id: entity_text(0x11),
        to_entity_id: entity_text(0x22),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    };
    let result = SequentialAccountEngine::apply(&account, Side::Left, &payment).unwrap();
    assert_eq!(result.verdict(), &AccountVerdict::Applied);
    assert_eq!(
        result
            .candidate()
            .unwrap()
            .state()
            .delta(token(1))
            .unwrap()
            .offdelta(),
        &(-1).into()
    );
}

#[test]
fn htlc_clause_split_rejects_without_reserving_funds() {
    use xln_rscore_engine::{AccountExecutionContext, HtlcHashlock, HtlcLockTx};
    let mut account = replica(
        entity(0x11),
        entity(0x11),
        entity(0x22),
        vec![delta(token(1), 0, 0, 0, 1000, 1000)],
    );
    for id in 2..=8 {
        account = SequentialAccountEngine::apply(
            &account,
            Side::Left,
            &AccountTx::AddDelta {
                token_id: token(id),
            },
        )
        .unwrap()
        .committed()
        .unwrap();
    }
    for index in 1..=30 {
        let hashlock = format!("0x{index:064x}");
        let tx = AccountTx::HtlcLock(HtlcLockTx {
            lock_id: hashlock.clone(),
            hashlock: HtlcHashlock::parse(&hashlock).unwrap(),
            timelock: 60_000.into(),
            reveal_before_height: 10,
            amount: 1.into(),
            token_id: token(1),
            delivery_mode: None,
            envelope: None,
        });
        let result = SequentialAccountEngine::apply_with_context(
            &account,
            Side::Left,
            &tx,
            &AccountExecutionContext::new(1000, 1000, 0, 0, 0),
        )
        .unwrap();
        if index < 30 {
            account = result.committed().unwrap();
        } else {
            let AccountVerdict::Rejected(reason) = result.verdict() else {
                panic!("over-budget split admitted")
            };
            assert_eq!(
                reason.message(),
                "ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5064000/5000000"
            );
            assert!(result.candidate().is_none());
            assert!(result.outputs().is_empty());
        }
    }
    assert_eq!(account.state().htlc_count(), 29);
    assert_eq!(
        account.state().delta(token(1)).unwrap().hold(Side::Left),
        &29.into()
    );
}
