//! Two replicas of one account, driven only by the Rust engine: each side
//! holds its own mempool, builds and signs its own frames, and verifies the
//! other's before committing.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica,
    AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId,
    IncomingFrame, IncomingOutcome, ProposalOutcome, ProposedFrame, ReceiverClock, SigningIdentity,
    TokenId, WatchSeed, apply_incoming_ack, apply_incoming_frame, propose_account_frame,
};

/// The receiver's own clock, at the same moment the frames below are proposed.
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
        dispute: None,
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

    let proposal = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
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
        CLOCK,
        incoming_of(&frame, state_hash, hanko),
        &market(),
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
        None,
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
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;

    // The counterparty is LEFT; a frame claimed to come from RIGHT itself, or
    // from a stranger, is not this account's business at all.
    for claimed in [
        right.identity.entity_id(),
        SigningIdentity::lazy_from_seed(SEED, "9", 1, 1, BoardDelays::default())
            .expect("stranger")
            .entity_id(),
    ] {
        let outcome = apply_incoming_frame(
            &mut right.account,
            &right.identity,
            claimed,
            CLOCK,
            incoming_of(&frame, state_hash, hanko.clone()),
            &market(),
        )
        .expect("a non-party is a rejection, not a fault");
        let IncomingOutcome::Rejected { reason } = outcome else {
            panic!("expected a rejection, got {outcome:?}");
        };
        assert_eq!(reason, "ACCOUNT_PEER_FRAME_PROPOSER_INVALID");
        assert_eq!(right.account.current_height(), 0);
    }

    // The right party, the wrong signature: caught by the Hanko itself.
    let mut forged = incoming_of(&frame, state_hash, hanko.clone());
    forged.hanko = right
        .identity
        .sign_frame(&state_hash)
        .expect("forged hanko");
    let error = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        forged,
        &market(),
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
        CLOCK,
        tampered,
        &market(),
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

    let ProposalOutcome::Proposed(left_proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose left") else {
        panic!("expected LEFT to propose");
    };
    let ProposedFrame {
        frame: left_frame,
        state_hash: left_hash,
        hanko: left_hanko,
        ..
    } = *left_proposed;
    let ProposalOutcome::Proposed(right_proposed) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose right") else {
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
        CLOCK,
        incoming_of(&right_frame, right_hash, right_hanko),
        &market(),
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
        CLOCK,
        incoming_of(&left_frame, left_hash, left_hanko),
        &market(),
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
        None,
    )
    .expect("left commits on ack");
    assert_eq!(left.account.current_height(), 1);

    // The restored payment proposes cleanly on top of the accepted frame.
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_002,
        7,
        &market(),
    )
    .expect("propose again") else {
        panic!("expected a second proposal");
    };
    assert_eq!(second.frame.height, 2);
    assert_eq!(
        second.frame.prev_frame_hash,
        format!("0x{}", hex::encode(left_hash)),
    );
}

