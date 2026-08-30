mod common;
mod htlc_support;

use xln_rscore_engine::{
    AccountOutput, AccountTx, AccountVerdict, HtlcResolveOutcome, HtlcResolveTx,
    OpaqueHtlcCiphertext, SequentialAccountEngine, Side, encode_htlc_lock_value,
    htlc_lock_radix_key, htlc_lock_value_digest,
};

use common::token;
use htlc_support::{
    HASHLOCK, SECRET, commit_lock, execution_context, hex32, left_base, lock_tx, right_base,
};

#[test]
fn left_lock_and_secret_match_literal_typescript_map_roots() {
    let base = left_base(100);
    assert_eq!(
        hex32(base.state().deltas_root()),
        "74625d60a432c93831fc7e359b4eaab5adaeaa66cbf46acd5de999a219bc708e"
    );
    assert_eq!(
        hex32(base.state().htlc_locks_root()),
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
    let locked = commit_lock(&base, Side::Left, HASHLOCK);
    let lock = locked.state().htlc_lock(HASHLOCK).expect("stored lock");
    assert_eq!(lock.hashlock().as_str(), HASHLOCK);
    assert_eq!(lock.sender(), Side::Left);
    assert_eq!(lock.created_height(), 7);
    assert_eq!(lock.created_timestamp(), 1_000);
    assert_eq!(lock.envelope_hash(), None);
    assert_eq!(
        hex::encode(htlc_lock_radix_key(HASHLOCK).expect("literal lock key")),
        "0042307863656263383838326665636265633766623830643263663462333132626563303138383834633264363636363763363761393035303832313462643862616663"
    );
    let encoded = encode_htlc_lock_value(lock).expect("literal lock value");
    assert_eq!(
        hex::encode(&encoded),
        "f9015a866f626a656374d186616d6f756e74c986626967696e74000ad78d63726561746564486569676874c8866e756d62657237de906372656174656454696d657374616d70cc866e756d6265728431303030f85688686173686c6f636bf84b86737472696e67b842307863656263383838326665636265633766623830643263663462333132626563303138383834633264363636363763363761393035303832313462643862616663f854866c6f636b4964f84b86737472696e67b842307863656263383838326665636265633766623830643263663462333132626563303138383834633264363636363763363761393035303832313462643862616663de9272657665616c4265666f7265486569676874ca866e756d626572823230d48c73656e64657249734c656674c684626f6f6c01d58874696d656c6f636bcb86626967696e74008207d0d187746f6b656e4964c8866e756d62657231"
    );
    assert_eq!(
        hex32(htlc_lock_value_digest(lock).expect("literal lock digest")),
        "1e802c4f076422b51fc10f8a53645f0881720fff9529873a769418ed4c0a7204"
    );
    assert_eq!(
        locked
            .state()
            .delta(token(1))
            .expect("delta")
            .hold(Side::Left),
        &10.into()
    );
    assert_eq!(
        hex32(locked.state().deltas_root()),
        "ee1dacea6564fb9165669b55ffdb64bea2ed887968d71b5812fd8cf722d4ca3a"
    );
    assert_eq!(
        hex32(locked.state().htlc_locks_root()),
        "023cfa884d265e387e9d0e18b86591dae4a68f17e2a258e910f2644fa861aa8a"
    );
    let lock_changes = locked.state().htlc_node_changes_since(base.state());
    assert!(!lock_changes.puts.is_empty());
    assert!(lock_changes.dels.is_empty());

    let resolved = SequentialAccountEngine::apply_with_context(
        &locked,
        Side::Right,
        &AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: HASHLOCK.into(),
            outcome: HtlcResolveOutcome::Secret {
                secret: SECRET.into(),
            },
        }),
        &execution_context(1_999, 20),
    )
    .expect("secret resolution");
    assert_eq!(resolved.verdict(), &AccountVerdict::Applied);
    assert_eq!(
        resolved.outputs(),
        &[AccountOutput::HtlcSecret {
            lock_id: HASHLOCK.into(),
            hashlock: HASHLOCK.into(),
            secret: SECRET.into(),
            token_id: token(1),
            amount: 10.into(),
        }]
    );
    let candidate = resolved.candidate().expect("secret candidate");
    let delta = candidate.state().delta(token(1)).expect("delta");
    assert_eq!(delta.hold(Side::Left), &0.into());
    assert_eq!(delta.offdelta(), &(-10).into());
    assert_eq!(
        hex32(candidate.state().deltas_root()),
        "e513a527f6a0cfad7195ac4df04b59bd4691d5aab807055b3c0da5f7008760e8"
    );
    assert_eq!(
        hex32(candidate.state().htlc_locks_root()),
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
    let deletion = candidate.state().htlc_node_changes_since(locked.state());
    assert!(deletion.puts.is_empty());
    assert!(!deletion.dels.is_empty());
    assert_eq!(
        hex32(base.state().deltas_root()),
        "74625d60a432c93831fc7e359b4eaab5adaeaa66cbf46acd5de999a219bc708e"
    );
}

