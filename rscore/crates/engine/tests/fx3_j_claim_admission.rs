//! FX-3 (proofs/fixes.md, decision D4): the four mandatory j-claim vectors —
//! committed conflict, two conflicts in one batch, side-aware duplicate, and a
//! stale admitted claim after an incoming frame — driven through the real
//! bilateral consensus functions of this engine.
//!
//! Verdict parity: every code/message/disposition asserted here is the exact
//! vocabulary asserted by the TypeScript twin
//! `core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts`:
//! `ACCOUNT_J_CLAIM_{LEFT|RIGHT}_CONFLICT:{side}:{height}`,
//! `ACCOUNT_J_CLAIM_QUEUED_CONFLICT:{height}`, admission code
//! `ACCOUNT_TX_VALIDATION`, drop disposition `Removed`.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountInputEnvelope,
    AccountRejection, AccountReplica, AccountSettledEvent, AccountState, AccountTx, BoardDelays,
    DepositoryAddress, Disposition, EntityId, IncomingFrame, IncomingOutcome, JEventClaimTx,
    JEventMetadata, JurisdictionEvent, ProposalOutcome, ProposedFrame, ReceiverClock,
    SigningIdentity, TokenId, ValidationRejection, WatchSeed,
    apply_incoming_frame as apply_exact_incoming_frame, propose_account_frame,
};

const CLOCK: ReceiverClock = ReceiverClock {
    entity_timestamp: 1_700_000_000_010,
    finalized_j_height: 7,
};

const SEED: &str = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";

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

/// Two lazy single-signer parties sharing one account, ordered so `left`
/// really is the lexicographically lower entity.
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
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left_entity.clone(),
        right_entity.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = xln_rscore_engine::Delta::new(
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
    .expect("funded delta");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state");
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

/// Claim evidence is a pure function of (height, block byte, nonce) so the
/// same triple means the same bytes in both engines.
fn settled_event(height: u64, nonce: u64) -> JurisdictionEvent {
    let (left, right) = parties_identity();
    JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata::default(),
        left_entity: left,
        right_entity: right,
        token_id: TokenId::new(1).expect("token"),
        left_reserve: 0.into(),
        right_reserve: 0.into(),
        collateral: BigInt::from(100 + height),
        ondelta: BigInt::from(nonce),
        nonce,
    })
}

fn parties_identity() -> (EntityId, EntityId) {
    // Re-derive the deterministic party order without keeping state around.
    let first = SigningIdentity::lazy_from_seed(SEED, "1", 1, 1, BoardDelays::default())
        .expect("identity 1");
    let second = SigningIdentity::lazy_from_seed(SEED, "2", 1, 1, BoardDelays::default())
        .expect("identity 2");
    let first_entity = EntityId::parse(&entity_hex(first.entity_id())).expect("entity 1");
    let second_entity = EntityId::parse(&entity_hex(second.entity_id())).expect("entity 2");
    if first_entity.to_string() < second_entity.to_string() {
        (first_entity, second_entity)
    } else {
        (second_entity, first_entity)
    }
}

fn raw_claim(height: u64, block: u8, nonce: u64) -> AccountTx {
    AccountTx::JEventClaim(JEventClaimTx {
        j_height: height,
        j_block_hash: [block; 32],
        events: vec![settled_event(height, nonce)],
        left_proof: None,
        right_proof: None,
    })
}

/// The surviving non-claim row: always applies, no funding needed.
fn survivor_row() -> AccountTx {
    AccountTx::AddDelta {
        token_id: TokenId::new(1).expect("token"),
    }
}

fn envelope(account: &AccountConsensus, from_entity_id: &[u8; 32]) -> AccountInputEnvelope {
    let state = account.replica().state();
    AccountInputEnvelope {
        from_entity_id: *from_entity_id,
        to_entity_id: *account.replica().owner().as_bytes(),
        domain: state.identity().domain().clone(),
        dispute_config: state.dispute_config(),
        watch_seed: Some(state.identity().watch_seed().clone()),
    }
}

