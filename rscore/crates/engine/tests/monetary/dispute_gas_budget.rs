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

#[test]
fn settlement_reserves_zero_diff_and_forgiveness_rows_before_signing() {
    use xln_rscore_engine::AccountExecutionContext;
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue as V};
    for kind in ["rawDiff", "forgive"] {
        let mut op = vec![
            ("type".into(), V::String(kind.into())),
            ("tokenId".into(), V::Number(CanonicalNumber::from_u16(11))),
        ];
        if kind == "rawDiff" {
            for field in ["leftDiff", "rightDiff", "collateralDiff", "ondeltaDiff"] {
                op.push((field.into(), V::BigInt(0.into())));
            }
        }
        let tx = AccountTx::SettleTransition {
            data: V::Object(vec![
                ("kind".into(), V::String("upsert".into())),
                ("revision".into(), V::Number(CanonicalNumber::from_u16(1))),
                ("executorIsLeft".into(), V::Bool(true)),
                ("ops".into(), V::Array(vec![V::Object(op)])),
            ]),
        };
        let account = replica(
            entity(0x11),
            entity(0x11),
            entity(0x22),
            (1..=10)
                .map(|id| delta(token(id), 0, 0, 0, 1000, 1000))
                .collect(),
        );
        let before = account.state().deltas_root();
        let result = SequentialAccountEngine::apply_with_context(
            &account,
            Side::Left,
            &tx,
            &AccountExecutionContext::new(1000, 1000, 0, 0, 0),
        )
        .unwrap();
        let AccountVerdict::Rejected(reason) = result.verdict() else {
            panic!("projected proof admitted");
        };
        assert_eq!(
            reason.message(),
            "ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5200000/5000000"
        );
        assert!(result.candidate().is_none());
        assert!(result.outputs().is_empty());
        assert!(account.state().settlement_workspace().is_none());
        assert_eq!(account.state().deltas_root(), before);
    }
}

#[test]
fn pending_settlement_cannot_spend_the_same_exit_budget_twice() {
    use xln_rscore_engine::{AccountExecutionContext, HtlcHashlock, HtlcLockTx};
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue as V};
    let context = AccountExecutionContext::new(1000, 1000, 0, 0, 0);
    let account = replica(
        entity(0x11),
        entity(0x11),
        entity(0x22),
        (1..=9)
            .map(|id| delta(token(id), 0, 0, 0, 1000, 1000))
            .collect(),
    );
    let raw = V::Object(vec![
        ("type".into(), V::String("rawDiff".into())),
        ("tokenId".into(), V::Number(CanonicalNumber::from_u16(10))),
        ("leftDiff".into(), V::BigInt(0.into())),
        ("rightDiff".into(), V::BigInt(0.into())),
        ("collateralDiff".into(), V::BigInt(0.into())),
        ("ondeltaDiff".into(), V::BigInt(0.into())),
    ]);
    let forgive = V::Object(vec![
        ("type".into(), V::String("forgive".into())),
        ("tokenId".into(), V::Number(CanonicalNumber::from_u16(10))),
    ]);
    let upsert = AccountTx::SettleTransition {
        data: V::Object(vec![
            ("kind".into(), V::String("upsert".into())),
            ("revision".into(), V::Number(CanonicalNumber::from_u16(1))),
            ("executorIsLeft".into(), V::Bool(true)),
            ("ops".into(), V::Array(vec![raw, forgive])),
        ]),
    };
    let account =
        SequentialAccountEngine::apply_with_context(&account, Side::Left, &upsert, &context)
            .unwrap()
            .committed()
            .expect("one reserved token, not two");
    assert!(account.state().delta(token(10)).is_some());
    let hash = format!("0x{:064x}", 44);
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: hash.clone(),
        hashlock: HtlcHashlock::parse(&hash).unwrap(),
        timelock: 60000.into(),
        reveal_before_height: 10,
        amount: 1.into(),
        token_id: token(1),
        delivery_mode: None,
        envelope: None,
    });
    let result =
        SequentialAccountEngine::apply_with_context(&account, Side::Left, &lock, &context).unwrap();
    let AccountVerdict::Rejected(reason) = result.verdict() else {
        panic!("reservation spent twice");
    };
    assert_eq!(
        reason.message(),
        "ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5100000/5000000"
    );
    assert!(result.candidate().is_none());
    assert_eq!(account.state().htlc_count(), 0);
}