#[test]
fn right_lock_and_secret_match_literal_typescript_map_roots() {
    let base = right_base(100);
    assert_eq!(
        hex32(base.state().deltas_root()),
        "eb3d73b9f3ebca87c91e2f47df2505efa732184789f860762ef31f0ec54b2f9b"
    );
    let locked = commit_lock(&base, Side::Right, HASHLOCK);
    let delta = locked.state().delta(token(1)).expect("delta");
    assert_eq!(delta.hold(Side::Right), &10.into());
    assert_eq!(
        hex32(locked.state().deltas_root()),
        "ab9bdc1be5884b349b004651f8b63840fc626bd2279f2a04cc3a1a9f9a771d83"
    );
    assert_eq!(
        hex32(locked.state().htlc_locks_root()),
        "e1a1c90ee03d3f4cbd0fb6ad7dd53838466bcb83fecbbc9a9de2f5523ecbe255"
    );

    let resolved = SequentialAccountEngine::apply_with_context(
        &locked,
        Side::Left,
        &AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: HASHLOCK.into(),
            outcome: HtlcResolveOutcome::Secret {
                secret: SECRET.into(),
            },
        }),
        &execution_context(1_999, 20),
    )
    .expect("secret resolution");
    let candidate = resolved.candidate().expect("secret candidate");
    let delta = candidate.state().delta(token(1)).expect("delta");
    assert_eq!(delta.hold(Side::Right), &0.into());
    assert_eq!(delta.offdelta(), &10.into());
    assert_eq!(
        hex32(candidate.state().deltas_root()),
        "c5a68f3279c666b9cfa1c9d7c37322827903213e3fef647f4e464708c05205cf"
    );
    assert_eq!(
        hex32(candidate.state().htlc_locks_root()),
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
}

#[test]
fn error_output_preserves_lock_identity_and_returns_exact_base_root() {
    let base = left_base(100);
    let locked = commit_lock(&base, Side::Left, HASHLOCK);
    let transition = SequentialAccountEngine::apply_with_context(
        &locked,
        Side::Right,
        &AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: HASHLOCK.into(),
            outcome: HtlcResolveOutcome::Error {
                reason: Some(String::new()),
            },
        }),
        &execution_context(1_999, 10),
    )
    .expect("beneficiary error resolution");
    assert_eq!(
        transition.outputs(),
        &[AccountOutput::HtlcError {
            lock_id: HASHLOCK.into(),
            hashlock: HASHLOCK.into(),
            token_id: token(1),
            amount: 10.into(),
            reason: Some(String::new()),
        }]
    );
    let candidate = transition.candidate().expect("error candidate");
    assert_eq!(
        hex32(candidate.state().deltas_root()),
        "74625d60a432c93831fc7e359b4eaab5adaeaa66cbf46acd5de999a219bc708e"
    );
    assert_eq!(
        hex32(candidate.state().htlc_locks_root()),
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
}

#[test]
fn opaque_envelope_hash_changes_only_the_lock_commitment() {
    let base = left_base(100);
    let mut tx = lock_tx(HASHLOCK, 10.into());
    let AccountTx::HtlcLock(lock) = &mut tx else {
        unreachable!("literal HTLC lock")
    };
    lock.envelope =
        Some(OpaqueHtlcCiphertext::from_packed((0_u8..48).collect()).expect("literal envelope"));
    let transition = SequentialAccountEngine::apply_with_context(
        &base,
        Side::Left,
        &tx,
        &execution_context(1_000, 10),
    )
    .expect("enveloped lock");
    let candidate = transition.candidate().expect("enveloped candidate");
    let stored = candidate.state().htlc_lock(HASHLOCK).expect("stored lock");
    assert_eq!(
        stored.envelope_hash_hex().as_deref(),
        Some("0x4dbdc2b2b62cb00749785bc84202236dbc3777d74660611b8e58812f0cfde6c3")
    );
    assert_eq!(
        hex32(htlc_lock_value_digest(stored).expect("lock digest")),
        "06ba56432de2afc17c609a2528735f1eb104b098a1cf797df28cd06fb1e5929c"
    );
    assert_eq!(
        hex32(candidate.state().htlc_locks_root()),
        "2d9869b357231f3b2ce74438f7e97a6f739efc308e586bf38d082d28d5dfa80e"
    );
    assert_eq!(
        hex32(candidate.state().deltas_root()),
        "ee1dacea6564fb9165669b55ffdb64bea2ed887968d71b5812fd8cf722d4ca3a"
    );
}
