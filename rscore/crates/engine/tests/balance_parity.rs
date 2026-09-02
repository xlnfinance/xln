mod common;

#[path = "authority/account_tx_dispute_admission_vectors.rs"]
mod account_tx_dispute_admission_vectors;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountOutput, AccountTx, AccountVerdict, DeliveryMode, SequentialAccountEngine,
    Side, ValidationRejection,
};

use common::{delta, entity, entity_text, replica, root_hex, token};

fn direct_payment(amount: i64) -> AccountTx {
    AccountTx::DirectPayment {
        token_id: token(1),
        amount: amount.into(),
        route: vec![entity_text(0xaa)],
        description: Some("integrity-regression".into()),
        from_entity_id: entity_text(0xbb),
        to_entity_id: entity_text(0xaa),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

#[test]
fn direct_payment_matches_literal_typescript_delta_roots() {
    let base = replica(
        entity(0xbb),
        entity(0xaa),
        entity(0xbb),
        vec![delta(token(1), 100_000, 0, 0, 0, 0)],
    );
    assert_eq!(
        root_hex(&base),
        "4c1ddfc1d24e1be381fa5a0b57bd4cd64d44e64ac9b032f10cc6da49be8de8d6"
    );
    let transition = SequentialAccountEngine::apply(&base, Side::Right, &direct_payment(100))
        .expect("payment transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    let candidate = transition.candidate().expect("applied candidate");
    assert_eq!(
        candidate.state().delta(token(1)).expect("delta").offdelta(),
        &100.into()
    );
    assert_eq!(
        root_hex(candidate),
        "9cd9d29c1899b633c7b64b234fecb56384031c6833b6e04d8d5a77f91cb7a30a"
    );
    let changes = candidate.state().delta_node_changes_since(base.state());
    assert!(!changes.puts.is_empty());
    assert!(changes.dels.is_empty());
    assert_eq!(
        root_hex(&base),
        "4c1ddfc1d24e1be381fa5a0b57bd4cd64d44e64ac9b032f10cc6da49be8de8d6"
    );
}

#[test]
fn proposer_authority_and_atomic_rejection_preserve_base() {
    let base = replica(
        entity(0xbb),
        entity(0xaa),
        entity(0xbb),
        vec![delta(token(1), 100, 0, 0, 0, 0)],
    );
    let forged = AccountTx::DirectPayment {
        token_id: token(1),
        amount: 1.into(),
        route: vec![entity_text(0xbb)],
        description: Some("forged".into()),
        from_entity_id: entity_text(0xaa),
        to_entity_id: entity_text(0xbb),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    };
    let before = root_hex(&base);
    let rejected =
        SequentialAccountEngine::apply(&base, Side::Right, &forged).expect("domain rejection");
    assert!(matches!(
        rejected.verdict(),
        AccountVerdict::Rejected(xln_rscore_engine::AccountRejection::Validation(
            ValidationRejection::PaymentDirection
        ))
    ));
    assert!(rejected.candidate().is_none());

    let batch = vec![
        (Side::Right, direct_payment(50)),
        (Side::Right, direct_payment(51)),
    ];
    let rejected = SequentialAccountEngine::apply_atomic(&base, &batch).expect("atomic batch");
    assert!(matches!(rejected.verdict(), AccountVerdict::Rejected(_)));
    assert!(rejected.outputs().is_empty());
    assert_eq!(root_hex(&base), before);
}

#[test]
fn credit_orientation_and_row_limit_match_typescript() {
    let empty = replica(entity(0x11), entity(0x11), entity(0x22), Vec::new());
    let left = SequentialAccountEngine::apply(
        &empty,
        Side::Left,
        &AccountTx::SetCreditLimit {
            token_id: token(1),
            amount: 70.into(),
        },
    )
    .expect("left credit")
    .committed()
    .expect("candidate");
    let value = left.state().delta(token(1)).expect("created row");
    assert_eq!(value.left_credit_limit(), &BigInt::from(0));
    assert_eq!(value.right_credit_limit(), &BigInt::from(70));

    let right = SequentialAccountEngine::apply(
        &left,
        Side::Right,
        &AccountTx::SetCreditLimit {
            token_id: token(1),
            amount: 80.into(),
        },
    )
    .expect("right credit")
    .committed()
    .expect("candidate");
    let value = right.state().delta(token(1)).expect("existing row");
    assert_eq!(value.left_credit_limit(), &BigInt::from(80));
    assert_eq!(value.right_credit_limit(), &BigInt::from(70));

    let rows = (0..128).map(|id| delta(token(id), 0, 0, 0, 0, 0)).collect();
    let full = replica(entity(0x11), entity(0x11), entity(0x22), rows);
    let existing = SequentialAccountEngine::apply(
        &full,
        Side::Left,
        &AccountTx::AddDelta { token_id: token(0) },
    )
    .expect("idempotent add");
    assert_eq!(existing.verdict(), &AccountVerdict::Applied);
    let overflow = SequentialAccountEngine::apply(
        &full,
        Side::Left,
        &AccountTx::AddDelta {
            token_id: token(128),
        },
    )
    .expect("typed row rejection");
    let AccountVerdict::Rejected(rejection) = overflow.verdict() else {
        panic!("expected rejection")
    };
    assert_eq!(rejection.code(), "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED");
    assert_eq!(
        rejection.message(),
        "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:129:128"
    );
    assert_eq!(overflow.events(), &[rejection.message()]);
}

#[test]
fn credit_and_payment_numeric_boundaries_reject_without_candidates() {
    let base = replica(entity(0x11), entity(0x11), entity(0x22), Vec::new());
    let max_payment = (BigInt::from(1_u8) << 128) - 1_u8;
    let max_credit: BigInt = &max_payment * 1_000_u16;
    let accepted = SequentialAccountEngine::apply(
        &base,
        Side::Left,
        &AccountTx::SetCreditLimit {
            token_id: token(1),
            amount: max_credit.clone(),
        },
    )
    .expect("maximum credit");
    assert_eq!(accepted.verdict(), &AccountVerdict::Applied);
    for amount in [BigInt::from(-1), &max_credit + 1_u8] {
        let rejected = SequentialAccountEngine::apply(
            &base,
            Side::Left,
            &AccountTx::SetCreditLimit {
                token_id: token(1),
                amount,
            },
        )
        .expect("credit rejection");
        assert!(matches!(rejected.verdict(), AccountVerdict::Rejected(_)));
        assert!(rejected.candidate().is_none());
    }
    for amount in [BigInt::from(0), &max_payment + 1_u8] {
        let mut tx = direct_payment(1);
        if let AccountTx::DirectPayment { amount: value, .. } = &mut tx {
            *value = amount;
        }
        let rejected =
            SequentialAccountEngine::apply(&base, Side::Right, &tx).expect("payment rejection");
        assert!(matches!(rejected.verdict(), AccountVerdict::Rejected(_)));
    }
}

#[test]
fn trusted_forward_preserves_one_thousand_identical_outputs() {
    let gateway_upper = entity_text(0xaa).to_ascii_uppercase();
    let payment = AccountTx::DirectPayment {
        token_id: token(1),
        amount: 1.into(),
        route: vec![gateway_upper.clone(), entity_text(0xcc)],
        description: Some("identical-routed-payment".into()),
        from_entity_id: entity_text(0xbb),
        to_entity_id: gateway_upper.clone(),
        delivery_mode: DeliveryMode::Trusted,
        trusted_gateway_entity_id: Some(gateway_upper.clone()),
    };
    let base = replica(
        entity(0xaa),
        entity(0xaa),
        entity(0xbb),
        vec![delta(token(1), 100_000, 0, 0, 0, 0)],
    );
    let batch = (0..1_000)
        .map(|_| (Side::Right, payment.clone()))
        .collect::<Vec<_>>();
    let transition = SequentialAccountEngine::apply_atomic(&base, &batch).expect("batch");
    assert_eq!(transition.outputs().len(), 1_000);
    assert!(transition.outputs().iter().all(|output| matches!(
        output,
        AccountOutput::DirectPaymentForward { route, trusted_gateway_entity_id, .. }
            if route[0] == gateway_upper && trusted_gateway_entity_id == &gateway_upper
    )));
    assert_eq!(
        transition
            .candidate()
            .expect("candidate")
            .state()
            .delta(token(1))
            .expect("delta")
            .offdelta(),
        &BigInt::from(1_000)
    );
}
