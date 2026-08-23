use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountTx, Delta, DepositoryAddress, EntityId, HtlcHashlock, HtlcLock,
    HtlcLockTx, SequentialAccountEngine, Side, StateError, TokenId, WatchSeed,
};

const TS_EMPTY_PAYMENT_PROFILE_ROOT: &str =
    "de8913dcaf8dd6909741a8e92ecb9fe4abc141ca2848ab27e3944be209f9c7c9";
const TS_LOCKED_PAYMENT_PROFILE_ROOT: &str =
    "489deb94f1c63973379acadc6ec3d1dcbaf85fc698d9a137aad083d2234f5770";
const TS_DELTA_ROOT: &str = "3f4b15cebab6c1e8df774ffa2aad3c47ade3f7bd0e61a99f19a8b413720649af";
const TS_HELD_DELTA_ROOT: &str = "74061e9b344976c34dada6fe39151673651d6e8f35cf57369a4b0363c3030ea2";
const TS_LOCK_ROOT: &str = "c87f54349f8b45ee5ff828f1d59304676ec25a28815a1b99ab73cf18e4e079d5";
const TS_OVERSIZED_DELTA_ROOT: &str =
    "47022f06006fe5cee3c1fda11e8461b4f7efca67f63826b1875293dd37117e1b";
const TS_OVERSIZED_LOCK_ROOT: &str =
    "212475fa8fe9fc483eefcbb22ab471f8082af76d9ec20c7efc78d3be6e0dc8c7";
const TS_OVERSIZED_PAYMENT_PROFILE_ROOT: &str =
    "eee654eea35a97668c455967625fb4b0b417e7a690c26cda7ae9a07c951d60e6";

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("literal entity")
}

fn token(value: u32) -> TokenId {
    TokenId::new(value).expect("literal token")
}

fn identity() -> AccountIdentity {
    AccountIdentity::new(
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
    .expect("canonical identity")
}

fn delta() -> Delta {
    delta_with_left_hold(0.into())
}

fn delta_with_left_hold(left_hold: BigInt) -> Delta {
    Delta::new(
        token(1),
        1_000.into(),
        0.into(),
        0.into(),
        100.into(),
        200.into(),
        0.into(),
        0.into(),
        left_hold,
        0.into(),
    )
    .expect("literal delta")
}

fn lock() -> HtlcLock {
    lock_with_amount(7.into())
}

fn lock_with_amount(amount: BigInt) -> HtlcLock {
    HtlcLock::restore(
        format!("0x{}", "66".repeat(32)),
        HtlcHashlock::parse(&format!("0x{}", "77".repeat(32))).expect("literal hashlock"),
        60_000.into(),
        10,
        amount,
        token(1),
        Side::Left,
        0,
        1_000,
        None,
    )
    .expect("literal lock")
}

fn dispute_config() -> AccountDisputeConfig {
    AccountDisputeConfig::new(10, 10).expect("literal dispute config")
}

#[test]
fn exact_payment_profile_root_matches_typescript_for_genesis() {
    let state = AccountState::new(identity(), dispute_config(), vec![delta()])
        .expect("literal payment state");

    assert_eq!(hex::encode(state.deltas_root()), TS_DELTA_ROOT);
    assert_eq!(hex::encode(state.htlc_locks_root()), "00".repeat(32));
    assert_eq!(
        hex::encode(
            state
                .payment_profile_account_state_root()
                .expect("payment-profile state root"),
        ),
        TS_EMPTY_PAYMENT_PROFILE_ROOT,
    );
}

#[test]
fn exact_payment_profile_root_matches_typescript_with_committed_htlc() {
    let owner = entity(0x11);
    let base = AccountReplica::new(
        owner.clone(),
        AccountState::new(identity(), dispute_config(), vec![delta()])
            .expect("literal payment state"),
    )
    .expect("literal replica");
    let tx = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: format!("0x{}", "66".repeat(32)),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "77".repeat(32))).expect("literal hashlock"),
        timelock: 60_000.into(),
        reveal_before_height: 10,
        amount: 7.into(),
        token_id: token(1),
        delivery_mode: None,
        envelope: None,
    });
    let transitioned = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &tx,
        &AccountExecutionContext::new(1_000, 1_000, 0, 0),
    )
    .expect("reachable lock transition")
    .committed()
    .expect("applied lock");

    let restored = AccountState::restore(
        identity(),
        dispute_config(),
        vec![delta_with_left_hold(7.into())],
        vec![lock()],
    )
    .expect("restored payment state");

    assert_eq!(
        hex::encode(transitioned.state().deltas_root()),
        TS_HELD_DELTA_ROOT
    );
    assert_eq!(
        hex::encode(transitioned.state().htlc_locks_root()),
        TS_LOCK_ROOT
    );
    assert_eq!(
        hex::encode(
            transitioned
                .state()
                .payment_profile_account_state_root()
                .expect("payment-profile state root"),
        ),
        TS_LOCKED_PAYMENT_PROFILE_ROOT,
    );
    assert_eq!(
        restored
            .payment_profile_account_state_root()
            .expect("restored payment-profile root"),
        transitioned
            .state()
            .payment_profile_account_state_root()
            .expect("transitioned payment-profile root"),
    );
}

#[test]
fn restore_accepts_positive_amount_above_live_payment_limit() {
    let amount: BigInt = BigInt::from(1_u8) << 128_usize;
    let state = AccountState::restore(
        identity(),
        dispute_config(),
        vec![delta_with_left_hold(amount.clone())],
        vec![lock_with_amount(amount)],
    )
    .expect("durable state accepts positive bigint above live admission limit");

    assert_eq!(hex::encode(state.deltas_root()), TS_OVERSIZED_DELTA_ROOT);
    assert_eq!(hex::encode(state.htlc_locks_root()), TS_OVERSIZED_LOCK_ROOT);
    assert_eq!(
        hex::encode(
            state
                .payment_profile_account_state_root()
                .expect("oversized payment-profile state root"),
        ),
        TS_OVERSIZED_PAYMENT_PROFILE_ROOT,
    );
}

#[test]
fn restore_rejects_noncanonical_or_duplicate_htlcs() {
    let invalid = HtlcLock::restore(
        "lock-1".into(),
        HtlcHashlock::parse(&format!("0x{}", "77".repeat(32))).expect("literal hashlock"),
        60_000.into(),
        10,
        7.into(),
        token(1),
        Side::Left,
        0,
        1_000,
        None,
    );
    assert!(matches!(
        invalid,
        Err(StateError::InvalidHtlcRestore {
            field: "lockId",
            ..
        })
    ));

    let duplicate = AccountState::restore(
        identity(),
        dispute_config(),
        vec![delta()],
        vec![lock(), lock()],
    );
    assert!(matches!(duplicate, Err(StateError::DuplicateHtlcLock(_))));
}

#[test]
fn dispute_clock_validation_matches_typescript_boundary() {
    assert!(AccountDisputeConfig::new(0, 0).is_ok());
    assert!(matches!(
        AccountDisputeConfig::new(u64::from(u32::MAX) + 1, 0),
        Err(StateError::InvalidDisputeResponseSeconds { side: "LEFT", .. })
    ));
    assert!(matches!(
        AccountDisputeConfig::new(365 * 24 * 60 * 60, 1),
        Err(StateError::DisputeResponseTotalExceeded(_))
    ));
}
