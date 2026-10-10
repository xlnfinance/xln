use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountExecutionContext, AccountReplica, AccountTx, AccountVerdict, Delta,
    SequentialAccountEngine, Side, SwapMarketPolicy, SwapToken,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::common::{entity, replica, token};
use crate::htlc_support;

fn context() -> AccountExecutionContext {
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
                    decimals: 0,
                    liquid: false,
                },
                SwapToken {
                    token_id: 2,
                    decimals: 0,
                    liquid: true,
                },
            ],
            vec![],
        )),
    )
}

fn offer(id: &str, amount: BigInt) -> AccountTx {
    AccountTx::SwapOffer {
        offer_id: id.into(),
        give_token_id: 1,
        give_token_decimals: 0,
        give_amount: amount.clone(),
        want_token_id: 2,
        want_token_decimals: 0,
        want_amount: amount.clone(),
        max_fee: 0.into(),
        min_net_receive: amount,
        time_in_force: None,
        price_ticks: None,
        cross_jurisdiction: None,
    }
}

fn resting_swap(side: Side, amount: &BigInt) -> AccountReplica {
    let credit = (BigInt::from(1) << 256_usize) - 1_u8;
    let row = Delta::new(
        token(1),
        1.into(),
        u8::from(side == Side::Left).into(),
        0.into(),
        if side == Side::Left {
            credit.clone()
        } else {
            0.into()
        },
        if side == Side::Right {
            credit
        } else {
            0.into()
        },
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("representable delta with one collateral unit and uint256 credit");
    let base = replica(entity(0x11), entity(0x11), entity(0x22), vec![row]);
    let result = SequentialAccountEngine::apply_with_context(
        &base,
        side,
        &offer("max-hold", amount.clone()),
        &context(),
    )
    .expect("swap offer transition");
    assert_eq!(result.verdict(), &AccountVerdict::Applied);
    let candidate = result.committed().expect("resting offer");
    assert_eq!(
        candidate
            .state()
            .delta(token(2))
            .expect("receiving proof row")
            .offdelta(),
        &0.into()
    );
    assert!(xln_rscore_engine::build_dispute_proof_body(&candidate, &[0; 20]).is_ok());
    assert_eq!(
        candidate.state().delta(token(1)).expect("delta").hold(side),
        amount
    );
    assert_eq!(candidate.state().swap_offer_count(), 1);
    candidate
}

#[test]
fn swap_offer_then_htlc_or_swap_rejects_uint256_aggregate_hold_overflow_atomically() {
    let maximum = (BigInt::from(1) << 256_usize) - 1_u8;
    for side in [Side::Left, Side::Right] {
        let base = resting_swap(side, &maximum);
        let before = base.state().deltas_root();
        let label = if side == Side::Left { "left" } else { "right" };
        for tx in [
            htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into()),
            offer("overflow", 1.into()),
        ] {
            let result = SequentialAccountEngine::apply_with_context(&base, side, &tx, &context())
                .expect("hold overflow is a typed admission rejection");
            let AccountVerdict::Rejected(reason) = result.verdict() else {
                panic!("aggregate hold overflow accepted");
            };
            assert_eq!(reason.code(), "ACCOUNT_TX_VALIDATION");
            assert_eq!(
                reason.message(),
                format!("HOLD_ADD_OVERFLOW:{label} hold={maximum} amount=1")
            );
            assert!(result.candidate().is_none());
            assert!(result.events().is_empty());
            assert!(result.outputs().is_empty());
            assert_eq!(base.state().deltas_root(), before);
            assert_eq!(base.state().htlc_count(), 0);
            assert_eq!(base.state().swap_offer_count(), 1);
        }
    }
}

#[test]
fn swap_offer_then_htlc_accepts_exact_uint256_aggregate_hold_boundary() {
    let maximum = (BigInt::from(1) << 256_usize) - 1_u8;
    for side in [Side::Left, Side::Right] {
        let base = resting_swap(side, &(&maximum - 1_u8));
        let result = SequentialAccountEngine::apply_with_context(
            &base,
            side,
            &htlc_support::lock_tx(htlc_support::HASHLOCK, 1.into()),
            &context(),
        )
        .expect("exact uint256 hold boundary");
        assert_eq!(result.verdict(), &AccountVerdict::Applied);
        let candidate = result.candidate().expect("lock candidate");
        assert_eq!(
            candidate.state().delta(token(1)).expect("delta").hold(side),
            &maximum
        );
        assert_eq!(candidate.state().htlc_count(), 1);
        assert_eq!(candidate.state().swap_offer_count(), 1);
    }
}

#[test]
fn settle_transition_rejects_hold_overflow_without_publishing_prior_planned_hold_changes() {
    let maximum = (BigInt::from(1) << 256_usize) - 1_u8;
    for side in [Side::Left, Side::Right] {
        let base = resting_swap(side, &maximum);
        let before = base.state().deltas_root();
        let tx = AccountTx::SettleTransition {
            data: CanonicalValue::Object(vec![
                ("kind".into(), CanonicalValue::String("upsert".into())),
                (
                    "revision".into(),
                    CanonicalValue::Number(CanonicalNumber::from_u16(1)),
                ),
                (
                    "executorIsLeft".into(),
                    CanonicalValue::Bool(side == Side::Left),
                ),
                (
                    "ops".into(),
                    CanonicalValue::Array(vec![CanonicalValue::Object(vec![
                        ("type".into(), CanonicalValue::String("rawDiff".into())),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u16(1)),
                        ),
                        ("leftDiff".into(), CanonicalValue::BigInt((-1).into())),
                        ("rightDiff".into(), CanonicalValue::BigInt((-1).into())),
                        ("collateralDiff".into(), CanonicalValue::BigInt(2.into())),
                        ("ondeltaDiff".into(), CanonicalValue::BigInt(1.into())),
                    ])]),
                ),
            ]),
        };
        let result = SequentialAccountEngine::apply_with_context(&base, side, &tx, &context())
            .expect("typed settlement hold rejection");
        let AccountVerdict::Rejected(reason) = result.verdict() else {
            panic!("settlement hold overflow accepted");
        };
        let label = if side == Side::Left { "left" } else { "right" };
        assert_eq!(reason.code(), "ACCOUNT_TX_VALIDATION");
        assert_eq!(
            reason.message(),
            format!("HOLD_ADD_OVERFLOW:{label} hold={maximum} amount=1")
        );
        assert!(result.candidate().is_none());
        assert!(result.events().is_empty());
        assert!(result.outputs().is_empty());
        assert_eq!(base.state().deltas_root(), before);
        assert!(base.state().settlement_workspace().is_none());
        assert_eq!(
            base.state()
                .delta(token(1))
                .expect("delta")
                .hold(side.opposite()),
            &BigInt::from(0)
        );
    }
}
