//! The recovery proof both engines must build byte for byte.
//!
//! The hashes here were produced by TypeScript's own builder
//! (core/protocol/dispute/proof-builder.ts) over the same account, and they are
//! what the account leaf commits: a body that hashes differently is a proof the
//! counterparty never agreed to and the jurisdiction would not accept.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState,
    AccountStateSeed, Delta, DepositoryAddress, EntityId, HtlcHashlock, HtlcLock, Side, SwapOffer,
    TokenId, WatchSeed, build_dispute_proof,
};

const TRANSFORMER: [u8; 20] = [0x11; 20];

fn hex_32(bytes: &[u8; 32]) -> String {
    bytes.iter().fold(String::from("0x"), |mut text, byte| {
        use std::fmt::Write as _;
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn delta(token_id: u32, offdelta: i64) -> Delta {
    Delta::new(
        TokenId::new(token_id).expect("token"),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(offdelta),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta")
}

fn lock(
    id: &str,
    token_id: u32,
    sender: Side,
    amount: i64,
    timelock: i64,
    hash_byte: u8,
) -> HtlcLock {
    HtlcLock::restore(
        id.to_string(),
        HtlcHashlock::parse(&format!("0x{}", format!("{hash_byte:02x}").repeat(32)))
            .expect("hashlock"),
        BigInt::from(timelock),
        8,
        BigInt::from(amount),
        TokenId::new(token_id).expect("token"),
        sender,
        0,
        0,
        None,
    )
    .expect("lock")
}

fn replica(locks: Vec<HtlcLock>, offers: Vec<SwapOffer>) -> AccountReplica {
    let left = EntityId::parse(&format!("0x{}", "01".repeat(32))).expect("left");
    let right = EntityId::parse(&format!("0x{}", "02".repeat(32))).expect("right");
    let identity = AccountIdentity::new(
        AccountDomain::new(
            31_337,
            DepositoryAddress::parse("0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1")
                .expect("depository"),
        )
        .expect("domain"),
        left.clone(),
        right,
        WatchSeed::parse(&format!("0x{}", "11".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let state = AccountState::restore_full(AccountStateSeed {
        identity,
        dispute_config: AccountDisputeConfig::new(3_600, 86_400).expect("dispute config"),
        deltas: vec![delta(1, -50), delta(2, 7)],
        locks,
        j_nonce: 0,
        last_finalized_j_height: 0,
        carried: Default::default(),
        rebalance_fee_policies: Vec::new(),
        swap_offers: offers,
        lending_intents: Vec::new(),
    })
    .expect("state");
    AccountReplica::new(left, state).expect("replica")
}

fn offer() -> SwapOffer {
    SwapOffer::new(
        "offer-1".to_string(),
        1,
        6,
        BigInt::from(1_000),
        2,
        6,
        BigInt::from(2_000),
        BigInt::from(0),
        BigInt::from(1),
        BigInt::from(0),
        None,
        true,
        0,
    )
}

#[test]
fn a_body_with_only_deltas_hashes_as_typescript_hashes_it() {
    let proof =
        build_dispute_proof(&replica(Vec::new(), Vec::new()), &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0x848680ecc45b1a3cf9505d068e956f6d93d7810b8cc3a98e6758b5e8612833e6"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0xc9c35e7f41081a0a4a9cbebfc4d3bb4133cd509e5597fad4fb6db69c8e725bdd"
    );
}

/// Two locks, seeded out of order: the clause is ordered by lock id, not by
/// arrival, or the two sides would sign different bodies for the same account.
#[test]
fn locks_become_a_payment_clause_ordered_by_lock_id() {
    let locks = vec![
        lock(
            &format!("0x{}", "b1".repeat(32)),
            2,
            Side::Right,
            25,
            1_700_000_001_000,
            0xab,
        ),
        lock(
            &format!("0x{}", "a1".repeat(32)),
            1,
            Side::Left,
            40,
            1_700_000_000_000,
            0xcd,
        ),
    ];
    let proof = build_dispute_proof(&replica(locks, Vec::new()), &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0x7ebceac0e674263ab459f7149e83f067603cf6c9a40dc952815c86de630fdaaf"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0x7fc1b106b3b875abca2019e51aa2f6b8ea60321f173e8bb4a1ab0331f75b6065"
    );
}

/// A resting offer is a second clause after the payments, with its own
/// allowances.
#[test]
fn a_resting_offer_becomes_its_own_swap_clause() {
    let locks = vec![lock(
        &format!("0x{}", "a1".repeat(32)),
        1,
        Side::Left,
        40,
        1_700_000_000_000,
        0xcd,
    )];
    let proof =
        build_dispute_proof(&replica(locks, vec![offer()]), &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0xed4be0ef2b9c8ca7bf6bcf3080f852c7e944f39787e054af054330fea074f269"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0x79c03688ab8052914b50f8a32ef49ee11ffc629b93be55aafe011b5274db4083"
    );
}
