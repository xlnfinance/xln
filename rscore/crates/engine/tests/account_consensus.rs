//! Two replicas of one account, driven only by the Rust engine: each side
//! holds its own mempool, builds and signs its own frames, and verifies the
//! other's before committing.

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity, AccountInputEnvelope,
    AccountReplica, AccountSettledEvent, AccountState, AccountTx, AckFrameOutcome, BoardDelays,
    BoardHankoRefreshInput, CanonicalValue, CertifiedBoardAuthority, CounterpartyDispute,
    DeliveryMode, Delta, DepositoryAddress, DisputeDraft, EntityId, IncomingAck, IncomingFrame,
    IncomingOutcome, JEventClaimTx, JEventMetadata, JurisdictionEvent, ProposalOutcome,
    ProposedFrame, ReceiverClock, RolledBackProposal, SettlementHankoDraft, SigningIdentity,
    StandaloneInputOutcome, TokenId, WatchSeed, apply_board_hanko_refresh,
    apply_incoming_ack as apply_exact_incoming_ack,
    apply_incoming_frame as apply_exact_incoming_frame, apply_standalone_dispute,
    canonical_tx_value, dispute_proof_hash, propose_account_frame,
};
use xln_rscore_hanko::{
    BoardMember, SemanticClaim, build_single_signer_hanko, hash_hanko_board_claim,
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
    parties_with_transformer(None)
}

fn parties_with_transformer(delta_transformer: Option<[u8; 20]>) -> (Party, Party) {
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
    let mut left_replica =
        AccountReplica::new(left_entity.clone(), state.clone()).expect("left replica");
    let mut right_replica =
        AccountReplica::new(right_entity.clone(), state).expect("right replica");
    if let Some(delta_transformer) = delta_transformer {
        left_replica.set_delta_transformer(delta_transformer);
        right_replica.set_delta_transformer(delta_transformer);
    }
    let left = Party {
        account: AccountConsensus::new(left_replica),
        identity: left_identity,
        entity_id: left_entity,
    };
    let right = Party {
        account: AccountConsensus::new(right_replica),
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

fn swap_resolve_evidence() -> AccountTx {
    AccountTx::SwapResolve {
        offer_id: "evidence-offer".into(),
        fill_ratio: 0,
        fill_numerator: None,
        fill_denominator: None,
        cancel_remainder: true,
        comment: None,
        fee_token_id: None,
        fee_amount: None,
        execution_give_amount: None,
        execution_want_amount: None,
        resting_give_token_id: None,
        resting_want_token_id: None,
        resting_price_ticks: None,
        resting_give_amount: None,
        resting_want_amount: None,
        resting_quantized_give: None,
        resting_quantized_want: None,
    }
}

fn cross_pull_close_evidence(with_proof: bool) -> AccountTx {
    let mut fields = vec![("binary".into(), CanonicalValue::String("0x".into()))];
    if with_proof {
        fields.push(("proof".into(), CanonicalValue::Object(Vec::new())));
    }
    AccountTx::CrossPullClose {
        data: CanonicalValue::Object(fields),
    }
}

fn deferred_j_claim(left: &EntityId, right: &EntityId) -> AccountTx {
    AccountTx::JEventClaim(JEventClaimTx {
        j_height: 8,
        j_block_hash: [0x88; 32],
        events: vec![JurisdictionEvent::AccountSettled(AccountSettledEvent {
            metadata: JEventMetadata::default(),
            left_entity: left.clone(),
            right_entity: right.clone(),
            token_id: TokenId::new(1).expect("token"),
            left_reserve: BigInt::from(0),
            right_reserve: BigInt::from(0),
            collateral: BigInt::from(1),
            ondelta: BigInt::from(0),
            nonce: 0,
        })],
        left_proof: None,
        right_proof: None,
    })
}

fn incoming_of(
    frame: &xln_rscore_engine::AccountFrame,
    state_hash: [u8; 32],
    hanko: Vec<u8>,
) -> IncomingFrame {
    IncomingFrame {
        frame: frame.clone(),
        dispute: None,
        state_hash,
        frame_hanko: Some(hanko),
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

fn apply_incoming_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    from_entity_id: &[u8; 32],
    clock: ReceiverClock,
    incoming: IncomingFrame,
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> Result<xln_rscore_engine::IncomingOutcome, xln_rscore_engine::StateError> {
    let envelope = envelope(account, from_entity_id);
    apply_exact_incoming_frame(account, identity, &envelope, clock, incoming, swap_market)
}

fn apply_incoming_ack(
    account: &mut AccountConsensus,
    from_entity_id: &[u8; 32],
    height: u64,
    state_hash: &[u8; 32],
    hanko: &[u8],
    dispute: Option<CounterpartyDispute>,
) -> Result<xln_rscore_engine::AckOutcome, xln_rscore_engine::StateError> {
    let envelope = envelope(account, from_entity_id);
    apply_exact_incoming_ack(
        account,
        &envelope,
        IncomingAck {
            height,
            frame_hash: *state_hash,
            frame_hanko: Some(hanko.to_vec()),
            dispute,
        },
    )
}

fn certify_dispute(identity: &SigningIdentity, draft: &DisputeDraft) -> CounterpartyDispute {
    CounterpartyDispute {
        hanko: Some(
            identity
                .sign_frame(&draft.hash)
                .expect("sign dispute digest"),
        ),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    }
}

fn resign_dispute(
    account: &AccountConsensus,
    identity: &SigningIdentity,
    dispute: &mut CounterpartyDispute,
) {
    let account_identity = account.replica().state().identity();
    let digest = dispute_proof_hash(
        account_identity.domain().chain_id(),
        account_identity.domain().depository_address().bytes(),
        account_identity
            .entity(xln_rscore_engine::Side::Left)
            .as_bytes(),
        account_identity
            .entity(xln_rscore_engine::Side::Right)
            .as_bytes(),
        dispute.nonce,
        dispute.proposer_is_left,
        &dispute.proof_body_hash,
        account_identity.watch_seed().bytes(),
    );
    dispute.hash = digest;
    dispute.hanko = Some(identity.sign_frame(&digest).expect("sign rebuilt dispute"));
}

fn incoming_with_dispute(proposed: &ProposedFrame, identity: &SigningIdentity) -> IncomingFrame {
    let mut incoming = incoming_of(&proposed.frame, proposed.state_hash, proposed.hanko.clone());
    incoming.dispute = proposed
        .dispute
        .as_ref()
        .map(|draft| certify_dispute(identity, draft));
    incoming
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

/// A resolve commits financial state and its Account-owned queue cleanup as
/// one transition. The duplicate may be queued on the receiver before the
/// frame arrives or on the proposer while its frame awaits the ACK; both
/// replicas must prune it at the same canonical commit boundary.
#[test]
fn committed_htlc_resolve_prunes_queued_lock_replays_on_both_commit_paths() {
    use sha3::{Digest as _, Keccak256};
    use xln_rscore_engine::{HtlcHashlock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx};

    let (mut left, mut right) = parties();
    let secret_bytes = [0x5a_u8; 32];
    let secret = format!("0x{}", hex::encode(secret_bytes));
    let lock_id = format!(
        "0x{}",
        hex::encode(<[u8; 32]>::from(Keccak256::digest(secret_bytes)))
    );
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: lock_id.clone(),
        hashlock: HtlcHashlock::parse(&lock_id).expect("hashlock"),
        timelock: BigInt::from(1_700_000_900_000_u64),
        reveal_before_height: 100,
        amount: BigInt::from(50),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    });

    left.account
        .admit_txs(vec![lock.clone()], "test lock")
        .expect("admit lock");
    let ProposalOutcome::Proposed(lock_frame) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose lock") else {
        panic!("expected lock proposal");
    };
    let lock_frame = *lock_frame;
    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&lock_frame.frame, lock_frame.state_hash, lock_frame.hanko),
        &market(),
    )
    .expect("commit lock") else {
        panic!("expected lock commit");
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

    left.account
        .admit_txs(
            vec![AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: lock_id.clone(),
                outcome: HtlcResolveOutcome::Secret { secret },
            })],
            "test resolve",
        )
        .expect("admit resolve");
    let ProposalOutcome::Proposed(resolve_frame) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose resolve") else {
        panic!("expected resolve proposal");
    };
    let resolve_frame = *resolve_frame;

    // The same stale retry reaches each side at a different bilateral phase.
    right
        .account
        .admit_txs(vec![lock.clone()], "receiver duplicate")
        .expect("admit receiver duplicate");
    left.account
        .admit_txs(vec![lock], "proposer duplicate")
        .expect("admit proposer duplicate");
    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(
            &resolve_frame.frame,
            resolve_frame.state_hash,
            resolve_frame.hanko,
        ),
        &market(),
    )
    .expect("commit resolve") else {
        panic!("expected resolve commit");
    };
    assert!(right.account.mempool().iter().all(|tx| !matches!(
        tx,
        AccountTx::HtlcLock(lock) if lock.lock_id == lock_id
    )));

    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        2,
        &resolve_frame.state_hash,
        &ack_hanko,
        None,
    )
    .expect("ack resolve");
    assert!(left.account.mempool().iter().all(|tx| !matches!(
        tx,
        AccountTx::HtlcLock(lock) if lock.lock_id == lock_id
    )));
    assert!(left.account.replica().state().htlc_lock(&lock_id).is_none());
    assert!(
        right
            .account
            .replica()
            .state()
            .htlc_lock(&lock_id)
            .is_none()
    );
}

