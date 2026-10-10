use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountReplica, AccountTx, AccountVerdict, DeliveryMode, Delta, HtlcHashlock,
    HtlcResolveOutcome, HtlcResolveTx, SequentialAccountEngine, Side,
};

use crate::common::{entity, entity_text, replica, token};
use crate::htlc_support;

fn account(offdelta: BigInt, held_units: u16) -> AccountReplica {
    let credit = (BigInt::from(1) << 256_usize) - 1_u8;
    // At the Int512 edges neutralize the cumulative on-chain allocation so
    // this vector isolates representation from available credit. The -1
    // keeps both opposite limbs representable even at Int512::MIN.
    let ondelta = if offdelta < -&credit || offdelta > credit {
        -&offdelta - 1_u8
    } else {
        BigInt::from(0)
    };
    let row = Delta::new(
        token(1),
        0.into(),
        ondelta,
        offdelta,
        credit.clone(),
        credit,
        0.into(),
        0.into(),
        held_units.into(),
        held_units.into(),
    )
    .expect("signed delta and unsigned grants");
    replica(entity(0x11), entity(0x11), entity(0x22), vec![row])
}

fn payment(sender: Side, amount: BigInt) -> AccountTx {
    let (from, to) = if sender == Side::Left {
        (0x11, 0x22)
    } else {
        (0x22, 0x11)
    };
    AccountTx::DirectPayment {
        token_id: token(1),
        amount,
        route: vec![entity_text(to)],
        description: None,
        from_entity_id: entity_text(from),
        to_entity_id: entity_text(to),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

#[test]
fn direct_payment_rejects_signed_poststate_overflow_without_state_or_outputs() {
    let boundary = BigInt::from(1) << 511_usize;
    for (sender, offdelta, invalid) in [
        (Side::Left, -&boundary, -&boundary - 1_u8),
        (Side::Right, &boundary - 1_u8, boundary),
    ] {
        let base = account(offdelta, 0);
        let before = base.state().deltas_root();
        let transition = SequentialAccountEngine::apply(&base, sender, &payment(sender, 1.into()))
            .expect("typed representation rejection");
        let AccountVerdict::Rejected(reason) = transition.verdict() else {
            panic!("overflow accepted");
        };
        assert_eq!(reason.code(), "ACCOUNT_TX_VALIDATION");
        assert_eq!(
            reason.message(),
            format!("Offdelta outside int512: {invalid}")
        );
        assert!(transition.candidate().is_none());
        assert!(transition.events().is_empty());
        assert!(transition.outputs().is_empty());
        assert_eq!(base.state().deltas_root(), before);
    }
}

#[test]
fn direct_payment_uint256_max_can_offset_existing_exposure_between_signed_boundaries() {
    let boundary = BigInt::from(1) << 255_usize;
    let amount = (&boundary << 1_usize) - 1_u8;
    for (sender, offdelta, expected) in [
        (Side::Left, &boundary - 1_u8, -&boundary),
        (Side::Right, -&boundary, &boundary - 1_u8),
    ] {
        let base = account(offdelta, 0);
        let transition =
            SequentialAccountEngine::apply(&base, sender, &payment(sender, amount.clone()))
                .expect("representable movement");
        assert_eq!(transition.verdict(), &AccountVerdict::Applied);
        let candidate = transition.candidate().expect("payment candidate");
        assert_eq!(
            candidate.state().delta(token(1)).expect("delta").offdelta(),
            &expected
        );
    }
}

fn locked_at_signed_boundary(sender: Side) -> (AccountReplica, BigInt) {
    let boundary = BigInt::from(1) << 511_usize;
    let (before, expected) = if sender == Side::Left {
        (-&boundary + 1_u8, -boundary)
    } else {
        (&boundary - 2_u8, boundary - 1_u8)
    };
    let locked = SequentialAccountEngine::apply_with_context(
        &account(before, 0),
        sender,
        &htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into()),
        &htlc_support::execution_context(1_000, 10),
    )
    .expect("last representable conditional unit")
    .committed()
    .expect("lock candidate");
    (locked, expected)
}

#[test]
fn htlc_lock_rejects_unrepresentable_conditional_outcome_on_both_sides() {
    let boundary = BigInt::from(1) << 511_usize;
    for (sender, offdelta, expected) in [
        (Side::Left, -&boundary, -&boundary - 1_u8),
        (Side::Right, &boundary - 1_u8, boundary),
    ] {
        let base = account(offdelta, 0);
        let result = SequentialAccountEngine::apply_with_context(
            &base,
            sender,
            &htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into()),
            &htlc_support::execution_context(1_000, 10),
        )
        .expect("conditional outcome rejection");
        let AccountVerdict::Rejected(reason) = result.verdict() else {
            panic!("unsafe lock accepted");
        };
        assert_eq!(
            reason.message(),
            format!("Offdelta outside int512: {expected}")
        );
        assert!(result.candidate().is_none());
        assert!(result.events().is_empty());
        assert!(result.outputs().is_empty());
        assert_eq!(base.state().htlc_count(), 0);
    }
}

