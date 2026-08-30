mod common;
#[allow(dead_code)]
mod htlc_support;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountRejection, AccountTx, AccountVerdict, HtlcBoundaryError, HtlcHashlock, HtlcLockTx,
    HtlcRejection, HtlcResolveOutcome, HtlcResolveTx, OpaqueHtlcCiphertext,
    SequentialAccountEngine, Side, TransitionError, ValidationRejection,
};

use htlc_support::{HASHLOCK, SECRET, commit_lock, execution_context, left_base, lock_tx};

fn rejected_message(
    base: &xln_rscore_engine::AccountReplica,
    proposer: Side,
    tx: &AccountTx,
    timestamp: u64,
    j_height: u64,
) -> (String, String) {
    let transition = SequentialAccountEngine::apply_with_context(
        base,
        proposer,
        tx,
        &execution_context(timestamp, j_height),
    )
    .expect("deterministic HTLC rejection");
    let AccountVerdict::Rejected(rejection) = transition.verdict() else {
        assert!(
            transition.candidate().is_none(),
            "expected rejected transition"
        );
        return (String::new(), String::new());
    };
    assert!(transition.candidate().is_none());
    assert!(transition.outputs().is_empty());
    (rejection.code().into(), rejection.message())
}

fn resolve(lock_id: &str, outcome: HtlcResolveOutcome) -> AccountTx {
    AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: lock_id.into(),
        outcome,
    })
}

fn indexed_lock(index: u8, amount: BigInt) -> AccountTx {
    let hashlock = format!("0x{index:02x}{}", "00".repeat(31));
    let mut tx = lock_tx(&hashlock, amount);
    let AccountTx::HtlcLock(lock) = &mut tx else {
        unreachable!("fixture is an HTLC lock")
    };
    lock.hashlock = HtlcHashlock::parse(&hashlock).expect("indexed hashlock");
    tx
}

#[test]
fn decoder_boundaries_are_canonical_and_fail_loudly() {
    assert_eq!(
        HtlcHashlock::parse(HASHLOCK.to_ascii_uppercase().as_str()),
        Err(HtlcBoundaryError::InvalidHashlock(
            HASHLOCK.to_ascii_uppercase()
        ))
    );
    assert_eq!(
        OpaqueHtlcCiphertext::from_packed(vec![0; 47]),
        Err(HtlcBoundaryError::InvalidEnvelopeSize)
    );
    assert_eq!(
        OpaqueHtlcCiphertext::parse("wrong", &"A".repeat(64)),
        Err(HtlcBoundaryError::InvalidEnvelopeVersion("wrong".into()))
    );
    let canonical = OpaqueHtlcCiphertext::parse("xln:htlc-opaque:aes-gcm", &"A".repeat(64))
        .expect("canonical 48-byte envelope");
    assert_eq!(canonical.packed(), &[0; 48]);
}

#[test]
fn reveal_height_boundary_matches_typescript_safe_integer_range() {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    let base = left_base(100);
    let mut maximum_height = lock_tx(HASHLOCK, 10.into());
    let AccountTx::HtlcLock(lock) = &mut maximum_height else {
        unreachable!("fixture is an HTLC lock")
    };
    lock.reveal_before_height = MAX_SAFE_INTEGER;
    let accepted = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &maximum_height,
        &execution_context(1_000, 10),
    )
    .expect("Number.MAX_SAFE_INTEGER is a valid TypeScript integer boundary");
    assert_eq!(accepted.verdict(), &AccountVerdict::Applied);
    assert_eq!(
        accepted
            .candidate()
            .expect("accepted lock candidate")
            .state()
            .htlc_lock(HASHLOCK)
            .expect("committed maximum-height lock")
            .reveal_before_height(),
        MAX_SAFE_INTEGER,
    );

    let mut unsafe_height = lock_tx(HASHLOCK, 10.into());
    let AccountTx::HtlcLock(lock) = &mut unsafe_height else {
        unreachable!("fixture is an HTLC lock")
    };
    lock.reveal_before_height = MAX_SAFE_INTEGER + 1;
    let before_delta_root = base.state().deltas_root();
    let before_locks_root = base.state().htlc_locks_root();
    let result = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &unsafe_height,
        &execution_context(1_000, 10),
    );
    assert!(matches!(
        result,
        Err(TransitionError::HtlcBoundary(
            HtlcBoundaryError::RevealBeforeHeightUnsafe {
                value,
                maximum: MAX_SAFE_INTEGER,
            }
        )) if value == MAX_SAFE_INTEGER + 1
    ));
    assert_eq!(base.state().deltas_root(), before_delta_root);
    assert_eq!(base.state().htlc_locks_root(), before_locks_root);
}