#[test]
fn transient_coordination_survives_restore_without_moving_the_entity_leaf() {
    let (mut left, mut right) = parties();
    let initial_leaf = left.account.entity_account_leaf().expect("initial leaf");

    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit");
    assert_eq!(left.account.mempool().len(), 1);
    assert_eq!(
        left.account.entity_account_leaf().expect("queued leaf"),
        initial_leaf,
        "a local mempool must not move the committed Entity root",
    );

    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose") else {
        panic!("expected proposal");
    };
    let proposed = *proposed;
    assert_eq!(
        left.account.entity_account_leaf().expect("pending leaf"),
        initial_leaf,
        "an unacknowledged proposal must not move the committed Entity root",
    );
    let projected = left
        .account
        .projected_leaf_fields()
        .expect("projected fields");
    for transient in [
        "rollbackCount",
        "lastRollbackFrameHash",
        "pendingFrameHash",
        "pendingAccountInput",
        "lastOutboundAckFrame",
    ] {
        assert!(
            projected.iter().all(|(field, _)| field != transient),
            "transient field leaked into Entity leaf: {transient}",
        );
    }

    let mut rollback_snapshot = left.account.consensus_snapshot();
    rollback_snapshot.rollback_count = 7;
    rollback_snapshot.last_rollback_frame_hash = Some([0x71; 32]);
    let restored_pending = AccountConsensus::restore_from_checkpoint(
        left.account.replica().clone(),
        rollback_snapshot,
        &market(),
    )
    .expect("restore pending coordination");
    let restored_snapshot = restored_pending.consensus_snapshot();
    assert!(restored_snapshot.pending.is_some());
    assert_eq!(restored_snapshot.rollback_count, 7);
    assert_eq!(restored_snapshot.last_rollback_frame_hash, Some([0x71; 32]));
    assert_eq!(
        restored_pending
            .entity_account_leaf()
            .expect("restored pending leaf"),
        initial_leaf,
        "recovery-only rollback and pending state must stay outside the root",
    );

    let IncomingOutcome::Committed { .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&proposed.frame, proposed.state_hash, proposed.hanko.clone()),
        &market(),
    )
    .expect("commit on receiver") else {
        panic!("expected commit");
    };
    let with_ack_leaf = right
        .account
        .entity_account_leaf()
        .expect("leaf with ACK retry");
    let mut without_ack_snapshot = right.account.consensus_snapshot();
    assert!(without_ack_snapshot.last_outbound_ack.is_some());
    without_ack_snapshot.last_outbound_ack = None;
    let restored_without_ack = AccountConsensus::restore_from_checkpoint(
        right.account.replica().clone(),
        without_ack_snapshot,
        &market(),
    )
    .expect("restore without ACK retry cache");
    assert_eq!(
        restored_without_ack
            .entity_account_leaf()
            .expect("leaf without ACK retry"),
        with_ack_leaf,
        "ACK resend state must not move the committed Entity root",
    );
}

#[test]
fn dispute_preparation_discards_pending_and_retains_only_canonical_deferred_work() {
    let (mut left, right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit pending payment");
    assert!(matches!(
        propose_account_frame(
            &mut left.account,
            &left.identity,
            CLOCK.entity_timestamp,
            CLOCK.finalized_j_height,
            &market(),
        )
        .expect("propose pending payment"),
        ProposalOutcome::Proposed(_)
    ));
    assert!(left.account.pending().is_some());

    left.account
        .admit_txs(
            vec![
                AccountTx::AddDelta {
                    token_id: TokenId::new(2).expect("token"),
                },
                deferred_j_claim(&left.entity_id, &right.entity_id),
                swap_resolve_evidence(),
                cross_pull_close_evidence(true),
                cross_pull_close_evidence(false),
            ],
            "test",
        )
        .expect("admit queued freeze rows");
    left.account
        .replace_entity_dispute_lifecycle(
            "dispute_preparing",
            Some(CanonicalValue::Object(Vec::new())),
            None,
        )
        .expect("prepare dispute");

    assert!(left.account.pending().is_none());
    assert!(!left.account.accepts_external_input());
    assert_eq!(
        left.account
            .mempool()
            .iter()
            .map(AccountTx::wire_name)
            .collect::<Vec<_>>(),
        vec!["j_event_claim", "swap_resolve", "cross_pull_close"]
    );
}

#[test]
fn direct_disputed_transition_freezes_zero_cooldown_prepare_without_retaining_work() {
    let (mut left, right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit pending payment");
    assert!(matches!(
        propose_account_frame(
            &mut left.account,
            &left.identity,
            CLOCK.entity_timestamp,
            CLOCK.finalized_j_height,
            &market(),
        )
        .expect("propose pending payment"),
        ProposalOutcome::Proposed(_)
    ));
    left.account
        .admit_txs(
            vec![
                deferred_j_claim(&left.entity_id, &right.entity_id),
                swap_resolve_evidence(),
            ],
            "test",
        )
        .expect("admit work before zero-cooldown start");

    left.account
        .replace_entity_dispute_lifecycle("disputed", None, None)
        .expect("direct disputed lifecycle");

    assert!(left.account.pending().is_none());
    assert!(left.account.mempool().is_empty());
    assert!(!left.account.accepts_external_input());
}

#[test]
fn disputed_metadata_update_preserves_work_accumulated_after_initial_freeze() {
    let (mut left, right) = parties();
    left.account
        .replace_entity_dispute_lifecycle(
            "disputed",
            None,
            Some(CanonicalValue::Object(Vec::new())),
        )
        .expect("initial dispute start");
    left.account
        .admit_txs(
            vec![
                payment(&left.entity_id, &right.entity_id, 25),
                swap_resolve_evidence(),
                cross_pull_close_evidence(true),
            ],
            "test",
        )
        .expect("admit post-freeze work");
    let before = left.account.mempool().to_vec();

    left.account
        .replace_entity_dispute_lifecycle(
            "disputed",
            None,
            Some(CanonicalValue::Object(vec![(
                "finalizeQueued".into(),
                CanonicalValue::Bool(true),
            )])),
        )
        .expect("metadata-only disputed update");

    assert_eq!(left.account.mempool(), before);
    assert!(!left.account.accepts_external_input());
}

/// Match `core/account/consensus/proposal/admission.ts`: an Entity whose
/// clock trails the bilateral Account head must stamp the next frame at the
/// committed Account timestamp, never move the chain watermark backwards.
#[test]
fn a_proposal_clamps_its_timestamp_to_the_committed_account_watermark() {
    let (mut left, mut right) = parties();
    let committed_timestamp = 1_700_000_000_005;
    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 10)], "test")
        .expect("admit peer payment");
    let ProposalOutcome::Proposed(peer) = propose_account_frame(
        &mut right.account,
        &right.identity,
        committed_timestamp,
        7,
        &market(),
    )
    .expect("peer proposal") else {
        panic!("expected peer proposal");
    };
    let peer = *peer;
    assert!(matches!(
        apply_incoming_frame(
            &mut left.account,
            &left.identity,
            right.identity.entity_id(),
            CLOCK,
            incoming_of(&peer.frame, peer.state_hash, peer.hanko),
            &market(),
        )
        .expect("commit peer frame"),
        IncomingOutcome::Committed { .. }
    ));

    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 5)], "test")
        .expect("admit local payment");
    let ProposalOutcome::Proposed(next) = propose_account_frame(
        &mut left.account,
        &left.identity,
        committed_timestamp - 1_000,
        7,
        &market(),
    )
    .expect("lagging-clock proposal") else {
        panic!("expected lagging-clock proposal");
    };
    assert_eq!(next.frame.timestamp, committed_timestamp);
    assert_eq!(next.frame.height, 2);
    assert_eq!(
        next.bundled_ack.as_ref().map(|ack| ack.height),
        Some(1),
        "the successor proposal must carry the ACK for the peer's committed H=1 frame",
    );
}