/// A checkpoint is not trusted on the way back in: a pending frame is replayed
/// against the committed state, and anything that does not reproduce exactly
/// what was signed fails the restore.
#[test]
fn a_checkpoint_restore_replays_the_pending_frame() {
    use xln_rscore_engine::{ConsensusSnapshot, PendingFrameSnapshot};

    let (mut left, right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;

    // What a checkpoint holds: the committed replica (nothing applied yet) and
    // the frame in flight.
    let committed = AccountReplica::new(
        left.entity_id.clone(),
        account_state(&left.entity_id, &right.entity_id),
    )
    .expect("committed replica");
    let snapshot = |pending: Option<PendingFrameSnapshot>| ConsensusSnapshot {
        mempool: Vec::new(),
        current: None,
        pending,
        rollback_count: 0,
        last_rollback_frame_hash: None,
        counterparty_frame_hanko: None,
        last_outbound_ack: None,
        dispute: None,
        next_proof_nonce: 0,
        counterparty_dispute: None,
    };
    let saved = PendingFrameSnapshot {
        frame: frame.clone(),
        state_hash,
        hanko: hanko.clone(),
        bundled_ack: None,
        proposal_dispute: None,
    };

    let restored = AccountConsensus::restore_from_checkpoint(
        committed.clone(),
        snapshot(Some(saved.clone())),
        &market(),
    )
    .expect("restore");
    assert_eq!(restored.current_height(), 0);
    let pending = restored.pending().expect("pending");
    assert_eq!(pending.state_hash, state_hash);
    assert_eq!(
        restored.entity_account_leaf().expect("restored leaf"),
        left.account.entity_account_leaf().expect("live leaf"),
    );

    // A state root the replay does not reproduce is a database that disagrees
    // with the signature over it.
    let mut tampered = saved.clone();
    tampered.frame.account_state_root[0] ^= 0x01;
    let error = AccountConsensus::restore_from_checkpoint(
        committed.clone(),
        snapshot(Some(tampered)),
        &market(),
    )
    .expect_err("tampered root");
    assert_eq!(
        error.to_string(),
        "ACCOUNT_CHECKPOINT_RESTORE:PENDING_STATE_ROOT_MISMATCH",
    );

    // A frame that does not chain to the committed head is not ours to hold.
    let mut wrong_height = saved.clone();
    wrong_height.frame.height = 4;
    let error = AccountConsensus::restore_from_checkpoint(
        committed.clone(),
        snapshot(Some(wrong_height)),
        &market(),
    )
    .expect_err("wrong height");
    assert_eq!(
        error.to_string(),
        "ACCOUNT_CHECKPOINT_RESTORE:PENDING_HEIGHT:4:1"
    );

    // The hash the signature covers must be the hash of the frame beside it.
    let mut wrong_hash = saved;
    wrong_hash.state_hash[0] ^= 0x01;
    let error =
        AccountConsensus::restore_from_checkpoint(committed, snapshot(Some(wrong_hash)), &market())
            .expect_err("wrong hash");
    assert_eq!(
        error.to_string(),
        "ACCOUNT_CHECKPOINT_RESTORE:PENDING_FRAME_HASH_MISMATCH",
    );
}

/// The receiver judges expiry on its own clock. A peer that backdates its
/// frame cannot make a lock that is already dead on our clock look alive.
#[test]
fn enforcement_is_judged_on_the_receiver_clock() {
    use num_bigint::BigInt as Big;
    use xln_rscore_engine::{HtlcHashlock, HtlcLockTx};

    let (mut left, mut right) = parties();
    // The lock is alive at the frame's own clock and dead at ours.
    let timelock = 1_700_000_005_000_u64;
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: "lock-1".to_string(),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "11".repeat(32))).expect("hashlock"),
        timelock: Big::from(timelock),
        reveal_before_height: 100,
        amount: Big::from(10),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    });
    left.account.admit_txs(vec![lock], "test").expect("admit");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        ReceiverClock {
            entity_timestamp: timelock + 1,
            finalized_j_height: 7,
        },
        incoming_of(&frame, state_hash, hanko.clone()),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Rejected { reason } = outcome else {
        panic!("expected a rejection, got {outcome:?}");
    };
    assert!(
        reason.starts_with("ACCOUNT_PEER_FRAME_TX_REJECTED"),
        "{reason}"
    );

    // The same frame, on a clock where the lock is still alive, commits.
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        ReceiverClock {
            entity_timestamp: 1_700_000_000_000,
            finalized_j_height: 7,
        },
        incoming_of(&frame, state_hash, hanko),
        &market(),
    )
    .expect("apply");
    assert!(matches!(
        outcome,
        IncomingOutcome::Committed { height: 1, .. }
    ));
}

/// A frame from the future could satisfy payer-side deadlines early, so it is
/// refused; an old one is ordinary retransmission and is not.
#[test]
fn a_frame_from_the_future_is_refused() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let ProposedFrame {
        frame,
        state_hash,
        hanko,
        ..
    } = *proposed;

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        ReceiverClock {
            // 30s is the allowance; the frame is a second past it.
            entity_timestamp: 1_700_000_000_000 - 30_001,
            finalized_j_height: 7,
        },
        incoming_of(&frame, state_hash, hanko.clone()),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Rejected { reason } = outcome else {
        panic!("expected a rejection, got {outcome:?}");
    };
    assert!(
        reason.starts_with("ACCOUNT_PEER_FRAME_STRUCTURE_INVALID:skew"),
        "{reason}"
    );
    assert_eq!(right.account.current_height(), 0);

    // Inside the allowance the same frame is fine.
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        ReceiverClock {
            entity_timestamp: 1_700_000_000_000 - 30_000,
            finalized_j_height: 7,
        },
        incoming_of(&frame, state_hash, hanko),
        &market(),
    )
    .expect("apply");
    assert!(matches!(
        outcome,
        IncomingOutcome::Committed { height: 1, .. }
    ));
}

