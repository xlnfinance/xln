use crate::common::{entity, replica, token};
use num_bigint::BigInt;
use std::sync::Arc;
use xln_rscore_engine::{
    AccountExecutionContext, AccountReplica, AccountTx, AccountVerdict, Delta,
    SequentialAccountEngine, Side, SwapMarketPolicy, SwapToken,
};

fn market() -> AccountExecutionContext {
    AccountExecutionContext::with_market(
        1_000,
        1_000,
        10,
        1,
        10,
        Arc::new(SwapMarketPolicy::new(
            vec![
                SwapToken {
                    token_id: 1,
                    decimals: 6,
                    liquid: false,
                },
                SwapToken {
                    token_id: 2,
                    decimals: 6,
                    liquid: true,
                },
            ],
            vec![],
        )),
    )
}

fn resting_swap() -> AccountReplica {
    resting_swap_with_time_in_force(None)
}

fn resting_swap_with_time_in_force(time_in_force: Option<u8>) -> AccountReplica {
    let max_signed = (BigInt::from(1) << 511_usize) - 1_u8;
    let credit = (BigInt::from(1) << 256_usize) - 1_u8;
    let rows = vec![
        Delta::new(
            token(1),
            2.into(),
            2.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
        )
        .expect("give row"),
        Delta::new(
            token(2),
            0.into(),
            -&max_signed + 1_u8,
            max_signed - 1_u8,
            credit.clone(),
            credit,
            0.into(),
            0.into(),
            0.into(),
            0.into(),
        )
        .expect("want row"),
    ];
    let base = replica(entity(0x11), entity(0x11), entity(0x22), rows);
    SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &AccountTx::SwapOffer {
            offer_id: "net-fee".into(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: 2.into(),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: 2.into(),
            max_fee: 1.into(),
            min_net_receive: 1.into(),
            time_in_force,
            price_ticks: None,
            cross_jurisdiction: None,
        },
        &market(),
    )
    .expect("resting offer")
    .committed()
    .expect("offer candidate")
}

fn resolve(fee: u8) -> AccountTx {
    AccountTx::SwapResolve {
        offer_id: "net-fee".into(),
        fill_ratio: 65_535,
        fill_numerator: None,
        fill_denominator: None,
        cancel_remainder: false,
        comment: None,
        fee_token_id: Some(2),
        fee_amount: Some(fee.into()),
        execution_give_amount: Some(2.into()),
        execution_want_amount: Some(2.into()),
        resting_give_token_id: None,
        resting_want_token_id: None,
        resting_price_ticks: None,
        resting_give_amount: None,
        resting_want_amount: None,
        resting_quantized_give: None,
        resting_quantized_want: None,
    }
}

#[test]
fn swap_resolve_checks_final_net_want_amount_after_the_authorized_fee() {
    let base = resting_swap();
    let result =
        SequentialAccountEngine::apply_with_context(&base, Side::Right, &resolve(1), &market())
            .expect("net signed representation");
    assert_eq!(result.verdict(), &AccountVerdict::Applied);
    let candidate = result.candidate().expect("resolved candidate");
    assert_eq!(
        candidate
            .state()
            .delta(token(2))
            .expect("want row")
            .offdelta(),
        &((BigInt::from(1) << 511_usize) - 1_u8)
    );
    assert_eq!(
        candidate
            .state()
            .delta(token(1))
            .expect("give row")
            .offdelta(),
        &BigInt::from(-2)
    );
    assert_eq!(candidate.state().swap_offer_count(), 0);
    assert_eq!(result.events()[0], "💱 Swap filled: 2 token1 for 2 token2");
    assert_eq!(result.events()[1], "💸 Swap taker fee: 1 token2");
}

#[test]
fn swap_resolve_rejects_unrepresentable_net_want_without_partial_give_or_hold_mutation() {
    let base = resting_swap();
    let before = base.state().deltas_root();
    let result =
        SequentialAccountEngine::apply_with_context(&base, Side::Right, &resolve(0), &market())
            .expect("typed overflow rejection");
    let AccountVerdict::Rejected(reason) = result.verdict() else {
        panic!("unsafe net amount accepted");
    };
    assert_eq!(
        reason.message(),
        format!("Offdelta outside int512: {}", BigInt::from(1) << 511_usize)
    );
    assert!(result.candidate().is_none());
    assert!(result.outputs().is_empty());
    assert_eq!(base.state().deltas_root(), before);
    assert_eq!(
        base.state()
            .delta(token(1))
            .expect("give row")
            .hold(Side::Left),
        &BigInt::from(2)
    );
    assert_eq!(base.state().swap_offer_count(), 1);
}

#[test]
fn swap_resolve_preserves_the_makers_immediate_execution_terms() {
    for (tif, cancel, accepted) in [
        (0, false, true),
        (1, false, false),
        (1, true, true),
        (2, true, false),
    ] {
        let base = resting_swap_with_time_in_force(Some(tif));
        let mut tx = resolve(0);
        if let AccountTx::SwapResolve {
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            execution_give_amount,
            execution_want_amount,
            ..
        } = &mut tx
        {
            *fill_ratio = 32_768;
            *fill_numerator = Some(1.into());
            *fill_denominator = Some(2.into());
            *cancel_remainder = cancel;
            *execution_give_amount = Some(1.into());
            *execution_want_amount = Some(1.into());
        }
        let before = base.state().deltas_root();
        let result =
            SequentialAccountEngine::apply_with_context(&base, Side::Right, &tx, &market())
                .expect("typed time-in-force disposition");
        assert_eq!(
            result.verdict() == &AccountVerdict::Applied,
            accepted,
            "tif={tif} cancel={cancel} verdict={:?}",
            result.verdict()
        );
        if !accepted {
            assert!(result.candidate().is_none());
            assert!(result.outputs().is_empty());
            assert_eq!(base.state().deltas_root(), before);
        }
    }
}

#[test]
fn swap_resolve_rejects_mismatched_resting_token_ids_before_mutation() {
    let base = resting_swap();
    for mismatch_give in [true, false] {
        let mut tx = resolve(1);
        if let AccountTx::SwapResolve {
            resting_give_token_id,
            resting_want_token_id,
            ..
        } = &mut tx
        {
            if mismatch_give {
                *resting_give_token_id = Some(2);
            } else {
                *resting_want_token_id = Some(1);
            }
        }
        let result =
            SequentialAccountEngine::apply_with_context(&base, Side::Right, &tx, &market())
                .expect("typed resting terms disposition");
        let AccountVerdict::Rejected(reason) = result.verdict() else {
            panic!("token mismatch accepted");
        };
        assert_eq!(reason.message(), "SWAP_RESOLVE_RESTING_TERMS_MISMATCH");
        assert!(result.candidate().is_none());
        assert!(result.outputs().is_empty());
    }
}