/// The Entity layer must receive the complete committed frame in canonical
/// transaction order. Accepting a peer frame and receiving an ACK commit the
/// same bytes, but only the former is new inbound work for this replica.
#[test]
fn committed_frame_evidence_preserves_body_order_and_provenance() {
    let (mut left, mut right) = parties();
    let first = payment(&left.entity_id, &right.entity_id, 17);
    let second = payment(&left.entity_id, &right.entity_id, 29);
    left.account
        .admit_txs(vec![first.clone(), second.clone()], "test")
        .expect("admit ordered payments");

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
    assert_eq!(frame.txs, vec![first, second]);
    let expected_frame = frame.clone();

    let incoming = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&frame, state_hash, hanko),
        &market(),
    )
    .expect("apply frame");
    let IncomingOutcome::Committed {
        ack_hanko,
        committed_frame,
        ..
    } = incoming
    else {
        panic!("expected a frame commit, got {incoming:?}");
    };
    assert!(committed_frame.committed_via_new_frame);
    assert_eq!(committed_frame.frame, expected_frame);

    let ack = apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        expected_frame.height,
        &state_hash,
        &ack_hanko,
        None,
    )
    .expect("apply ack");
    let xln_rscore_engine::AckOutcome::Committed {
        committed_frame, ..
    } = ack
    else {
        panic!("expected an ack commit, got {ack:?}");
    };
    assert!(!committed_frame.committed_via_new_frame);
    assert_eq!(committed_frame.frame, expected_frame);
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
        assert_eq!(reason, "ACCOUNT_INPUT_PARTY_MISMATCH");
        assert_eq!(right.account.current_height(), 0);
    }

    // The right party, the wrong signature: caught by the Hanko itself.
    let mut forged = incoming_of(&frame, state_hash, hanko.clone());
    forged.frame_hanko = Some(
        right
            .identity
            .sign_frame(&state_hash)
            .expect("forged hanko"),
    );
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        forged,
        &market(),
    )
    .expect("wrong signer is Account input rejection, not engine failure");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason.starts_with("ACCOUNT_INPUT_FRAME_HANKO_INVALID")
    ));
    assert_eq!(right.account.current_height(), 0);

    // The Hanko commits the frame hash, so tampering with a field the hash
    // covers is caught by our own replay rather than by recovery.
    let mut tampered = incoming_of(&frame, state_hash, hanko);
    tampered.frame.account_state_root[0] ^= 0x01;
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
    assert_eq!(reason, "ACCOUNT_INPUT_FRAME_HASH_MISMATCH");
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
        IncomingOutcome::CollisionIgnored { height: 1, .. }
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
        rolled_back,
        ..
    } = outcome
    else {
        panic!("expected RIGHT to commit, got {outcome:?}");
    };
    assert_eq!(rolled_back.expect("collision rolled back").restored, 1);
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
        next_proof_nonce: 1,
        counterparty_dispute: None,
        local_committed_frame_hanko: None,
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
    let timelock = 1_700_000_060_000_u64;
    let hashlock = format!("0x{}", "11".repeat(32));
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: hashlock.clone(),
        hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
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
        reason.starts_with("HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT"),
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

