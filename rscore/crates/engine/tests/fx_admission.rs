//! FX-1/FX-2 admission parity (proofs/fixes.md, decisions D2/D3).
//!
//! Verdict mapping to the TypeScript twin
//! (core/__tests__/proofs/fx-admission.test.ts) — same accept/reject
//! classification per case, different transport for the same verdict:
//!
//! - local admission: every canonical AccountTx kind is hashable; malformed
//!   fields such as an unsafe policyVersion retain their exact typed error and
//!   leave the mempool unchanged.
//! - incoming peer frame: `apply_incoming_frame` returns `Rejected` whose
//!   reason carries `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE` /
//!   `ACCOUNT_FRAME_TX_UNSUPPORTED:<kind>` (refused by `AccountFrame::hash`);
//!   TypeScript preflight returns peer codes
//!   `ACCOUNT_INPUT_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE` /
//!   `ACCOUNT_INPUT_FRAME_TX_OUT_OF_PROFILE` before replay.
//! - boundary accept (policyVersion 0 and MAX): both engines admit; the
//!   golden `matches_typescript_rebalance_policy_bytes_and_hashes` in
//!   consensus/frame/hash.rs already pins MAX hashing identically.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountFrame, AccountIdentity,
    AccountReplica, AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress,
    EntityId, IncomingFrame, IncomingOutcome, MAX_POLICY_VERSION, ReceiverClock, ReserveSide,
    SigningIdentity, TokenId, WatchSeed, apply_incoming_frame,
};