fn deliver(
    receiver: &mut Party,
    sender: &Party,
    proposed: &ProposedFrame,
    market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> IncomingOutcome {
    let frame = IncomingFrame {
        frame: proposed.frame.clone(),
        dispute: None,
        state_hash: proposed.state_hash,
        frame_hanko: Some(proposed.hanko.clone()),
    };
    let peer_envelope = envelope(&receiver.account, sender.entity_id.as_bytes());
    apply_exact_incoming_frame(
        &mut receiver.account,
        &receiver.identity,
        &peer_envelope,
        CLOCK,
        frame,
        market,
    )
    .expect("peer frame commits")
}

fn propose(
    party: &mut Party,
    market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> ProposalOutcome {
    propose_account_frame(&mut party.account, &party.identity, 100, 7, market)
        .expect("proposal never aborts on a claim conflict")
}

fn committed_right_claim_state() -> Party {
    // Left has already committed the peer's claim at height 5 (block 0x77):
    // its right accumulator holds the member, like any receiver of that frame.
    let (mut left, mut right) = parties();
    let market = std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::default());
    let summary = right
        .account
        .admit_txs(vec![raw_claim(5, 0x77, 3)], "fx3:seed")
        .expect("peer claim admitted");
    assert_eq!(summary.admitted, 1);
    let ProposalOutcome::Proposed(proposed) = propose(&mut right, &market) else {
        panic!("peer proposal expected");
    };
    let outcome = deliver(&mut left, &right, &proposed, &market);
    assert!(matches!(outcome, IncomingOutcome::Committed { .. }));
    left
}

/// (a) A claim conflicting with committed accumulator evidence is typed
/// rejected at admission itself; the account continues.
#[test]
fn a_committed_conflict_is_typed_rejected_at_admission() {
    let mut left = committed_right_claim_state();
    let summary = left
        .account
        .admit_txs(vec![raw_claim(5, 0x55, 3)], "fx3:a")
        .expect("conflict is data, never an abort");
    assert_eq!(summary.admitted, 0);
    assert_eq!(summary.duplicates, 0);
    assert_eq!(summary.rejections.len(), 1);
    assert_eq!(summary.rejections[0].index, 0);
    assert!(matches!(
        &summary.rejections[0].rejection,
        AccountRejection::Validation(ValidationRejection::JEventClaimConflict {
            side: xln_rscore_engine::Side::Right,
            j_height: 5,
        })
    ));
    assert_eq!(
        summary.rejections[0].rejection.message(),
        "ACCOUNT_J_CLAIM_RIGHT_CONFLICT:right:5"
    );
    assert_eq!(
        summary.rejections[0].rejection.code(),
        "ACCOUNT_TX_VALIDATION"
    );
    assert!(left.account.mempool().is_empty());
    // The account continues: ordinary work still enters the queue.
    let follow = left
        .account
        .admit_txs(vec![survivor_row()], "fx3:a-continues")
        .expect("account usable after typed reject");
    assert_eq!(follow.admitted, 1);
}

/// (b) Two conflicts in one enqueue batch are both typed rejected while the
/// remaining rows are admitted, and — the window reading — two stale admitted
/// claims are both dropped from one proposal window that still commits the
/// surviving transaction.
#[test]
fn b_two_conflicts_one_batch_both_dropped_window_survives() {
    // Admission: rows 0 and 2 conflict with the committed member, row 1 lives.
    let mut left = committed_right_claim_state();
    let summary = left
        .account
        .admit_txs(
            vec![raw_claim(5, 0x55, 3), survivor_row(), raw_claim(5, 0x66, 3)],
            "fx3:b-admission",
        )
        .expect("batch is classified, never aborted");
    assert_eq!(summary.admitted, 1);
    assert_eq!(summary.rejections.len(), 2);
    assert_eq!(summary.rejections[0].index, 0);
    assert_eq!(summary.rejections[1].index, 2);
    for rejection in &summary.rejections {
        assert!(matches!(
            &rejection.rejection,
            AccountRejection::Validation(ValidationRejection::JEventClaimConflict {
                side: xln_rscore_engine::Side::Right,
                j_height: 5,
            })
        ));
    }
    assert_eq!(left.account.mempool(), [survivor_row()]);

    // Window: both stale rows dropped, the survivor commits.
    let (mut left, mut right) = parties();
    let market = std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::default());
    let admitted = left
        .account
        .admit_txs(
            vec![raw_claim(5, 0x55, 3), raw_claim(6, 0x66, 4), survivor_row()],
            "fx3:b-window",
        )
        .expect("honest local observations admitted");
    assert_eq!(admitted.admitted, 3);
    let peer = right
        .account
        .admit_txs(
            vec![raw_claim(5, 0x77, 3), raw_claim(6, 0x88, 4)],
            "fx3:b-peer",
        )
        .expect("peer claims admitted");
    assert_eq!(peer.admitted, 2);
    let ProposalOutcome::Proposed(proposed) = propose(&mut right, &market) else {
        panic!("peer proposal expected");
    };
    deliver(&mut left, &right, &proposed, &market);
    // The incoming frame committed the peer's claims; our own two admitted
    // rows are now stale conflicts. Proposing drops exactly those rows.
    let outcome = propose(&mut left, &market);
    let ProposalOutcome::Proposed(frame) = outcome else {
        panic!("window survives with the remaining transaction");
    };
    assert_eq!(frame.frame.txs, vec![survivor_row()]);
    assert_eq!(frame.dropped.len(), 2);
    let mut conflict_heights = Vec::new();
    for dropped in &frame.dropped {
        assert_eq!(dropped.disposition, Disposition::Removed);
        let AccountRejection::Validation(ValidationRejection::JEventClaimConflict {
            side,
            j_height,
        }) = &dropped.rejection
        else {
            panic!(
                "typed conflict rejection expected, got {:?}",
                dropped.rejection
            );
        };
        assert_eq!(*side, xln_rscore_engine::Side::Right);
        conflict_heights.push(*j_height);
    }
    conflict_heights.sort_unstable();
    assert_eq!(conflict_heights, vec![5, 6]);
    assert!(left.account.mempool().is_empty());
}