/// TypeScript commits the ACK phase before it examines the bundled proposal.
/// A bad proposal must therefore not resurrect the pending frame the valid ACK
/// just certified.
#[test]
fn ack_frame_keeps_a_valid_ack_when_the_bundled_frame_is_invalid() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit left payment");
    let ProposalOutcome::Proposed(left_frame) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("left proposal") else {
        panic!("expected left proposal");
    };
    let left_frame = *left_frame;
    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&left_frame.frame, left_frame.state_hash, left_frame.hanko),
        &market(),
    )
    .expect("right commits left frame") else {
        panic!("expected right commit");
    };

    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 10)], "test")
        .expect("admit right payment");
    let ProposalOutcome::Proposed(right_frame) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("right proposal") else {
        panic!("expected right proposal");
    };
    let mut invalid = incoming_of(
        &right_frame.frame,
        right_frame.state_hash,
        right_frame.hanko,
    );
    invalid.frame.prev_frame_hash = format!("0x{}", "ff".repeat(32));
    invalid.state_hash = invalid.frame.hash().expect("bad-chain frame hash");
    invalid.frame_hanko = Some(
        right
            .identity
            .sign_frame(&invalid.state_hash)
            .expect("sign bad-chain frame"),
    );

    let right_to_left = envelope(&left.account, right.identity.entity_id());
    let outcome = xln_rscore_engine::apply_incoming_ack_frame(
        &mut left.account,
        &left.identity,
        &right_to_left,
        CLOCK,
        IncomingAck {
            height: left_frame.frame.height,
            frame_hash: left_frame.state_hash,
            frame_hanko: Some(ack_hanko),
            dispute: None,
        },
        invalid,
        &market(),
    )
    .expect("sequential ack_frame");

    let AckFrameOutcome::Applied { ack, frame } = outcome else {
        panic!("ACK phase must commit, got {outcome:?}");
    };
    assert!(matches!(
        *ack,
        xln_rscore_engine::AckOutcome::Committed { height: 1, .. }
    ));
    assert!(matches!(
        *frame,
        IncomingOutcome::Rejected { ref reason }
            if reason.starts_with("ACCOUNT_INPUT_FRAME_PREV_MISMATCH")
    ));
    assert_eq!(left.account.current_height(), 1);
    assert!(left.account.pending().is_none());
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
        reason.starts_with("ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID:skew"),
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

    // A copied stateHash and Hanko cannot authenticate altered frame bytes.
    let leaf_after_first = right.account.entity_account_leaf().expect("leaf");
    let mut altered = incoming_of(&first.frame, first.state_hash, first.hanko.clone());
    altered.frame.account_state_root[0] ^= 0x01;
    let altered = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        altered,
        &market(),
    )
    .expect("altered duplicate is a typed rejection");
    assert!(matches!(
        altered,
        IncomingOutcome::Rejected { reason }
            if reason == "DUPLICATE_FRAME_BYTES_CONFLICT:height=1"
    ));
    assert_eq!(
        right.account.entity_account_leaf().expect("leaf"),
        leaf_after_first
    );

    // The exact frame and exact retained peer certificate remain a no-op that
    // returns the original local ACK after delivery loss.
    let duplicate = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&first.frame, first.state_hash, first.hanko.clone()),
        &market(),
    )
    .expect("exact-current retry retains its certificate");
    let IncomingOutcome::Duplicate {
        height: 1,
        state_hash,
        ack_hanko: duplicate_ack_hanko,
        ..
    } = duplicate
    else {
        panic!("expected exact-current duplicate");
    };
    assert_eq!(state_hash, first.state_hash);
    assert_eq!(duplicate_ack_hanko, ack_hanko);
    assert_eq!(
        right.account.entity_account_leaf().expect("leaf"),
        leaf_after_first
    );

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
        incoming_of(&second.frame, second.state_hash, second.hanko.clone()),
        &market(),
    )
    .expect("apply");
    assert_eq!(right.account.current_height(), 2);

    let mut ancestor = incoming_of(&first.frame, first.state_hash, first.hanko);
    ancestor.frame_hanko = None;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        ancestor,
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

    // Equal height with another stateHash is a conflict, not an ancestor.
    // It must reach active validation even though the height is already
    // committed, or a peer could hide contradictory evidence as stale.
    let mut conflict = incoming_of(&second.frame, second.state_hash, second.hanko);
    conflict.state_hash[0] ^= 0x01;
    conflict.frame_hanko = Some(
        left.identity
            .sign_frame(&conflict.state_hash)
            .expect("conflict signature"),
    );
    let conflict = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        conflict,
        &market(),
    )
    .expect("equal-height conflict is a typed rejection");
    assert!(matches!(
        conflict,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_FRAME_HASH_MISMATCH"
    ));
    assert_eq!(right.account.current_height(), 2);
}

/// A successor proposal owns a different Hanko. Retrying the committed head
/// must still return the exact local ACK certificate retained for that head.
#[test]
fn duplicate_current_frame_reuses_committed_hanko_while_successor_is_pending() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit first");
    let ProposalOutcome::Proposed(first) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose first") else {
        panic!("expected first proposal");
    };
    let first = *first;
    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&first.frame, first.state_hash, first.hanko.clone()),
        &market(),
    )
    .expect("commit first") else {
        panic!("expected first commit");
    };

    right
        .account
        .admit_txs(vec![payment(&right.entity_id, &left.entity_id, 5)], "test")
        .expect("admit successor");
    let ProposalOutcome::Proposed(successor) = propose_account_frame(
        &mut right.account,
        &right.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose successor") else {
        panic!("expected successor proposal");
    };
    assert_eq!(successor.frame.height, 2);

    let retry = incoming_of(&first.frame, first.state_hash, first.hanko);
    let IncomingOutcome::Duplicate {
        ack_hanko: retried_ack_hanko,
        ..
    } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        retry,
        &market(),
    )
    .expect("duplicate current frame")
    else {
        panic!("expected duplicate outcome");
    };

    assert_eq!(retried_ack_hanko, ack_hanko);
    assert_eq!(right.account.current_height(), 1);
    assert_eq!(
        right.account.pending().map(|pending| pending.frame.height),
        Some(2)
    );
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
    broken.frame.account_state_root[0] ^= 0x01;
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
                rolled_back: Some(RolledBackProposal { restored: 1, .. }),
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

    let snapshot = left.account.consensus_snapshot();
    assert!(snapshot.counterparty_frame_hanko.is_some());
    assert!(snapshot.local_committed_frame_hanko.is_some());
    let error = AccountConsensus::restore_from_checkpoint(
        left.account.replica().clone(),
        ConsensusSnapshot {
            counterparty_frame_hanko: None,
            ..snapshot
        },
        &market(),
    )
    .expect_err("restore without the bilateral certificate");
    assert!(
        error
            .to_string()
            .contains("CURRENT_FRAME_CERTIFICATE_MISSING"),
        "{error}",
    );
}

/// Every canonical AccountTx must be hashable even when its current machine
/// policy rejects execution. Admission and execution rejection are distinct.
#[test]
fn reserve_to_collateral_is_hashable_then_rejected_by_execution() {
    let (mut left, right) = parties();
    let admission = left
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
        .expect("canonical transaction is hashable");
    assert_eq!(admission.admitted, 1);
    let ProposalOutcome::Idle { dropped } = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        0,
        &market(),
    )
    .expect("policy rejection") else {
        panic!("blocked reserve transition must not produce a frame")
    };
    assert_eq!(dropped.len(), 1);
    assert!(left.account.mempool().is_empty());
    // The account still works.
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 5)], "test")
        .expect("admit");
    assert_eq!(left.account.mempool().len(), 1);
}

#[test]
fn rebalance_policy_is_hashable_at_admission_and_cross_peer_replay() {
    let (mut left, mut right) = parties();
    let policy = AccountTx::RebalancePolicy {
        token_id: 1,
        policy_version: 7,
        base_fee: BigInt::from(19),
        liquidity_fee_bps: BigInt::from(375),
        gas_fee: BigInt::from(23),
    };
    left.account
        .admit_txs(vec![policy.clone()], "test")
        .expect("rebalance policy is frame-hashable");

    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose policy") else {
        panic!("expected a policy proposal");
    };
    assert_eq!(proposed.frame.txs, vec![policy]);

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&proposed.frame, proposed.state_hash, proposed.hanko.clone()),
        &market(),
    )
    .expect("replay policy");
    assert!(matches!(
        outcome,
        IncomingOutcome::Committed { height: 1, .. }
    ));
    assert_eq!(right.account.current_height(), 1);
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
        let hashlock = format!("0x{:02x}{}", index % 256, "11".repeat(31));
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: hashlock.clone(),
            hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
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
    let hashlock_text = format!("0x{}", hex::encode(hashlock_bytes));
    let hashlock = HtlcHashlock::parse(&hashlock_text).expect("hashlock");
    let second_secret_bytes = [0x6b_u8; 32];
    let second_secret = format!("0x{}", hex::encode(second_secret_bytes));
    let second_hashlock_bytes: [u8; 32] = Keccak256::digest(second_secret_bytes).into();
    let second_hashlock_text = format!("0x{}", hex::encode(second_hashlock_bytes));
    let second_hashlock = HtlcHashlock::parse(&second_hashlock_text).expect("second hashlock");

    // Height 1: LEFT locks, both sides commit.
    left.account
        .admit_txs(
            vec![
                AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: hashlock_text.clone(),
                    hashlock,
                    timelock: Big::from(1_700_000_900_000_u64),
                    reveal_before_height: 100,
                    amount: Big::from(50),
                    token_id: TokenId::new(1).expect("token"),
                    delivery_mode: None,
                    envelope: None,
                }),
                AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: second_hashlock_text.clone(),
                    hashlock: second_hashlock,
                    timelock: Big::from(1_700_000_900_000_u64),
                    reveal_before_height: 100,
                    amount: Big::from(30),
                    token_id: TokenId::new(1).expect("token"),
                    delivery_mode: None,
                    envelope: None,
                }),
            ],
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
            vec![
                AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: hashlock_text.clone(),
                    outcome: HtlcResolveOutcome::Secret { secret },
                }),
                AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: second_hashlock_text.clone(),
                    outcome: HtlcResolveOutcome::Secret {
                        secret: second_secret,
                    },
                }),
            ],
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
    let pending_snapshot = right.account.consensus_snapshot();
    right.account = AccountConsensus::restore_from_checkpoint(
        right.account.replica().clone(),
        pending_snapshot,
        &market(),
    )
    .expect("restore pending resolve before ack");

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
        ack_hanko,
        committed_frame,
        ..
    } = outcome
    else {
        panic!("expected a commit");
    };
    let outputs = committed_frame
        .outputs_by_tx
        .iter()
        .flatten()
        .collect::<Vec<_>>();
    assert!(
        outputs
            .iter()
            .any(|output| matches!(output, AccountOutput::HtlcSecret { .. })),
        "{outputs:?}",
    );
    assert_eq!(committed_frame.outputs_by_tx.len(), 2);
    for (row, expected_lock_id) in committed_frame
        .outputs_by_tx
        .iter()
        .zip([hashlock_text.as_str(), second_hashlock_text.as_str()])
    {
        assert!(
            matches!(row.as_slice(), [AccountOutput::HtlcSecret { lock_id, .. }] if lock_id == expected_lock_id),
            "{row:?}",
        );
    }

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
    let xln_rscore_engine::AckOutcome::Committed {
        committed_frame, ..
    } = ack
    else {
        panic!("expected an ack commit, got {ack:?}");
    };
    let outputs = committed_frame
        .outputs_by_tx
        .iter()
        .flatten()
        .collect::<Vec<_>>();
    assert!(
        outputs
            .iter()
            .any(|output| matches!(output, AccountOutput::HtlcSecret { .. })),
        "{outputs:?}",
    );
    assert_eq!(committed_frame.outputs_by_tx.len(), 2);
}