/// Delivery is at-least-once: a frame we already committed under, redelivered,
/// is a no-op rather than a fault.
#[test]
fn a_redelivered_ancestor_frame_is_a_no_op() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(first) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let first = *first;
    let committed = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&first.frame, first.state_hash, first.hanko.clone()),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Committed { ack_hanko, .. } = committed else {
        panic!("expected a commit");
    };
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &first.state_hash,
        &ack_hanko,
        None,
    )
    .expect("ack");

    // Height 2, so height 1 is now an ancestor.
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 5)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a second proposal");
    };
    let second = *second;
    apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&second.frame, second.state_hash, second.hanko),
        &market(),
    )
    .expect("apply");
    assert_eq!(right.account.current_height(), 2);

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&first.frame, first.state_hash, first.hanko),
        &market(),
    )
    .expect("apply");
    assert!(
        matches!(
            outcome,
            IncomingOutcome::Stale {
                height: 1,
                current_height: 2
            }
        ),
        "{outcome:?}",
    );
    assert_eq!(right.account.current_height(), 2);
}

/// A frame that fails validation must not cost us our own proposal, even at
/// the same height.
#[test]
fn a_failing_frame_leaves_our_own_proposal_standing() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit left");
    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 10)], "test")
        .expect("admit right");
    let ProposalOutcome::Proposed(left_proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose left") else {
        panic!("expected LEFT to propose");
    };
    let ProposalOutcome::Proposed(right_proposed) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose right") else {
        panic!("expected RIGHT to propose");
    };
    let left_proposed = *left_proposed;
    let right_pending_hash = right_proposed.state_hash;

    // LEFT's frame, tampered so RIGHT's replay cannot reproduce it.
    let mut broken = incoming_of(
        &left_proposed.frame,
        left_proposed.state_hash,
        left_proposed.hanko.clone(),
    );
    broken.account_state_root[0] ^= 0x01;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        broken,
        &market(),
    )
    .expect("apply");
    assert!(
        matches!(outcome, IncomingOutcome::Rejected { .. }),
        "{outcome:?}"
    );
    let pending = right.account.pending().expect("our proposal survives");
    assert_eq!(pending.state_hash, right_pending_hash);
    assert_eq!(right.account.rollback_count(), 0);
    assert_eq!(right.account.mempool().len(), 0);

    // The genuine frame still resolves the collision.
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(
            &left_proposed.frame,
            left_proposed.state_hash,
            left_proposed.hanko,
        ),
        &market(),
    )
    .expect("apply");
    assert!(
        matches!(
            outcome,
            IncomingOutcome::Committed {
                rolled_back_txs: 1,
                ..
            }
        ),
        "{outcome:?}",
    );
    assert_eq!(right.account.rollback_count(), 1);
}