#[test]
fn direct_payment_cannot_consume_capacity_reserved_by_an_independent_htlc_outcome() {
    for sender in [Side::Left, Side::Right] {
        let (base, endpoint) = locked_at_signed_boundary(sender);
        let before = base.state().deltas_root();
        for amount in [1_u8, 2] {
            let result =
                SequentialAccountEngine::apply(&base, sender, &payment(sender, amount.into()))
                    .expect("reserved outcome rejection");
            let AccountVerdict::Rejected(reason) = result.verdict() else {
                panic!("reserved capacity consumed");
            };
            let expected = if sender == Side::Left {
                &endpoint - amount
            } else {
                &endpoint + amount
            };
            assert_eq!(
                reason.message(),
                format!("Offdelta outside int512: {expected}")
            );
            assert!(result.candidate().is_none());
            assert_eq!(base.state().deltas_root(), before);
            assert_eq!(base.state().htlc_count(), 1);
        }
    }
}

#[test]
fn htlc_secret_resolution_excludes_its_consumed_lock_from_conditional_exposure() {
    for sender in [Side::Left, Side::Right] {
        let (base, endpoint) = locked_at_signed_boundary(sender);
        let result = SequentialAccountEngine::apply_with_context(
            &base,
            sender.opposite(),
            &AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: htlc_support::HASHLOCK.into(),
                outcome: HtlcResolveOutcome::Secret {
                    secret: htlc_support::SECRET.into(),
                },
            }),
            &htlc_support::execution_context(1_000, 10),
        )
        .expect("resolving already reserved amount");
        assert_eq!(result.verdict(), &AccountVerdict::Applied);
        let candidate = result.candidate().expect("resolved candidate");
        let delta = candidate.state().delta(token(1)).expect("delta");
        assert_eq!(delta.offdelta(), &endpoint);
        assert_eq!(delta.hold(sender), &BigInt::from(0));
        assert_eq!(candidate.state().htlc_count(), 0);
    }
}

#[test]
fn opposite_hashlocks_do_not_net_independently_reachable_outcomes() {
    let boundary = BigInt::from(1) << 511_usize;
    for (sender, offdelta) in [(Side::Left, -&boundary), (Side::Right, &boundary - 1_u8)] {
        let base = SequentialAccountEngine::apply_with_context(
            &account(offdelta, 0),
            sender.opposite(),
            &htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into()),
            &htlc_support::execution_context(1_000, 10),
        )
        .expect("opposite lock transition")
        .committed()
        .expect("opposite lock candidate");
        let mut next = htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into());
        let AccountTx::HtlcLock(lock) = &mut next else {
            panic!("lock fixture");
        };
        lock.hashlock =
            HtlcHashlock::parse(&format!("0x{}", "55".repeat(32))).expect("second hashlock");
        lock.lock_id = lock.hashlock.as_str().into();
        let result = SequentialAccountEngine::apply_with_context(
            &base,
            sender,
            &next,
            &htlc_support::execution_context(1_000, 10),
        )
        .expect("independent outcome rejection");
        assert!(matches!(result.verdict(), AccountVerdict::Rejected(_)));
        assert!(result.candidate().is_none());
        assert_eq!(base.state().htlc_count(), 1);
    }
}

#[test]
fn non_htlc_holds_do_not_create_a_fictitious_conditional_offdelta_ceiling() {
    let boundary = BigInt::from(1) << 511_usize;
    for (sender, offdelta) in [
        (Side::Left, -&boundary + 1_u8),
        (Side::Right, &boundary - 2_u8),
    ] {
        let base = account(offdelta, 100);
        let result = SequentialAccountEngine::apply(&base, sender, &payment(sender, 1.into()))
            .expect("other hold categories do not move offdelta");
        assert_eq!(result.verdict(), &AccountVerdict::Applied);
        let candidate = result.candidate().expect("payment candidate");
        assert_eq!(
            candidate
                .state()
                .delta(token(1))
                .expect("delta")
                .hold(sender),
            &BigInt::from(100)
        );
    }
}

#[test]
fn payment_and_credit_limit_on_a_129th_token_row_are_typed_rejections() {
    // Parity: core/__tests__/account/transactions/apply-account-tx-result.test.ts.
    // `delta_or_zero(..)?` used to turn the 129th row into a fatal
    // TransitionError, so a peer frame on a fresh token halted the Runtime.
    let rows = (1..=128_u32)
        .map(|id| {
            Delta::new(
                token(id),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
            )
            .expect("zero row")
        })
        .collect();
    let base = replica(entity(0x11), entity(0x11), entity(0x22), rows);
    let mut paid = payment(Side::Left, 1.into());
    if let AccountTx::DirectPayment { token_id, .. } = &mut paid {
        *token_id = token(129);
    }
    let credit = AccountTx::SetCreditLimit {
        token_id: token(129),
        amount: 1.into(),
    };
    for tx in [paid, credit] {
        let transition = SequentialAccountEngine::apply(&base, Side::Left, &tx)
            .expect("typed row-limit rejection, not a TransitionError");
        let AccountVerdict::Rejected(reason) = transition.verdict() else {
            panic!("129th row accepted");
        };
        assert_eq!(reason.code(), "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED");
        assert_eq!(
            reason.message(),
            "ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:129:128"
        );
        assert_eq!(transition.events(), [reason.message()]);
        assert!(transition.candidate().is_none());
    }
}