/// A valid signed secret inside the 30-second enforcement reserve is dispute
/// evidence, not a normal rejection and never an off-chain commit.
#[test]
fn a_secret_inside_the_enforcement_reserve_requires_dispute() {
    use num_bigint::BigInt as Big;
    use sha3::{Digest as _, Keccak256};
    use xln_rscore_engine::{HtlcHashlock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx};

    let (mut left, mut right) = parties();
    let secret_bytes = [0x7c_u8; 32];
    let secret = format!("0x{}", hex::encode(secret_bytes));
    let hashlock_bytes: [u8; 32] = Keccak256::digest(secret_bytes).into();
    let hashlock_text = format!("0x{}", hex::encode(hashlock_bytes));
    let timelock = 1_700_000_100_000_u64;
    left.account
        .admit_txs(
            vec![AccountTx::HtlcLock(HtlcLockTx {
                lock_id: hashlock_text.clone(),
                hashlock: HtlcHashlock::parse(&hashlock_text).expect("hashlock"),
                timelock: Big::from(timelock),
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
        panic!("expected lock proposal");
    };
    let lock_frame = *lock_frame;
    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&lock_frame.frame, lock_frame.state_hash, lock_frame.hanko),
        &market(),
    )
    .expect("commit lock") else {
        panic!("expected lock commit");
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

    left.account
        .admit_txs(
            vec![AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: hashlock_text.clone(),
                outcome: HtlcResolveOutcome::Secret {
                    secret: secret.clone(),
                },
            })],
            "test",
        )
        .expect("admit secret");
    let ProposalOutcome::Proposed(resolve_frame) = propose_account_frame(
        &mut left.account,
        &left.identity,
        timelock - 20_000,
        7,
        &market(),
    )
    .expect("propose secret") else {
        panic!("expected secret proposal");
    };
    let resolve_frame = *resolve_frame;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        ReceiverClock {
            entity_timestamp: timelock - 10_000,
            finalized_j_height: 7,
        },
        incoming_of(
            &resolve_frame.frame,
            resolve_frame.state_hash,
            resolve_frame.hanko,
        ),
        &market(),
    )
    .expect("deadline disposition");
    let IncomingOutcome::DisputeRequired {
        reason,
        evidence_secrets,
        signed_frame,
    } = outcome
    else {
        panic!("expected dispute-required outcome, got {outcome:?}");
    };
    assert!(
        reason.starts_with("HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT"),
        "{reason}"
    );
    assert_eq!(evidence_secrets.len(), 1);
    assert_eq!(evidence_secrets[0].hashlock, hashlock_text);
    assert_eq!(evidence_secrets[0].secret, secret);
    assert_eq!(signed_frame.state_hash, resolve_frame.state_hash);
    assert_eq!(right.account.current_height(), 1);
}

/// A recovery witness is a second, independent certificate: the receiver
/// rebuilds its Solidity digest, recovers the account counterparty, and only
/// then retains it. The ACK path performs the same check in the other
/// direction before releasing the pending frame's effects.
#[test]
fn counterparty_dispute_hankos_are_verified_on_frame_and_ack() {
    let transformer = [0x77_u8; 20];
    let (mut left, mut right) = parties_with_transformer(Some(transformer));
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
        panic!("expected proposal");
    };
    let proposed = *proposed;
    let proposal_dispute = proposed.dispute.clone().expect("proposal dispute");
    assert!(proposed.dispute_signature.is_some());
    assert!(proposed.dispute_hanko.is_some());

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_with_dispute(&proposed, &left.identity),
        &market(),
    )
    .expect("verified frame");
    let IncomingOutcome::Committed {
        ack_hanko,
        ack_dispute_signature,
        ack_dispute_hanko,
        ..
    } = outcome
    else {
        panic!("expected commit, got {outcome:?}");
    };
    assert!(ack_dispute_signature.is_some());
    assert!(ack_dispute_hanko.is_some());
    let stored = right
        .account
        .counterparty_dispute()
        .expect("stored peer dispute");
    assert_eq!(stored.proof_body_hash, proposal_dispute.proof_body_hash);
    assert_eq!(stored.nonce, proposal_dispute.nonce);

    let left_to_right = envelope(&right.account, left.identity.entity_id());
    let standalone = apply_standalone_dispute(
        &mut right.account,
        &left_to_right,
        CLOCK,
        certify_dispute(&left.identity, &proposal_dispute),
        None,
    )
    .expect("standalone dispute reducer");
    assert_eq!(
        standalone,
        StandaloneInputOutcome::Applied { events: Vec::new() }
    );

    let rotated_key = [0x35_u8; 32];
    let rotated_hanko = build_single_signer_hanko(
        left.identity.entity_id(),
        &proposed.state_hash,
        &rotated_key,
        2,
        2,
        BoardDelays::default(),
    )
    .expect("rotated frame hanko");
    let rotated_address =
        xln_rscore_engine::address_of_private_key(&rotated_key).expect("rotated signer address");
    let mut rotated_member = [0_u8; 32];
    rotated_member[12..].copy_from_slice(&rotated_address);
    let rotated_board_hash = hash_hanko_board_claim(&SemanticClaim {
        entity_id: *left.identity.entity_id(),
        members: vec![BoardMember {
            entity_id: rotated_member,
            weight: 2,
        }],
        threshold: 2,
        delays: BoardDelays::default(),
    });
    let authority = CertifiedBoardAuthority {
        entity_id: *left.identity.entity_id(),
        registered_board_hash: rotated_board_hash,
        previous_board_hash: [0_u8; 32],
        previous_board_valid_until: 0,
        activated_at_j_height: 88,
        activation_log_index: 3,
    };
    let leaf_before_refresh = right
        .account
        .entity_account_leaf()
        .expect("leaf before refresh");
    let refresh = apply_board_hanko_refresh(
        &mut right.account,
        &left_to_right,
        CLOCK,
        BoardHankoRefreshInput {
            height: 1,
            frame_hash: proposed.state_hash,
            frame_hanko: Some(rotated_hanko),
            dispute: None,
            board_activation_j_height: 88,
            board_activation_log_index: 3,
        },
        Some(&authority),
    )
    .expect("board refresh reducer");
    assert!(matches!(
        refresh,
        StandaloneInputOutcome::Applied { ref events }
            if events == &["🔐 Refreshed Account frame 1 Hankos under the current board"]
    ));
    assert_ne!(
        leaf_before_refresh,
        right.account.entity_account_leaf().expect("refreshed leaf")
    );

    let ack_draft = right
        .account
        .consensus_snapshot()
        .last_outbound_ack
        .and_then(|ack| ack.dispute)
        .expect("ack dispute");
    let ack = apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &proposed.state_hash,
        &ack_hanko,
        Some(certify_dispute(&right.identity, &ack_draft)),
    )
    .expect("verified ack");
    assert!(matches!(
        ack,
        xln_rscore_engine::AckOutcome::Committed { .. }
    ));
    assert_eq!(
        left.account
            .counterparty_dispute()
            .expect("stored ack dispute")
            .proof_body_hash,
        ack_draft.proof_body_hash,
    );
}