/// The rollback bookkeeping follows the TypeScript rules: accepting the
/// winner's frame keeps it, and our own next acked frame settles it.
#[test]
fn a_rollback_is_settled_by_our_next_acked_frame() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit left");
    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 10)], "test")
        .expect("admit right");
    let ProposalOutcome::Proposed(left_proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose left") else {
        panic!("expected LEFT to propose");
    };
    let ProposalOutcome::Proposed(_right_proposed) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose right") else {
        panic!("expected RIGHT to propose");
    };
    let left_proposed = *left_proposed;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(
            &left_proposed.frame,
            left_proposed.state_hash,
            left_proposed.hanko,
        ),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Committed { ack_hanko, .. } = outcome else {
        panic!("expected a commit, got {outcome:?}");
    };
    // Accepting their frame is not what settles our rollback.
    assert_eq!(right.account.rollback_count(), 1);
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &left_proposed.state_hash,
        &ack_hanko,
        None,
    )
    .expect("left commits");

    // RIGHT re-proposes its own payment; LEFT accepts and acks it.
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_002,
        7,
        &market(),
    )
    .expect("propose again") else {
        panic!("expected a second proposal");
    };
    let second = *second;
    let outcome = apply_incoming_frame(
        &mut left.account,
        &left.identity,
        right.identity.entity_id(),
        CLOCK,
        incoming_of(&second.frame, second.state_hash, second.hanko),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Committed { ack_hanko, .. } = outcome else {
        panic!("expected a commit, got {outcome:?}");
    };
    apply_incoming_ack(
        &mut right.account,
        left.identity.entity_id(),
        2,
        &second.state_hash,
        &ack_hanko,
        None,
    )
    .expect("right commits on ack");
    assert_eq!(right.account.rollback_count(), 0);
    assert_eq!(right.account.current_height(), 2);
}

/// The bilateral certificate is part of the leaf: an account that holds the
/// peer's signature over the committed frame does not hash like one that has
/// lost it.
#[test]
fn the_counterparty_certificate_is_committed_in_the_leaf() {
    use xln_rscore_engine::ConsensusSnapshot;

    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    let proposed = *proposed;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&proposed.frame, proposed.state_hash, proposed.hanko),
        &market(),
    )
    .expect("apply");
    let IncomingOutcome::Committed { ack_hanko, .. } = outcome else {
        panic!("expected a commit");
    };
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &proposed.state_hash,
        &ack_hanko,
        None,
    )
    .expect("ack");

    let with_certificate = left.account.entity_account_leaf().expect("leaf");
    let snapshot = left.account.consensus_snapshot();
    assert!(snapshot.counterparty_frame_hanko.is_some());
    let stripped = AccountConsensus::restore_from_checkpoint(
        left.account.replica().clone(),
        ConsensusSnapshot {
            counterparty_frame_hanko: None,
            ..snapshot
        },
        &market(),
    )
    .expect("restore without the certificate");
    assert_ne!(
        with_certificate,
        stripped.entity_account_leaf().expect("leaf"),
        "the certificate must be part of the commitment",
    );
}

/// A transaction the frame hash cannot express never enters the queue: once
/// queued, nothing could remove it and every later frame would fail.
#[test]
fn an_unhashable_transaction_is_refused_at_admission() {
    let (mut left, right) = parties();
    let error = left
        .account
        .admit_txs(
            vec![AccountTx::ReserveToCollateral {
                token_id: TokenId::new(1).expect("token"),
                collateral: "10".to_string(),
                ondelta: "0".to_string(),
                side: xln_rscore_engine::ReserveSide::Receiving,
                block_number: 1,
                transaction_hash: format!("0x{}", "ee".repeat(32)),
            }],
            "test",
        )
        .expect_err("unhashable");
    assert_eq!(
        error.to_string(),
        "ACCOUNT_FRAME_TX_UNSUPPORTED:reserve_to_collateral"
    );
    assert!(left.account.mempool().is_empty());
    // The account still works.
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 5)], "test")
        .expect("admit");
    assert_eq!(left.account.mempool().len(), 1);
}

/// Capacity is a "not yet", not a "no": a lock the frame had no room for
/// stays queued and goes into the next one.
///
/// The other half of the contract — a matcher-caused rejection failing the
/// proposal instead of being dropped — is pinned by the unit test beside
/// `critical_kind` in consensus/proposal/propose.rs, because reaching it here
/// would need a swap market this fixture does not install.
#[test]
fn the_proposal_window_defers_a_capacity_rejection() {
    use num_bigint::BigInt as Big;
    use xln_rscore_engine::{HtlcHashlock, HtlcLockTx};

    let (mut left, right) = parties();
    let lock = |index: usize| {
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: format!("lock-{index}"),
            hashlock: HtlcHashlock::parse(&format!("0x{:02x}{}", index % 256, "11".repeat(31)))
                .expect("hashlock"),
            timelock: Big::from(1_700_000_900_000_u64),
            reveal_before_height: 100,
            amount: Big::from(10),
            token_id: TokenId::new(1).expect("token"),
            delivery_mode: None,
            envelope: None,
        })
    };
    // 32 locks is the account limit; the 33rd has nowhere to go this frame.
    left.account
        .admit_txs((0..33).map(lock).collect(), "test")
        .expect("admit");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected a proposal");
    };
    assert_eq!(proposed.frame.txs.len(), 32);
    assert_eq!(proposed.dropped.len(), 1);
    assert_eq!(
        left.account.mempool().len(),
        1,
        "the deferred lock is still queued",
    );

    let _ = right;
}