const CLOCK: ReceiverClock = ReceiverClock {
    entity_timestamp: 1_700_000_000_010,
    finalized_j_height: 7,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

struct Party {
    account: AccountConsensus,
    identity: SigningIdentity,
    entity_id: EntityId,
}

fn entity_hex(bytes: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn account_state(left: &EntityId, right: &EntityId) -> AccountState {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000),
        BigInt::from(500_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state")
}

fn parties() -> (Party, Party) {
    let first = SigningIdentity::lazy_from_seed(SEED, "1", 1, 1, BoardDelays::default())
        .expect("identity 1");
    let second = SigningIdentity::lazy_from_seed(SEED, "2", 1, 1, BoardDelays::default())
        .expect("identity 2");
    let first_entity = EntityId::parse(&entity_hex(first.entity_id())).expect("entity 1");
    let second_entity = EntityId::parse(&entity_hex(second.entity_id())).expect("entity 2");
    let (left_entity, right_entity, left_identity, right_identity) =
        if first_entity.to_string() < second_entity.to_string() {
            (first_entity, second_entity, first, second)
        } else {
            (second_entity, first_entity, second, first)
        };
    let state = account_state(&left_entity, &right_entity);
    (
        Party {
            account: AccountConsensus::new(
                AccountReplica::new(left_entity.clone(), state.clone()).expect("left replica"),
            ),
            identity: left_identity,
            entity_id: left_entity,
        },
        Party {
            account: AccountConsensus::new(
                AccountReplica::new(right_entity.clone(), state).expect("right replica"),
            ),
            identity: right_identity,
            entity_id: right_entity,
        },
    )
}

fn market() -> std::sync::Arc<xln_rscore_engine::SwapMarketPolicy> {
    std::sync::Arc::default()
}

fn rebalance_policy(policy_version: u64) -> AccountTx {
    AccountTx::RebalancePolicy {
        token_id: 1,
        policy_version,
        base_fee: BigInt::from(1),
        liquidity_fee_bps: BigInt::from(375),
        gas_fee: BigInt::from(1),
    }
}

fn extended_transactions() -> Vec<(&'static str, AccountTx)> {
    let token = TokenId::new(1).expect("token");
    vec![
        (
            "lending_fund",
            AccountTx::LendingFund {
                position_id: "position-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                lender_entity_id: "0xlender".to_string(),
                token_id: token,
                amount: BigInt::from(10),
                term_id: xln_rscore_engine::LendingTermId::OneDay,
                interest_bps: 100,
            },
        ),
        (
            "lending_borrow_request",
            AccountTx::LendingBorrowRequest {
                request_id: "request-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                borrower_entity_id: "0xborrower".to_string(),
                token_id: 1,
                amount: BigInt::from(10),
                term_id: xln_rscore_engine::LendingTermId::OneDay,
                max_interest_bps: 100,
            },
        ),
        (
            "lending_repay",
            AccountTx::LendingRepay {
                loan_id: "loan-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                borrower_entity_id: "0xborrower".to_string(),
                token_id: token,
                amount: BigInt::from(10),
            },
        ),
        (
            "lending_credit",
            AccountTx::LendingCredit {
                action: xln_rscore_engine::LendingAction::Grant,
                loan_id: "loan-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                borrower_entity_id: "0xborrower".to_string(),
                token_id: token,
                credit_limit: BigInt::from(10),
            },
        ),
        (
            "lending_close_request",
            AccountTx::LendingCloseRequest {
                position_id: "position-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                lender_entity_id: "0xlender".to_string(),
            },
        ),
        (
            "lending_close_payout",
            AccountTx::LendingClosePayout {
                position_id: "position-1".to_string(),
                hub_entity_id: "0xhub".to_string(),
                lender_entity_id: "0xlender".to_string(),
                token_id: token,
                amount: BigInt::from(10),
            },
        ),
        (
            "reserve_to_collateral",
            AccountTx::ReserveToCollateral {
                token_id: token,
                collateral: "1".to_string(),
                ondelta: "0".to_string(),
                side: ReserveSide::Receiving,
                block_number: 1,
                transaction_hash: format!("0x{}", "ee".repeat(32)),
            },
        ),
    ]
}

fn payment(from: &EntityId, to: &EntityId, amount: i64) -> AccountTx {
    AccountTx::DirectPayment {
        token_id: TokenId::new(1).expect("token"),
        amount: BigInt::from(amount),
        route: vec![to.to_string()],
        description: None,
        from_entity_id: from.to_string(),
        to_entity_id: to.to_string(),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

/// A frame the receiver cannot hash. The Hanko is genuine (over the claimed
/// digest), so the rejection that follows names the transaction itself, not
/// the signature: `AccountFrame::hash` refuses what canonical form cannot
/// express.
fn unhashable_incoming(right: &Party, tx: AccountTx) -> (AccountFrame, [u8; 32]) {
    let frame = AccountFrame {
        height: right.account.current_height() + 1,
        timestamp: CLOCK.entity_timestamp,
        j_height: 7,
        txs: vec![tx],
        prev_frame_hash: right.account.prev_frame_hash(),
        account_state_root: [0x99; 32],
    };
    (frame, [0x77; 32])
}

fn incoming_from_left(
    left: &Party,
    right: &Party,
    tx: AccountTx,
) -> (xln_rscore_engine::AccountInputEnvelope, IncomingFrame) {
    let state = right.account.replica().state();
    let (frame, claimed_digest) = unhashable_incoming(right, tx);
    (
        xln_rscore_engine::AccountInputEnvelope {
            from_entity_id: *left.identity.entity_id(),
            to_entity_id: *right.account.replica().owner().as_bytes(),
            domain: state.identity().domain().clone(),
            dispute_config: state.dispute_config(),
            watch_seed: Some(state.identity().watch_seed().clone()),
        },
        IncomingFrame {
            frame,
            dispute: None,
            state_hash: claimed_digest,
            frame_hanko: Some(
                left.identity
                    .sign_frame(&claimed_digest)
                    .expect("sign claimed digest"),
            ),
        },
    )
}

#[test]
fn admits_policy_version_at_both_bounds() {
    let (mut left, _right) = parties();
    for version in [0_u64, MAX_POLICY_VERSION] {
        left.account
            .admit_txs(vec![rebalance_policy(version)], "test")
            .unwrap_or_else(|error| panic!("version {version} must admit: {error}"));
    }
    assert_eq!(left.account.mempool().len(), 2);
}

#[test]
fn rejects_out_of_range_policy_version_before_the_mempool() {
    for version in [MAX_POLICY_VERSION + 1, 2_u64.pow(54), u64::MAX] {
        let (mut left, _right) = parties();
        let error = left
            .account
            .admit_txs(vec![rebalance_policy(version)], "test")
            .expect_err("out-of-range policyVersion must not admit");
        assert_eq!(
            error,
            xln_rscore_engine::StateError::PolicyVersionOutOfRange {
                version,
                maximum: MAX_POLICY_VERSION,
            },
            "version {version}"
        );
        assert_eq!(
            error.to_string(),
            format!("ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE:{version}:{MAX_POLICY_VERSION}"),
        );
        assert!(left.account.mempool().is_empty());
    }
}

#[test]
fn a_rejected_batch_admits_nothing() {
    let (mut left, right) = parties();
    let error = left
        .account
        .admit_txs(
            vec![
                payment(&left.entity_id, &right.entity_id, 5),
                rebalance_policy(2_u64.pow(54)),
            ],
            "test",
        )
        .expect_err("whole batch must be refused");
    assert!(matches!(
        error,
        xln_rscore_engine::StateError::PolicyVersionOutOfRange { .. }
    ));
    assert!(left.account.mempool().is_empty());
}

#[test]
fn out_of_range_policy_version_reaching_the_hash_is_an_admission_bug() {
    let frame = AccountFrame {
        height: 1,
        timestamp: 1,
        j_height: 0,
        txs: vec![rebalance_policy(MAX_POLICY_VERSION + 1)],
        prev_frame_hash: "genesis".to_string(),
        account_state_root: [0xcd; 32],
    };
    assert_eq!(
        frame.hash().expect_err("must refuse to hash"),
        xln_rscore_engine::StateError::PolicyVersionOutOfRange {
            version: MAX_POLICY_VERSION + 1,
            maximum: MAX_POLICY_VERSION,
        },
    );
}

#[test]
fn admits_every_canonical_extended_kind_and_hashes_it() {
    for (kind, tx) in extended_transactions() {
        let (mut left, _right) = parties();
        let admission = left
            .account
            .admit_txs(vec![tx.clone()], "test")
            .unwrap_or_else(|error| panic!("{kind} must admit: {error}"));
        assert_eq!(admission.admitted, 1, "{kind}");
        assert!(xln_rscore_engine::is_frame_hashable(&tx), "{kind}");
        assert_eq!(left.account.mempool()[0].wire_name(), kind);
    }
}

#[test]
fn an_incoming_frame_with_a_supported_kind_reaches_hash_binding() {
    let (left, mut right) = parties();
    for (kind, tx) in extended_transactions() {
        let (envelope, incoming) = incoming_from_left(&left, &right, tx);
        let outcome = apply_incoming_frame(
            &mut right.account,
            &right.identity,
            &envelope,
            CLOCK,
            incoming,
            &market(),
        )
        .unwrap_or_else(|error| panic!("{kind} is a rejection, not a fault: {error}"));
        let IncomingOutcome::Rejected { reason } = outcome else {
            panic!("{kind} must reach hash binding, got {outcome:?}");
        };
        assert_eq!(reason, "ACCOUNT_INPUT_FRAME_HASH_MISMATCH", "{kind}");
        assert_eq!(right.account.current_height(), 0);
    }
}

#[test]
fn an_incoming_frame_with_an_out_of_range_policy_version_is_rejected_before_replay() {
    let (left, mut right) = parties();
    let version = 2_u64.pow(54);
    let (envelope, incoming) = incoming_from_left(&left, &right, rebalance_policy(version));
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        &envelope,
        CLOCK,
        incoming,
        &market(),
    )
    .expect("a range violation is a rejection, not a fault");
    let IncomingOutcome::Rejected { reason } = outcome else {
        panic!("expected rejection, got {outcome:?}");
    };
    assert_eq!(
        reason,
        format!("ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE:{version}:{MAX_POLICY_VERSION}"),
    );
    assert_eq!(right.account.current_height(), 0);
}
