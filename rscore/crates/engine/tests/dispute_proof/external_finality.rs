#[path = "../common/mod.rs"]
mod common;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeFinality, AccountDisputeStartedFinality, CanonicalValue, Delta,
    Side,
};

use common::{entity, replica, token};

fn delta(token_id: u32, collateral: i64, ondelta: i64) -> Delta {
    Delta::new(
        token(token_id),
        BigInt::from(collateral),
        BigInt::from(ondelta),
        BigInt::from(9),
        BigInt::from(101),
        BigInt::from(202),
        BigInt::from(7),
        BigInt::from(8),
        BigInt::from(5),
        BigInt::from(6),
    )
    .expect("delta")
}

#[test]
fn external_dispute_finality_matches_ts_token_scope_and_clears_epoch() {
    let left = entity(0x11);
    let right = entity(0x22);
    let mut account = AccountConsensus::new(replica(
        left.clone(),
        left,
        right,
        vec![delta(1, 10, 11), delta(2, 20, 21)],
    ));
    account
        .apply_entity_dispute_started(AccountDisputeStartedFinality {
            active_dispute: CanonicalValue::Object(vec![(
                "observedOnChain".into(),
                CanonicalValue::Bool(true),
            )]),
            j_nonce: 7,
        })
        .expect("start finality");
    assert_eq!(account.replica().state().j_nonce(), 7);
    assert!(
        account
            .replica()
            .envelope()
            .field("activeDispute")
            .is_some()
    );

    let applied = account
        .apply_entity_dispute_finality(AccountDisputeFinality {
            finalized_j_nonce: 8,
            finalized_token_ids: vec![token(1)],
        })
        .expect("dispute finality");
    assert!(applied.had_active_dispute);
    assert_eq!(account.replica().state().j_nonce(), 8);
    assert!(
        account
            .replica()
            .envelope()
            .field("activeDispute")
            .is_none()
    );

    let finalized = account.replica().state().delta(token(1)).expect("token 1");
    assert_eq!(finalized.collateral(), &BigInt::from(0));
    assert_eq!(finalized.ondelta(), &BigInt::from(0));
    let omitted = account.replica().state().delta(token(2)).expect("token 2");
    assert_eq!(omitted.collateral(), &BigInt::from(20));
    assert_eq!(omitted.ondelta(), &BigInt::from(21));
    for row in [finalized, omitted] {
        assert_eq!(row.offdelta(), &BigInt::from(0));
        assert_eq!(row.hold(Side::Left), &BigInt::from(0));
        assert_eq!(row.hold(Side::Right), &BigInt::from(0));
        assert_eq!(row.allowance(Side::Left), &BigInt::from(0));
        assert_eq!(row.allowance(Side::Right), &BigInt::from(0));
        assert_eq!(row.left_credit_limit(), &BigInt::from(101));
        assert_eq!(row.right_credit_limit(), &BigInt::from(202));
    }
}