#[test]
fn lock_validation_order_and_inclusive_deadlines_match_typescript() {
    let base = left_base(100);
    assert_eq!(
        rejected_message(&base, Side::Left, &lock_tx(HASHLOCK, 10.into()), 2_000, 10).1,
        "Timelock 2000 already expired (timestamp)"
    );
    assert_eq!(
        rejected_message(&base, Side::Left, &lock_tx(HASHLOCK, 10.into()), 1_999, 20).1,
        "revealBeforeHeight 20 already passed (current J height: 20)"
    );
    assert_eq!(
        rejected_message(&base, Side::Left, &lock_tx(HASHLOCK, 0.into()), 1_000, 10).1,
        "Invalid amount: 0 (min 1, max 340282366920938463463374607431768211455)"
    );
    let too_large = BigInt::from(1_u8) << 128;
    assert_eq!(
        rejected_message(&base, Side::Left, &lock_tx(HASHLOCK, too_large), 1_000, 10).1,
        "Invalid amount: 340282366920938463463374607431768211456 (min 1, max 340282366920938463463374607431768211455)"
    );

    let accepted = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &lock_tx(HASHLOCK, 100.into()),
        &execution_context(1_000, 10),
    )
    .expect("capacity equality");
    assert_eq!(accepted.verdict(), &AccountVerdict::Applied);
    assert_eq!(
        rejected_message(&base, Side::Left, &lock_tx(HASHLOCK, 101.into()), 1_000, 10,).1,
        "Insufficient capacity: need 101, available 100"
    );

    let locked = commit_lock(&base, Side::Left, HASHLOCK);
    let duplicate = rejected_message(&locked, Side::Left, &lock_tx(HASHLOCK, 0.into()), 2_000, 20);
    assert_eq!(duplicate.0, "ACCOUNT_TX_VALIDATION");
    assert_eq!(duplicate.1, format!("Lock {HASHLOCK} already exists"));
}

#[test]
fn thirty_third_lock_has_typed_capacity_disposition() {
    let mut current = left_base(100);
    for index in 0..32 {
        let tx = indexed_lock(index + 1, 1.into());
        current = SequentialAccountEngine::apply_with_context(
            &current,
            Side::Left,
            &tx,
            &execution_context(1_000, 10),
        )
        .expect("bounded HTLC lock")
        .committed()
        .expect("lock candidate");
    }
    assert_eq!(current.state().htlc_count(), 32);
    assert_eq!(
        rejected_message(&current, Side::Left, &indexed_lock(33, 1.into()), 1_000, 10,),
        (
            "ACCOUNT_HTLC_LOCK_CAPACITY".into(),
            "Too many active HTLC locks: max 32".into(),
        )
    );
}