/// A frame's effects do not leave the account until the peer has committed
/// it. The proposal carries none; the ack carries them.
#[test]
fn outputs_are_held_until_the_peer_acks() {
    use num_bigint::BigInt as Big;
    use sha3::{Digest as _, Keccak256};
    use xln_rscore_engine::{
        AccountOutput, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx,
    };

    let (mut left, mut right) = parties();
    let secret_bytes = [0x5a_u8; 32];
    let secret = format!("0x{}", hex::encode(secret_bytes));
    let hashlock_bytes: [u8; 32] = Keccak256::digest(secret_bytes).into();
    let hashlock =
        HtlcHashlock::parse(&format!("0x{}", hex::encode(hashlock_bytes))).expect("hashlock");

    // Height 1: LEFT locks, both sides commit.
    left.account
        .admit_txs(
            vec![AccountTx::HtlcLock(HtlcLockTx {
                lock_id: "lock-1".to_string(),
                hashlock,
                timelock: Big::from(1_700_000_900_000_u64),
                reveal_before_height: 100,
                amount: Big::from(50),
                token_id: TokenId::new(1).expect("token"),
                delivery_mode: None,
                envelope: None,
            })],
            "test",
        )
        .expect("admit lock");
    let ProposalOutcome::Proposed(lock_frame) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose lock") else {
        panic!("expected a proposal");
    };
    let lock_frame = *lock_frame;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&lock_frame.frame, lock_frame.state_hash, lock_frame.hanko),
        &market(),
    )
    .expect("apply lock");
    let IncomingOutcome::Committed { ack_hanko, .. } = outcome else {
        panic!("expected a commit");
    };
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &lock_frame.state_hash,
        &ack_hanko,
        None,
    )
    .expect("ack lock");

    // Height 2: RIGHT resolves with the secret. Its effect is the secret
    // itself, which must not escape before LEFT has committed the frame.
    right
        .account
        .admit_txs(
            vec![AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: "lock-1".to_string(),
                outcome: HtlcResolveOutcome::Secret { secret },
            })],
            "test",
        )
        .expect("admit resolve");
    let ProposalOutcome::Proposed(resolve) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose resolve") else {
        panic!("expected a proposal");
    };
    let resolve = *resolve;

    // LEFT holds the peer's signed frame, so its own effects are released at
    // commit.
    let outcome = apply_incoming_frame(
        &mut left.account,
        &left.identity,
        right.identity.entity_id(),
        CLOCK,
        incoming_of(&resolve.frame, resolve.state_hash, resolve.hanko),
        &market(),
    )
    .expect("apply resolve");
    let IncomingOutcome::Committed {
        ack_hanko, outputs, ..
    } = outcome
    else {
        panic!("expected a commit");
    };
    assert!(
        outputs
            .iter()
            .any(|output| matches!(output, AccountOutput::HtlcSecret { .. })),
        "{outputs:?}",
    );

    // RIGHT only learns the frame is committed when the ack arrives, and that
    // is when its own copy of the effect is released.
    let ack = apply_incoming_ack(
        &mut right.account,
        left.identity.entity_id(),
        2,
        &resolve.state_hash,
        &ack_hanko,
        None,
    )
    .expect("ack resolve");
    let xln_rscore_engine::AckOutcome::Committed { outputs, .. } = ack else {
        panic!("expected an ack commit, got {ack:?}");
    };
    assert!(
        outputs
            .iter()
            .any(|output| matches!(output, AccountOutput::HtlcSecret { .. })),
        "{outputs:?}",
    );
}

fn market() -> std::sync::Arc<xln_rscore_engine::SwapMarketPolicy> {
    std::sync::Arc::default()
}
