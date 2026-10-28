#[path = "../../../../fixtures/lending-oracle.rs"]
mod lending_oracle;

#[path = "../common/mod.rs"]
mod common;

use common::{entity, entity_text, replica, token};
use xln_rscore_engine::{
    AccountTx, AccountVerdict, Delta, LendingTermId, SequentialAccountEngine, Side,
};

#[test]
fn savings_funding_spends_only_owned_assets() {
    let fixture = lending_oracle::lending_oracle("account-semantics/lending-edges");
    for row in fixture["ownership"].as_array().unwrap() {
        let left = row["byLeft"].as_bool().unwrap();
        let side = if left { Side::Left } else { Side::Right };
        let owned = row["owned"].as_i64().unwrap();
        let credit = row["credit"].as_i64().unwrap();
        let hold = row["hold"].as_i64().unwrap();
        let amount = row["amount"].as_i64().unwrap();
        let ts_accepted = row["result"]["verdict"] == "applied";
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
        let transition = SequentialAccountEngine::apply_with_context(
            &base,
            side,
            &tx,
            &xln_rscore_engine::AccountExecutionContext::new(1000, 1000, 0, 1, 0),
        )
        .expect("transition");
        assert_eq!(
            matches!(transition.verdict(), AccountVerdict::Rejected(_)),
            !ts_accepted,
            "side={side:?} owned={owned} credit={credit} hold={hold} amount={amount}"
        );
        assert_eq!(
            base.state()
                .payment_profile_account_state_root()
                .expect("root"),
            before
        );
        assert_eq!(transition.candidate().is_some(), ts_accepted);
        assert!(transition.outputs().is_empty());
        assert_eq!(base.state().lending_intent_count(), 0);
    }
}