#[test]
fn secret_validation_is_deadline_first_and_j_height_is_resolve_inclusive() {
    let base = left_base(100);
    let locked = commit_lock(&base, Side::Left, HASHLOCK);
    let at_height = SequentialAccountEngine::apply_with_context(
        &locked,
        Side::Right,
        &resolve(
            HASHLOCK,
            HtlcResolveOutcome::Secret {
                secret: SECRET.into(),
            },
        ),
        &execution_context(1_999, 20),
    )
    .expect("inclusive J boundary");
    assert_eq!(at_height.verdict(), &AccountVerdict::Applied);

    let malformed = resolve(
        HASHLOCK,
        HtlcResolveOutcome::Secret {
            secret: "not-hex".into(),
        },
    );
    assert_eq!(
        rejected_message(&locked, Side::Right, &malformed, 1_999, 10).1,
        "Invalid secret: HTLC secret must be 32-byte hex (got 7 chars)"
    );
    assert_eq!(
        rejected_message(&locked, Side::Right, &malformed, 2_000, 10).1,
        "Lock expired: timestamp=2000/2000 jHeight=10/20"
    );
    assert_eq!(
        rejected_message(&locked, Side::Right, &malformed, 1_999, 21).1,
        "Lock expired: timestamp=1999/2000 jHeight=21/20"
    );

    let wrong_secret = "0x0202020202020202020202020202020202020202020202020202020202020202";
    assert_eq!(
        rejected_message(
            &locked,
            Side::Right,
            &resolve(
                HASHLOCK,
                HtlcResolveOutcome::Secret {
                    secret: wrong_secret.into(),
                },
            ),
            1_999,
            10,
        )
        .1,
        "Hash mismatch: expected 0xcebc88..., got 0xee4a07..."
    );
}

#[test]
fn error_authority_and_timeout_boundary_match_typescript() {
    let base = left_base(100);
    let locked = commit_lock(&base, Side::Left, HASHLOCK);
    let custom = resolve(
        HASHLOCK,
        HtlcResolveOutcome::Error {
            reason: Some("downstream".into()),
        },
    );
    assert_eq!(
        rejected_message(&locked, Side::Left, &custom, 1_999, 10).1,
        "Only beneficiary can release an active HTLC; payer can cancel only after expiry"
    );
    let timeout = resolve(
        HASHLOCK,
        HtlcResolveOutcome::Error {
            reason: Some("timeout".into()),
        },
    );
    assert_eq!(
        rejected_message(&locked, Side::Right, &timeout, 1_999, 20).1,
        "Lock not expired yet"
    );
    let expired_payer = SequentialAccountEngine::apply_with_context(
        &locked,
        Side::Left,
        &timeout,
        &execution_context(2_000, 20),
    )
    .expect("payer timeout at timestamp boundary");
    assert_eq!(expired_payer.verdict(), &AccountVerdict::Applied);
}

#[test]
fn typed_htlc_rejection_round_trip_is_not_a_string_fallback() {
    let base = left_base(100);
    let missing = rejected_message(
        &base,
        Side::Right,
        &resolve(
            "missing",
            HtlcResolveOutcome::Error {
                reason: Some("timeout".into()),
            },
        ),
        2_000,
        20,
    );
    assert_eq!(missing.1, "Lock missing not found");

    let transition = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Right,
        &resolve("missing", HtlcResolveOutcome::Error { reason: None }),
        &execution_context(1_000, 10),
    )
    .expect("typed rejection");
    assert!(matches!(
        transition.verdict(),
        AccountVerdict::Rejected(AccountRejection::Validation(ValidationRejection::Htlc(
            HtlcRejection::LockNotFound { lock_id }
        ))) if lock_id == "missing"
    ));
}

#[test]
fn explicit_lock_tx_type_has_no_implicit_timeout_variant() {
    let AccountTx::HtlcLock(HtlcLockTx { delivery_mode, .. }) = lock_tx(HASHLOCK, 1.into()) else {
        unreachable!("literal HTLC lock")
    };
    assert_eq!(delivery_mode, None);
}

#[test]
fn context_required_transitions_never_run_against_a_fake_zero_clock() {
    let error =
        SequentialAccountEngine::apply(&left_base(100), Side::Left, &lock_tx(HASHLOCK, 1.into()))
            .err()
            .expect("context-free HTLC must fail");
    assert_eq!(
        error,
        TransitionError::ExecutionContextRequired("htlc_lock")
    );
}