/// Parent certification is not another Account IPC message. The outbound
/// candidate records that its fresh recovery draft will be certified by the
/// Entity manifest; only a candidate selected by the next accounts root can
/// reach this second proposal. A proof-body-neutral policy update must then
/// reuse the exact draft, matching TypeScript's `resolveDisputeHanko` branch.
#[test]
fn a_parent_selected_candidate_reuses_its_certified_recovery_draft() {
    let (mut left, mut right) = parties_with_transformer(Some([0x77_u8; 20]));
    let policy = |version| AccountTx::RebalancePolicy {
        token_id: 1,
        policy_version: version,
        base_fee: BigInt::from(version),
        liquidity_fee_bps: BigInt::from(375),
        gas_fee: BigInt::from(23),
    };
    left.account
        .admit_txs(vec![policy(1)], "test")
        .expect("admit first policy");
    let ProposalOutcome::Proposed(first) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("first proposal") else {
        panic!("expected first proposal");
    };
    let first = *first;
    first.dispute.as_ref().expect("first recovery draft");
    let first_dispute_hanko = first
        .dispute_hanko
        .clone()
        .expect("proposal presigned recovery draft");
    assert!(
        left.account
            .consensus_snapshot()
            .pending
            .and_then(|pending| pending.proposal_dispute)
            .and_then(|draft| draft.hanko)
            .is_some_and(|hanko| hanko == first_dispute_hanko)
    );

    let IncomingOutcome::Committed { ack_hanko, .. } = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_with_dispute(&first, &left.identity),
        &market(),
    )
    .expect("peer commits first proposal") else {
        panic!("expected first commit");
    };
    let ack_draft = right
        .account
        .consensus_snapshot()
        .last_outbound_ack
        .and_then(|ack| ack.dispute)
        .expect("ack recovery draft");
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        first.frame.height,
        &first.state_hash,
        &ack_hanko,
        Some(certify_dispute(&right.identity, &ack_draft)),
    )
    .expect("commit first proposal ack");

    left.account
        .admit_txs(vec![policy(2)], "test")
        .expect("admit second policy");
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_001,
        8,
        &market(),
    )
    .expect("second proposal") else {
        panic!("expected second proposal");
    };
    assert_eq!(
        second
            .dispute
            .as_ref()
            .and_then(|draft| draft.hanko.as_ref()),
        Some(&first_dispute_hanko)
    );
}

/// A valid frame certificate does not bless its attached dispute witness. A
/// foreign signer and a role bit changed underneath the original signature
/// are both rejected before replay, leaving the account at H=0.
#[test]
fn a_forged_or_retargeted_dispute_hanko_is_refused_before_frame_replay() {
    let (mut left, mut right) = parties_with_transformer(Some([0x77_u8; 20]));
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
        panic!("expected proposal");
    };
    let proposed = *proposed;

    let mut wrong_signer = incoming_with_dispute(&proposed, &left.identity);
    let draft = proposed.dispute.as_ref().expect("dispute");
    wrong_signer.dispute.as_mut().expect("wire dispute").hanko = Some(
        right
            .identity
            .sign_frame(&draft.hash)
            .expect("foreign signature"),
    );
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        wrong_signer,
        &market(),
    )
    .expect("foreign dispute signer is an Account input rejection");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason.starts_with("ACCOUNT_INPUT_DISPUTE_HANKO_INVALID")
    ));
    assert_eq!(right.account.current_height(), 0);

    let mut wrong_role = incoming_with_dispute(&proposed, &left.identity);
    let dispute = wrong_role.dispute.as_mut().expect("wire dispute");
    dispute.proposer_is_left = !dispute.proposer_is_left;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        wrong_role,
        &market(),
    )
    .expect("retargeted role is an Account input rejection");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason.starts_with("ACCOUNT_INPUT_DISPUTE_HANKO_INVALID")
                || reason == "ACCOUNT_BOARD_AUTHORITY_UNAVAILABLE"
    ));
    assert_eq!(right.account.current_height(), 0);
}

/// Even a genuine Hanko by the correct counterparty is not enough: its proof
/// body must be the body Rust independently derives from the replayed frame.
#[test]
fn a_signed_dispute_for_another_proof_body_is_refused() {
    let (mut left, mut right) = parties_with_transformer(Some([0x77_u8; 20]));
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
        panic!("expected proposal");
    };
    let proposed = *proposed;
    let mut incoming = incoming_with_dispute(&proposed, &left.identity);
    let dispute = incoming.dispute.as_mut().expect("wire dispute");
    dispute.proof_body_hash[0] ^= 0x01;
    resign_dispute(&right.account, &left.identity, dispute);

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming,
        &market(),
    )
    .expect("valid signature, invalid candidate binding");
    let IncomingOutcome::Rejected { reason } = outcome else {
        panic!("expected rejection, got {outcome:?}");
    };
    assert!(
        reason.starts_with("DISPUTE_HANKO_PROOFBODY_MISMATCH"),
        "{reason}"
    );
    assert_eq!(right.account.current_height(), 0);
    assert!(right.account.counterparty_dispute().is_none());
}

/// Account leaves encode proof nonces through the same safe-integer domain as
/// TypeScript. The inclusive boundary remains valid; the next u64 is refused
/// before signature recovery so it can never be rounded in the leaf.
#[test]
fn dispute_nonce_respects_the_typescript_safe_integer_boundary() {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let transformer = [0x77_u8; 20];
    let (mut left, mut right) = parties_with_transformer(Some(transformer));
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
        panic!("expected proposal");
    };
    let proposed = *proposed;
    let mut incoming = incoming_with_dispute(&proposed, &left.identity);
    let dispute = incoming.dispute.as_mut().expect("wire dispute");
    dispute.nonce = MAX_SAFE_INTEGER;
    resign_dispute(&right.account, &left.identity, dispute);
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming,
        &market(),
    )
    .expect("safe boundary");
    assert!(matches!(outcome, IncomingOutcome::Committed { .. }));
    assert_eq!(
        right.account.counterparty_dispute().expect("stored").nonce,
        MAX_SAFE_INTEGER,
    );

    let (mut left, mut right) = parties_with_transformer(Some(transformer));
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
        panic!("expected proposal");
    };
    let mut incoming = incoming_with_dispute(&proposed, &left.identity);
    incoming.dispute.as_mut().expect("wire dispute").nonce = MAX_SAFE_INTEGER + 1;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming,
        &market(),
    )
    .expect("unsafe nonce is an Account input rejection");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason
                == "ACCOUNT_INPUT_DISPUTE_HANKO_INVALID:SHAPE_INVALID:PROOF_NONCE:9007199254740992"
    ));
    assert_eq!(right.account.current_height(), 0);
}