/// (c) Matching evidence committed by the peer admits our second vote, while
/// matching evidence already queued by us remains idempotent.
#[test]
fn c_exact_duplicate_is_idempotent_everywhere() {
    // The peer's exact claim is not our duplicate: admitting our matching side
    // is what allows the bilateral claim to finalize.
    let mut left = committed_right_claim_state();
    let summary = left
        .account
        .admit_txs(vec![raw_claim(5, 0x77, 3)], "fx3:c-committed")
        .expect("duplicate is data, never an abort");
    assert_eq!(summary.admitted, 1);
    assert_eq!(summary.duplicates, 0);
    assert!(summary.rejections.is_empty());
    assert_eq!(left.account.mempool().len(), 1);

    // Queued duplicate: the same claim admitted twice in a row.
    let (mut left, _right) = parties();
    let first = left
        .account
        .admit_txs(vec![raw_claim(7, 0x11, 3)], "fx3:c-first")
        .expect("first observation admitted");
    assert_eq!(first.admitted, 1);
    let second = left
        .account
        .admit_txs(vec![raw_claim(7, 0x11, 3)], "fx3:c-second")
        .expect("duplicate is data, never an abort");
    assert_eq!(second.admitted, 0);
    assert_eq!(second.duplicates, 1);
    assert!(second.rejections.is_empty());
    assert_eq!(left.account.mempool().len(), 1);

    // Proposal records the claim exactly once.
    let market = std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::default());
    let ProposalOutcome::Proposed(frame) = propose(&mut left, &market) else {
        panic!("proposal expected");
    };
    assert_eq!(frame.frame.txs.len(), 1);
    assert!(frame.dropped.is_empty());
}

/// (d) A claim admitted while honest becomes stale when an incoming frame
/// commits different evidence at the same height: the proposal drops only
/// that row, with a typed disposition, and the account continues.
#[test]
fn d_stale_admitted_claim_dropped_after_incoming_frame() {
    let (mut left, mut right) = parties();
    let market = std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::default());
    let admitted = left
        .account
        .admit_txs(vec![raw_claim(5, 0x55, 3), survivor_row()], "fx3:d")
        .expect("honest local observation admitted");
    assert_eq!(admitted.admitted, 2);
    let peer = right
        .account
        .admit_txs(vec![raw_claim(5, 0x77, 3)], "fx3:d-peer")
        .expect("peer claim admitted");
    assert_eq!(peer.admitted, 1);
    let ProposalOutcome::Proposed(proposed) = propose(&mut right, &market) else {
        panic!("peer proposal expected");
    };
    deliver(&mut left, &right, &proposed, &market);
    // Our claim predates the incoming evidence: it is stale, not malformed.
    let outcome = propose(&mut left, &market);
    let ProposalOutcome::Proposed(frame) = outcome else {
        panic!("the window continues with the surviving row");
    };
    assert_eq!(frame.frame.txs, vec![survivor_row()]);
    assert_eq!(frame.dropped.len(), 1);
    let dropped = &frame.dropped[0];
    assert_eq!(dropped.disposition, Disposition::Removed);
    assert!(matches!(
        &dropped.rejection,
        AccountRejection::Validation(ValidationRejection::JEventClaimConflict {
            side: xln_rscore_engine::Side::Right,
            j_height: 5,
        })
    ));
    assert_eq!(
        dropped.rejection.message(),
        "ACCOUNT_J_CLAIM_RIGHT_CONFLICT:right:5"
    );
    assert_eq!(dropped.rejection.code(), "ACCOUNT_TX_VALIDATION");
    assert!(left.account.mempool().is_empty());
}

/// Clause 3 of the shared planner: a claim conflicting with an earlier queued
/// claim (not committed evidence) is a typed rejection with its own message.
#[test]
fn earlier_queued_claim_conflict_is_typed_rejected() {
    let (mut left, _right) = parties();
    let first = left
        .account
        .admit_txs(vec![raw_claim(9, 0x11, 3)], "fx3:queued-first")
        .expect("first observation admitted");
    assert_eq!(first.admitted, 1);
    let summary = left
        .account
        .admit_txs(vec![raw_claim(9, 0x22, 3)], "fx3:queued-conflict")
        .expect("queued conflict is data, never an abort");
    assert_eq!(summary.admitted, 0);
    assert_eq!(summary.rejections.len(), 1);
    assert!(matches!(
        &summary.rejections[0].rejection,
        AccountRejection::Validation(ValidationRejection::JEventClaimQueuedConflict {
            j_height: 9,
        })
    ));
    assert_eq!(
        summary.rejections[0].rejection.message(),
        "ACCOUNT_J_CLAIM_QUEUED_CONFLICT:9"
    );
    // The earlier honest claim is untouched.
    assert_eq!(left.account.mempool().len(), 1);
}
