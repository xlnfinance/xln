use num_bigint::BigInt;

use crate::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity,
    AccountRejection, AccountReplica, AccountState, AccountTx, AccountVerdict, Delta,
    DepositoryAddress, EntityId, HtlcHashlock, HtlcLockTx, HtlcRejection, HtlcResolveOutcome,
    HtlcResolveTx, SequentialAccountEngine, Side, TokenId, ValidationRejection, WatchSeed,
};

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("literal entity")
}

fn replica() -> AccountReplica {
    let identity = AccountIdentity::new(
        AccountDomain::new(
            31_337,
            DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                .expect("literal depository"),
        )
        .expect("literal domain"),
        entity(0x11),
        entity(0x22),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("literal watch seed"),
    )
    .expect("canonical identity");
    let delta = Delta::new(
        TokenId::new(1).expect("literal token"),
        0.into(),
        0.into(),
        0.into(),
        100.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("literal delta");
    AccountReplica::new(
        entity(0x11),
        AccountState::new(
            identity,
            AccountDisputeConfig::new(10, 10).expect("literal dispute config"),
            vec![delta],
        )
        .expect("literal state"),
    )
    .expect("literal replica")
}

#[test]
fn hold_underflow_is_a_typed_atomic_rejection() {
    let context = AccountExecutionContext::new(1_000, 1_000, 10, 7, 10);
    let token_id = TokenId::new(1).expect("literal token");
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: "underflow".into(),
        hashlock: HtlcHashlock::parse(
            "0xcebc8882fecbec7fb80d2cf4b312bec018884c2d66667c67a90508214bd8bafc",
        )
        .expect("literal hashlock"),
        timelock: 2_000.into(),
        reveal_before_height: 20,
        amount: 10.into(),
        token_id,
        delivery_mode: None,
        envelope: None,
    });
    let mut corrupted =
        SequentialAccountEngine::apply_with_context(&replica(), Side::Left, &lock, &context)
            .expect("lock transition")
            .committed()
            .expect("lock candidate");
    let zero_hold = Delta::new(
        token_id,
        0.into(),
        0.into(),
        0.into(),
        100.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("zero-hold delta");
    corrupted
        .state_mut()
        .put_delta(zero_hold)
        .expect("construct underflow fixture");

    let resolve = AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: "underflow".into(),
        outcome: HtlcResolveOutcome::Error {
            reason: Some("downstream".into()),
        },
    });
    let rejected =
        SequentialAccountEngine::apply_with_context(&corrupted, Side::Right, &resolve, &context)
            .expect("typed underflow rejection");
    assert!(matches!(
        rejected.verdict(),
        AccountVerdict::Rejected(AccountRejection::Validation(ValidationRejection::Htlc(
            HtlcRejection::HoldUnderflow { side: Side::Left, hold, amount }
        ))) if hold == &BigInt::from(0) && amount == &BigInt::from(10)
    ));
    assert!(rejected.candidate().is_none());
    assert!(rejected.outputs().is_empty());
}