/// A current-frame retry must carry the exact peer proposal certificate
/// retained at commit. Missing or substituted bytes are protocol errors,
/// while the exact retry is a no-op that re-sends the retained local ACK.
#[test]
fn duplicate_current_frame_requires_exact_counterparty_hanko() {
    let (mut left, mut right) = parties_with_transformer(Some([0x77_u8; 20]));
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
        panic!("expected proposal");
    };
    let proposed = *proposed;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_with_dispute(&proposed, &left.identity),
        &market(),
    )
    .expect("frame");
    let IncomingOutcome::Committed { ack_hanko, .. } = outcome else {
        panic!("expected commit");
    };
    let ack_draft = right
        .account
        .consensus_snapshot()
        .last_outbound_ack
        .and_then(|ack| ack.dispute)
        .expect("ack dispute");
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &proposed.state_hash,
        &ack_hanko,
        Some(certify_dispute(&right.identity, &ack_draft)),
    )
    .expect("ack");

    let right_leaf = right.account.entity_account_leaf().expect("right leaf");
    let mut malformed_dispute = incoming_with_dispute(&proposed, &left.identity);
    malformed_dispute.dispute.as_mut().expect("dispute").hanko = Some(Vec::new());
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        malformed_dispute,
        &market(),
    )
    .expect("malformed dispute remains a typed rejection before replay classification");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_DISPUTE_HANKO_INVALID:SHAPE_INVALID:HANKO_MISSING"
    ));

    let mut missing = incoming_with_dispute(&proposed, &left.identity);
    missing.frame_hanko = None;
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        missing,
        &market(),
    )
    .expect("missing current-frame certificate is a typed rejection");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_FRAME_HANKO_MISSING"
    ));

    let mut substituted = incoming_with_dispute(&proposed, &left.identity);
    substituted.frame_hanko = Some(
        right
            .identity
            .sign_frame(&proposed.state_hash)
            .expect("well-formed substitute certificate"),
    );
    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        substituted,
        &market(),
    )
    .expect("substituted current-frame certificate is a typed rejection");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_FRAME_HANKO_CONFLICT"
    ));

    let outcome = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_with_dispute(&proposed, &left.identity),
        &market(),
    )
    .expect("exact current-frame retry");
    let IncomingOutcome::Duplicate {
        ack_hanko: retried_ack_hanko,
        height: 1,
        ..
    } = outcome
    else {
        panic!("expected exact duplicate");
    };
    assert_eq!(retried_ack_hanko, ack_hanko);
    assert_eq!(
        right
            .account
            .entity_account_leaf()
            .expect("right leaf after"),
        right_leaf,
    );

    let left_leaf = left.account.entity_account_leaf().expect("left leaf");
    let mut obsolete_dispute = certify_dispute(&right.identity, &ack_draft);
    obsolete_dispute.hanko = Some(vec![0]);
    let ack = apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &proposed.state_hash,
        &ack_hanko,
        Some(obsolete_dispute),
    )
    .expect("repeated ack validates its witness");
    assert!(matches!(
        ack,
        xln_rscore_engine::AckOutcome::Rejected { reason }
            if reason.starts_with("ACCOUNT_INPUT_DISPUTE_HANKO_INVALID")
    ));
    assert_eq!(
        left.account.entity_account_leaf().expect("left leaf after"),
        left_leaf,
    );
}

#[test]
fn exact_dispute_hash_is_account_bound_before_mutation() {
    let (mut left, mut right) = parties_with_transformer(Some([0x77_u8; 20]));
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
        panic!("expected proposal");
    };
    let mut incoming = incoming_with_dispute(&proposed, &left.identity);
    incoming.dispute.as_mut().expect("dispute").hash[0] ^= 0x01;
    let leaf = right.account.entity_account_leaf().expect("leaf before");
    let exact_envelope = envelope(&right.account, left.identity.entity_id());

    let outcome = apply_exact_incoming_frame(
        &mut right.account,
        &right.identity,
        &exact_envelope,
        CLOCK,
        incoming,
        &market(),
    )
    .expect("wrong wire hash is an Account input rejection, not an engine failure");
    assert!(matches!(
        outcome,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_DISPUTE_HANKO_INVALID:HASH_MISMATCH"
    ));
    assert_eq!(right.account.current_height(), 0);
    assert_eq!(
        right.account.entity_account_leaf().expect("leaf after"),
        leaf
    );
}

#[test]
fn envelope_sentinels_precede_mutation_and_watch_seed_absence_is_preserved() {
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
        panic!("expected proposal");
    };
    let incoming = incoming_of(&proposed.frame, proposed.state_hash, proposed.hanko.clone());
    let leaf = right.account.entity_account_leaf().expect("leaf before");
    let mut wrong = envelope(&right.account, left.identity.entity_id());
    wrong.dispute_config = AccountDisputeConfig::new(11, 10).expect("sentinel config");

    let rejected = apply_exact_incoming_frame(
        &mut right.account,
        &right.identity,
        &wrong,
        CLOCK,
        incoming.clone(),
        &market(),
    )
    .expect("envelope mismatch is a typed rejection");
    assert!(matches!(
        rejected,
        IncomingOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_DISPUTE_CONFIG_MISMATCH"
    ));
    assert_eq!(right.account.current_height(), 0);
    assert_eq!(
        right
            .account
            .entity_account_leaf()
            .expect("leaf after reject"),
        leaf
    );

    let mut seed_absent = envelope(&right.account, left.identity.entity_id());
    seed_absent.watch_seed = None;
    let committed = apply_exact_incoming_frame(
        &mut right.account,
        &right.identity,
        &seed_absent,
        CLOCK,
        incoming,
        &market(),
    )
    .expect("omitted seed remains absent instead of being defaulted");
    assert!(matches!(
        committed,
        IncomingOutcome::Committed { height: 1, .. }
    ));
    assert_eq!(right.account.current_height(), 1);
}

