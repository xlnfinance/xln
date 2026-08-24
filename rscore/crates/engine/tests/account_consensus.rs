//! Two replicas of one account, driven only by the Rust engine: each side
//! holds its own mempool, builds and signs its own frames, and verifies the
//! other's before committing.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica,
    AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId,
    IncomingFrame, IncomingOutcome, ProposalOutcome, ProposedFrame, SigningIdentity, TokenId,
    WatchSeed, apply_incoming_ack, apply_incoming_frame, propose_account_frame,
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

/// Both parties are lazy single-signer entities, so each verifies the other's
/// Hanko from the frame alone.
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
    let left = Party {
        account: AccountConsensus::new(
            AccountReplica::new(left_entity.clone(), state.clone()).expect("left replica"),
        ),
        identity: left_identity,
        entity_id: left_entity,
    };
    let right = Party {
        account: AccountConsensus::new(
            AccountReplica::new(right_entity.clone(), state).expect("right replica"),
        ),
        identity: right_identity,
        entity_id: right_entity,
    };
    (left, right)
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

fn incoming_of(
    frame: &xln_rscore_engine::AccountFrame,
    state_hash: [u8; 32],
    hanko: Vec<u8>,
) -> IncomingFrame {
    IncomingFrame {
        height: frame.height,
        timestamp: frame.timestamp,
        j_height: frame.j_height,
        txs: frame.txs.clone(),
        prev_frame_hash: frame.prev_frame_hash.clone(),
        account_state_root: frame.account_state_root,
        by_left: frame.by_left,
        state_hash,
        hanko,
    }
}

/// One payment, proposed by LEFT and committed by both sides at the same
/// account state root.
#[test]
fn a_signed_frame_commits_on_both_sides() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");

    let proposal = propose_account_frame(&mut left.account, &left.identity, 1_700_000_000_000, 7)
        .expect("propose");
    let ProposalOutcome::Proposed(proposed) = proposal else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;
    assert_eq!(frame.height, 1);
    assert_eq!(frame.prev_frame_hash, "genesis");
    assert!(left.account.mempool().is_empty());

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        incoming_of(&frame, state_hash, hanko),
    )
    .expect("apply");
    let IncomingOutcome::Committed {
        height, ack_hanko, ..
    } = outcome
    else {
        panic!("expected a commit, got {outcome:?}");
    };
    assert_eq!(height, 1);
    assert_eq!(right.account.current_height(), 1);

    let ack = apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &state_hash,
        &ack_hanko,
    )
    .expect("ack");
    assert!(matches!(
        ack,
        xln_rscore_engine::AckOutcome::Committed { height: 1, .. }
    ));
    assert_eq!(left.account.current_height(), 1);
    assert_eq!(
        left.account
            .replica()
            .state()
            .payment_profile_account_state_root()
            .expect("left root"),
        right
            .account
            .replica()
            .state()
            .payment_profile_account_state_root()
            .expect("right root"),
    );
    assert_eq!(
        left.account
            .replica()
            .state()
            .delta(TokenId::new(1).expect("token"))
            .expect("delta")
            .offdelta(),
        &BigInt::from(-25),
    );
}

/// A frame signed by anyone but the counterparty is not evidence: the peer
/// must refuse it before replaying a single transaction.
#[test]
fn a_frame_signed_by_the_wrong_entity_is_refused() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(proposed) =
        propose_account_frame(&mut left.account, &left.identity, 1_700_000_000_000, 7)
            .expect("propose")
    else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;

    let error = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        // The counterparty is LEFT; claiming the frame came from RIGHT itself
        // must fail on the target check inside the Hanko.
        right.identity.entity_id(),
        incoming_of(&frame, state_hash, hanko.clone()),
    )
    .expect_err("wrong signer");
    assert!(
        error
            .to_string()
            .starts_with("ACCOUNT_PEER_FRAME_HANKO_INVALID"),
        "{error}",
    );
    assert_eq!(right.account.current_height(), 0);

    // The Hanko commits the frame hash, so tampering with a field the hash
    // covers is caught by our own replay rather than by recovery.
    let mut tampered = incoming_of(&frame, state_hash, hanko);
    tampered.account_state_root[0] ^= 0x01;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        tampered,
    )
    .expect("tampered frame is a rejection, not a fault");
    let IncomingOutcome::Rejected { reason } = outcome else {
        panic!("expected a rejection, got {outcome:?}");
    };
    assert_eq!(reason, "ACCOUNT_PEER_FRAME_STATE_ROOT_MISMATCH");
    assert_eq!(right.account.current_height(), 0);
}

/// Both sides propose at the same height: LEFT's frame wins, RIGHT rolls its
/// own transactions back into its queue and commits LEFT's frame.
#[test]
fn a_same_height_collision_resolves_to_the_left_entity() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit left");
    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 10)], "test")
        .expect("admit right");

    let ProposalOutcome::Proposed(left_proposed) =
        propose_account_frame(&mut left.account, &left.identity, 1_700_000_000_000, 7)
            .expect("propose left")
    else {
        panic!("expected LEFT to propose");
    };
    let ProposedFrame {
        frame: left_frame,
        state_hash: left_hash,
        hanko: left_hanko,
        ..
    } = *left_proposed;
    let ProposalOutcome::Proposed(right_proposed) =
        propose_account_frame(&mut right.account, &right.identity, 1_700_000_000_001, 7)
            .expect("propose right")
    else {
        panic!("expected RIGHT to propose");
    };
    let ProposedFrame {
        frame: right_frame,
        state_hash: right_hash,
        hanko: right_hanko,
        ..
    } = *right_proposed;
    assert_eq!(left_frame.height, right_frame.height);

    // LEFT sees RIGHT's frame and keeps its own.
    let outcome = apply_incoming_frame(
        &mut left.account,
        &left.identity,
        right.identity.entity_id(),
        incoming_of(&right_frame, right_hash, right_hanko),
    )
    .expect("left applies");
    assert!(matches!(
        outcome,
        IncomingOutcome::CollisionIgnored { height: 1 }
    ));
    assert_eq!(left.account.current_height(), 0);
    assert!(left.account.pending().is_some());

    // RIGHT rolls back and commits LEFT's frame, keeping its own payment for
    // the next proposal.
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        incoming_of(&left_frame, left_hash, left_hanko),
    )
    .expect("right applies");
    let IncomingOutcome::Committed {
        ack_hanko,
        rolled_back_txs,
        ..
    } = outcome
    else {
        panic!("expected RIGHT to commit, got {outcome:?}");
    };
    assert_eq!(rolled_back_txs, 1);
    assert_eq!(right.account.mempool().len(), 1);
    assert_eq!(right.account.rollback_count(), 1);

    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &left_hash,
        &ack_hanko,
    )
    .expect("left commits on ack");
    assert_eq!(left.account.current_height(), 1);

    // The restored payment proposes cleanly on top of the accepted frame.
    let ProposalOutcome::Proposed(second) =
        propose_account_frame(&mut right.account, &right.identity, 1_700_000_000_002, 7)
            .expect("propose again")
    else {
        panic!("expected a second proposal");
    };
    assert_eq!(second.frame.height, 2);
    assert_eq!(
        second.frame.prev_frame_hash,
        format!("0x{}", hex::encode(left_hash)),
    );
}
