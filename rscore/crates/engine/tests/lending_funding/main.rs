#[path = "../common/mod.rs"]
mod common;

use common::{entity, entity_text, replica, token};
use xln_rscore_engine::{
    AccountTx, AccountVerdict, Delta, LendingTermId, SequentialAccountEngine, Side,
};

#[test]
fn unsupported_lending_never_moves_owned_or_borrowed_assets() {
    // Even previously accepted pool deposits must reject without touching funds.
    let vectors: [(i64, i64, i64, i64, bool); 7] = [
        (0, 100, 0, 100, false),
        (100, 0, 0, 100, true),
        (40, 100, 0, 41, false),
        (40, 100, 0, 40, true),
        (100, 100, 60, 41, false),
        (100, 100, 60, 40, true),
        (-20, 100, 0, 1, false),
    ];
    for side in [Side::Left, Side::Right] {
        let left = side == Side::Left;
        for (owned, credit, hold, amount, _ts_accepted) in vectors {
            let old_offdelta = if left { owned } else { -owned };
            let delta = Delta::new(
                token(1),
                0.into(),
                0.into(),
                old_offdelta.into(),
                (if left { credit } else { 100 }).into(),
                (if left { 100 } else { credit }).into(),
                0.into(),
                0.into(),
                (if left { hold } else { 0 }).into(),
                (if left { 0 } else { hold }).into(),
            )
            .expect("valid delta");
            let base = replica(entity(0x10), entity(0x10), entity(0x20), vec![delta]);
            let before = base
                .state()
                .payment_profile_account_state_root()
                .expect("root");
            let tx = AccountTx::LendingFund {
                position_id: "lend-1111111111111111".into(),
                hub_entity_id: entity_text(if left { 0x20 } else { 0x10 }),
                lender_entity_id: entity_text(if left { 0x10 } else { 0x20 }),
                token_id: token(1),
                amount: amount.into(),
                term_id: LendingTermId::OneDay,
                interest_bps: 100,
            };
            let transition = SequentialAccountEngine::apply(&base, side, &tx).expect("transition");
            assert_eq!(
                matches!(transition.verdict(), AccountVerdict::Rejected(_)),
                true,
                "side={side:?} owned={owned} credit={credit} hold={hold} amount={amount}"
            );
            assert_eq!(
                base.state()
                    .payment_profile_account_state_root()
                    .expect("root"),
                before
            );
            assert!(transition.candidate().is_none());
            assert!(transition.outputs().is_empty());
            assert_eq!(base.state().lending_intent_count(), 0);
            assert_eq!(
                common::rejected_message(SequentialAccountEngine::apply(&base, side, &tx)),
                "LENDING_UNSUPPORTED:lending_fund"
            );
        }
    }
}