#[test]
fn standalone_ack_replay_boundaries_match_typescript_certificate_gates() {
    let (mut left, mut right) = parties();
    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 25)], "test")
        .expect("admit first");
    let ProposalOutcome::Proposed(first) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_000,
        7,
        &market(),
    )
    .expect("propose first") else {
        panic!("expected first proposal");
    };
    let first = *first;
    let committed = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&first.frame, first.state_hash, first.hanko),
        &market(),
    )
    .expect("commit first on receiver");
    let IncomingOutcome::Committed { ack_hanko, .. } = committed else {
        panic!("expected first commit");
    };
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        1,
        &first.state_hash,
        &ack_hanko,
        None,
    )
    .expect("commit first on proposer");

    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 5)], "test")
        .expect("admit second");
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_001,
        7,
        &market(),
    )
    .expect("propose second") else {
        panic!("expected second proposal");
    };
    let second = *second;
    let left_leaf = left.account.entity_account_leaf().expect("left leaf");
    let pending_hash = left.account.pending().expect("pending second").state_hash;
    let left_envelope = envelope(&left.account, right.identity.entity_id());

    let repeated = apply_exact_incoming_ack(
        &mut left.account,
        &left_envelope,
        IncomingAck {
            height: 1,
            frame_hash: first.state_hash,
            frame_hanko: Some(ack_hanko.clone()),
            dispute: None,
        },
    )
    .expect("exact current ACK is accepted without touching the pending frame");
    assert!(matches!(
        repeated,
        xln_rscore_engine::AckOutcome::Accepted { height: 1 }
    ));
    assert_eq!(
        left.account
            .pending()
            .expect("pending survives repeat")
            .state_hash,
        pending_hash,
    );

    for frame_hanko in [None, Some(vec![0])] {
        let repeated = apply_exact_incoming_ack(
            &mut left.account,
            &left_envelope,
            IncomingAck {
                height: 1,
                frame_hash: [0x44; 32],
                frame_hanko,
                dispute: None,
            },
        )
        .expect("a non-current ACK is rejected");
        assert!(matches!(
            repeated,
            xln_rscore_engine::AckOutcome::Rejected { .. }
        ));
    }
    let invalid_active = apply_exact_incoming_ack(
        &mut left.account,
        &left_envelope,
        IncomingAck {
            height: 2,
            frame_hash: second.state_hash,
            frame_hanko: Some(vec![0]),
            dispute: None,
        },
    )
    .expect("bad active ACK certificate is an Account input rejection");
    assert!(matches!(
        invalid_active,
        xln_rscore_engine::AckOutcome::Rejected { reason }
            if reason.starts_with("ACCOUNT_INPUT_FRAME_HANKO_INVALID")
    ));
    assert_eq!(
        left.account.entity_account_leaf().expect("left leaf"),
        left_leaf
    );
    assert_eq!(
        left.account.pending().expect("pending survives").state_hash,
        pending_hash,
    );

    let second_commit = apply_incoming_frame(
        &mut right.account,
        &right.identity,
        left.identity.entity_id(),
        CLOCK,
        incoming_of(&second.frame, second.state_hash, second.hanko.clone()),
        &market(),
    )
    .expect("commit second on receiver");
    let IncomingOutcome::Committed {
        ack_hanko: second_ack_hanko,
        ..
    } = second_commit
    else {
        panic!("expected second commit");
    };
    apply_incoming_ack(
        &mut left.account,
        right.identity.entity_id(),
        2,
        &second.state_hash,
        &second_ack_hanko,
        None,
    )
    .expect("commit second on proposer");

    let right_leaf = right.account.entity_account_leaf().expect("right leaf");
    let right_envelope = envelope(&right.account, left.identity.entity_id());
    let delayed_predecessor_hanko = left
        .identity
        .sign_frame(&first.state_hash)
        .expect("sign predecessor ACK");
    let delayed = apply_exact_incoming_ack(
        &mut right.account,
        &right_envelope,
        IncomingAck {
            height: 1,
            frame_hash: first.state_hash,
            frame_hanko: Some(delayed_predecessor_hanko.clone()),
            dispute: None,
        },
    )
    .expect("authenticated immediate predecessor ACK is an idempotent no-op");
    assert!(matches!(
        delayed,
        xln_rscore_engine::AckOutcome::Accepted { height: 1 }
    ));
    assert_eq!(right.account.current_height(), 2);
    assert_eq!(
        right.account.entity_account_leaf().expect("right leaf"),
        right_leaf
    );

    left.account
        .admit_txs(vec![payment(&left.entity_id, &right.entity_id, 1)], "test")
        .expect("admit third");
    let ProposalOutcome::Proposed(third) = propose_account_frame(
        &mut left.account,
        &left.identity,
        1_700_000_000_002,
        7,
        &market(),
    )
    .expect("propose third") else {
        panic!("expected third proposal");
    };
    let bundled = xln_rscore_engine::apply_incoming_ack_frame(
        &mut right.account,
        &right.identity,
        &right_envelope,
        CLOCK,
        IncomingAck {
            height: 1,
            frame_hash: first.state_hash,
            frame_hanko: Some(delayed_predecessor_hanko.clone()),
            dispute: None,
        },
        incoming_of(&third.frame, third.state_hash, third.hanko.clone()),
        &market(),
    )
    .expect("stale ACK cannot authorize a bundled successor");
    assert!(matches!(
        bundled,
        AckFrameOutcome::Rejected {
            phase: xln_rscore_engine::AckFramePhase::Ack,
            ..
        }
    ));
    assert_eq!(right.account.current_height(), 2);
    assert_eq!(
        right.account.entity_account_leaf().expect("right leaf"),
        right_leaf
    );

    for (height, frame_hash, frame_hanko) in [
        (0, first.state_hash, Some(delayed_predecessor_hanko)),
        (1, [0x55; 32], Some(vec![0])),
        (2, second.state_hash, Some(vec![0])),
    ] {
        let invalid = apply_exact_incoming_ack(
            &mut right.account,
            &right_envelope,
            IncomingAck {
                height,
                frame_hash,
                frame_hanko,
                dispute: None,
            },
        )
        .expect("only exact authenticated current/predecessor ACKs are no-ops");
        assert!(matches!(
            invalid,
            xln_rscore_engine::AckOutcome::Rejected { .. }
        ));
    }
    let future = apply_exact_incoming_ack(
        &mut right.account,
        &right_envelope,
        IncomingAck {
            height: 4,
            frame_hash: [0x66; 32],
            frame_hanko: Some(vec![0]),
            dispute: None,
        },
    )
    .expect("unmatched future ACK is an Account input rejection");
    assert!(matches!(
        future,
        xln_rscore_engine::AckOutcome::Rejected { reason }
            if reason == "ACCOUNT_INPUT_ACK_UNMATCHED:4:none"
    ));
    assert_eq!(
        right.account.entity_account_leaf().expect("right leaf"),
        right_leaf
    );
}

fn market() -> std::sync::Arc<xln_rscore_engine::SwapMarketPolicy> {
    std::sync::Arc::default()
}

#[test]
fn certified_settlement_hankos_replace_the_pre_admitted_unsigned_tx() {
    let (mut left, _) = parties();
    let unsigned = AccountTx::SettleTransition {
        data: CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("hanko".into())),
            (
                "settlementHash".into(),
                CanonicalValue::String(format!("0x{}", "11".repeat(32))),
            ),
            (
                "postProof".into(),
                CanonicalValue::Object(vec![(
                    "disputeHash".into(),
                    CanonicalValue::String(format!("0x{}", "22".repeat(32))),
                )]),
            ),
        ]),
    };
    let draft = SettlementHankoDraft {
        tx: unsigned.clone(),
        settlement_hash: Some([0x11; 32]),
        dispute_hash: [0x22; 32],
        settlement_nonce: 1,
        proof_nonce: 2,
    };
    left.account
        .admit_txs(vec![unsigned.clone()], "settlement-unsigned-test")
        .expect("pre-admit unsigned transition");
    let before = left.account.entity_account_leaf().expect("unsigned leaf");

    left.account
        .attach_certified_settlement_hanko(draft, Some(&[0x31, 0x32]), &[0x41, 0x42])
        .expect("attach certified witnesses");

    assert_eq!(left.account.mempool().len(), 1, "one canonical transition");
    assert_ne!(
        left.account.mempool()[0],
        unsigned,
        "witness bytes attached"
    );
    assert_eq!(
        canonical_tx_value(&left.account.mempool()[0]).expect("signed canonical tx"),
        canonical_tx_value(&unsigned).expect("unsigned canonical tx"),
    );
    assert_eq!(
        left.account.entity_account_leaf().expect("signed leaf"),
        before,
        "post-certification witness attachment must not move Account leaf",
    );
}
