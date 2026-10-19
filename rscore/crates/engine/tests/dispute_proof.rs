//! The recovery proof both engines must build byte for byte.
//!
//! The hashes here were independently encoded with ethers AbiCoder against
//! Solidity's Int512/SignedAmount ABI over the same account, and they are
//! what the account leaf commits: a body that hashes differently is a proof the
//! counterparty never agreed to and the jurisdiction would not accept.

#[path = "dispute_proof/external_finality.rs"]
mod dispute_external_finality;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState,
    AccountStateSeed, Delta, DepositoryAddress, EntityId, HtlcHashlock, HtlcLock, Side, SwapOffer,
    TokenId, WatchSeed, build_dispute_proof, build_dispute_proof_body,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

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

fn lock(token_id: u32, sender: Side, amount: i64, timelock: i64, hash_byte: u8) -> HtlcLock {
    let hashlock = format!("0x{}", format!("{hash_byte:02x}").repeat(32));
    HtlcLock::restore(
        hashlock.clone(),
        HtlcHashlock::parse(&hashlock).expect("hashlock"),
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

fn replica_with_pulls(
    locks: Vec<HtlcLock>,
    offers: Vec<SwapOffer>,
    pulls: Vec<(String, CanonicalValue)>,
) -> AccountReplica {
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
        pulls,
        settlement_workspace: None,
    })
    .expect("state");
    AccountReplica::new(left, state).expect("replica")
}

fn replica(locks: Vec<HtlcLock>, offers: Vec<SwapOffer>) -> AccountReplica {
    replica_with_pulls(locks, offers, Vec::new())
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
        "0x4e46dfc2e9edae19d473497dd3059d858c0da39b8c2cc431f591d8705da60c35"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0xbec497f771431e90152c3f494760c280a19ed2644f5e52484a9e0f32f52fd37a"
    );
}

/// Two locks, seeded out of order: the clause is ordered by lock id, not by
/// arrival, or the two sides would sign different bodies for the same account.
#[test]
fn locks_become_a_payment_clause_ordered_by_lock_id() {
    let locks = vec![
        lock(2, Side::Right, 25, 1_700_000_001_000, 0xcd),
        lock(1, Side::Left, 40, 1_700_000_000_000, 0xab),
    ];
    let proof = build_dispute_proof(&replica(locks, Vec::new()), &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0x699027750b98322ad37921c8840f6397540647c76515f73de0b521b6f8d4c1df"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0xe1af0beafea45ed0e148b2e002b1989cb984beef69ea8b0c0de5ceea39a3b2c7"
    );
}

/// A resting offer is a second clause after the payments, with its own
/// allowances.
#[test]
fn a_resting_offer_becomes_its_own_swap_clause() {
    let locks = vec![lock(1, Side::Left, 40, 1_700_000_000_000, 0xcd)];
    let proof =
        build_dispute_proof(&replica(locks, vec![offer()]), &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0xd2161b32b598c9e77e7b13fddf28c525a74ba6d4c60cba3ebd1f97eac7e3f910"
    );
    assert_eq!(
        hex_32(&proof.dispute_hash),
        "0x3ea37cc1ad66e689274e2825f7d0f6b03efd072cc47b13077c5e3238fa288b82"
    );
}

#[test]
fn a_pull_becomes_the_third_canonical_clause_byte_for_byte_with_typescript() {
    let number =
        |value| CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("number"));
    let pull = CanonicalValue::Object(vec![
        ("pullId".into(), CanonicalValue::String("pull-b".into())),
        ("tokenId".into(), number(1)),
        ("amount".into(), CanonicalValue::BigInt(BigInt::from(-25))),
        ("claimedRatio".into(), number(17)),
        (
            "fullHash".into(),
            CanonicalValue::String(format!("0x{}", "aa".repeat(32))),
        ),
        (
            "partialRoot".into(),
            CanonicalValue::String(format!("0x{}", "bb".repeat(32))),
        ),
        (
            "crossJurisdiction".into(),
            CanonicalValue::Object(vec![(
                "leg".into(),
                CanonicalValue::String("target".into()),
            )]),
        ),
        ("createdHeight".into(), number(1)),
        ("createdTimestamp".into(), number(2)),
    ]);
    let replica = replica_with_pulls(Vec::new(), Vec::new(), vec![("pull-b".into(), pull)]);
    let proof = build_dispute_proof(&replica, &TRANSFORMER, 7).expect("proof");
    assert_eq!(
        hex_32(&proof.proof_body_hash),
        "0x5622977e5355dc7161072b4f0545e1932bcfff0986779585f109e14accbd4839"
    );
    let body = build_dispute_proof_body(&replica, &TRANSFORMER).expect("body");
    assert_eq!(body.transformers.len(), 1);
    assert_eq!(
        body.transformers[0]
            .encoded_batch
            .iter()
            .fold(String::from("0x"), |mut text, byte| {
                use std::fmt::Write as _;
                let _ = write!(text, "{byte:02x}");
                text
            }),
        "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000011aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000"
    );
}
