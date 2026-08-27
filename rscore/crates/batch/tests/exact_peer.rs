//! Exact bilateral `frame_ack` ACK-before-proposal coverage.

mod fixture;

use num_bigint::BigInt;
use xln_rscore_batch::{AccountInputKind, AccountInputVerdict, BatchError, PeerBoardAuthority};
use xln_rscore_engine::{
    AccountTx, BoardHankoRefreshInput, CertifiedBoardAuthority, CounterpartyDispute, DeliveryMode,
    FrameAckPhase, IncomingAck, IncomingFrame, TokenId,
};
use xln_rscore_hanko::{
    BoardDelays, BoardMember, SemanticClaim, build_single_signer_hanko, hash_hanko_board_claim,
};

fn reverse_payment(pair: &fixture::Pair, amount: i64) -> AccountTx {
    AccountTx::DirectPayment {
        token_id: TokenId::new(1).expect("token"),
        amount: BigInt::from(amount),
        route: vec![pair.payer.to_string()],
        description: None,
        from_entity_id: pair.payee.to_string(),
        to_entity_id: pair.payer.to_string(),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

fn frame_ack_fixture() -> (fixture::Stand, IncomingAck, IncomingFrame) {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 25)])
        .expect("admit first frame");
    let first = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose first frame");
    let committed = stand
        .payee
        .apply_inputs(
            fixture::clock(1_700_000_000_000),
            fixture::frames_for(&stand, &first),
        )
        .expect("commit first frame on peer");
    let AccountInputVerdict::FrameCommitted {
        height,
        state_hash,
        ack_hanko,
        ..
    } = &committed[0].verdict
    else {
        panic!("expected first frame commit: {:?}", committed[0].verdict);
    };
    let ack = fixture::incoming_ack(*height, *state_hash, ack_hanko.clone());

    stand
        .payee
        .admit_txs(vec![(pair.payee_account, vec![reverse_payment(pair, 7)])])
        .expect("admit successor frame");
    let successor = stand
        .payee
        .propose_frames(1_700_000_000_001, 100, None)
        .expect("propose successor");
    let frame = successor[0]
        .incoming()
        .expect("successor proposal produced a frame");
    assert_eq!(frame.frame.height, 2);
    (stand, ack, frame)
}

#[test]
fn frame_ack_applies_as_one_ack_before_proposal_result() {
    let (mut stand, ack, frame) = frame_ack_fixture();
    let pair = &stand.pairs[0];
    let results = stand
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_001),
            vec![fixture::input_row(
                0,
                pair.payer_account,
                pair.payee_entity,
                pair.payer_entity,
                AccountInputKind::FrameAck {
                    ack,
                    frame: Box::new(frame),
                },
            )],
        )
        .expect("apply frame_ack");
    let AccountInputVerdict::FrameAckApplied { ack, frame } = &results[0].verdict else {
        panic!("expected atomic result: {:?}", results[0].verdict);
    };
    assert!(matches!(
        **ack,
        AccountInputVerdict::AckCommitted { height: 1, .. }
    ));
    assert!(matches!(
        **frame,
        AccountInputVerdict::FrameCommitted { height: 2, .. }
    ));
    assert_eq!(
        stand
            .payer
            .account(&pair.payer_account)
            .expect("account")
            .current_height(),
        2,
    );
}

#[test]
fn valid_ack_commits_when_the_bundled_frame_has_a_bad_previous_hash() {
    let (mut stand, ack, mut frame) = frame_ack_fixture();
    let pair = &stand.pairs[0];
    frame.frame.prev_frame_hash = format!("0x{}", "ff".repeat(32));
    frame.state_hash = frame.frame.hash().expect("tampered frame hash");
    frame.frame_hanko = Some(
        fixture::signing_identity("payee-0")
            .sign_frame(&frame.state_hash)
            .expect("tampered frame signature"),
    );
    let (mut expected, expected_ack, _) = frame_ack_fixture();
    let expected_pair = &expected.pairs[0];
    expected
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_001),
            vec![fixture::input_row(
                0,
                expected_pair.payer_account,
                expected_pair.payee_entity,
                expected_pair.payer_entity,
                AccountInputKind::Ack(expected_ack),
            )],
        )
        .expect("standalone canonical ACK");

    let results = stand
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_001),
            vec![fixture::input_row(
                0,
                pair.payer_account,
                pair.payee_entity,
                pair.payer_entity,
                AccountInputKind::FrameAck {
                    ack,
                    frame: Box::new(frame),
                },
            )],
        )
        .expect("bad proposal is a typed nested rejection");
    let AccountInputVerdict::FrameAckApplied { ack, frame } = &results[0].verdict else {
        panic!(
            "expected ACK-first composite result: {:?}",
            results[0].verdict
        );
    };
    assert!(matches!(
        **ack,
        AccountInputVerdict::AckCommitted { height: 1, .. }
    ));
    assert!(matches!(
        **frame,
        AccountInputVerdict::FrameRejected { ref reason }
            if reason.starts_with("ACCOUNT_PEER_FRAME_PREV_MISMATCH")
    ));
    assert_eq!(stand.payer.accounts_root(), expected.payer.accounts_root());
    assert_eq!(stand.payer.revision(), expected.payer.revision());
    let account = stand.payer.account(&pair.payer_account).expect("account");
    assert_eq!(account.current_height(), 1);
    assert!(account.pending().is_none());
}

#[test]
fn invalid_frame_ack_certificate_rejects_in_ack_phase_without_mutation() {
    let (mut stand, mut ack, frame) = frame_ack_fixture();
    let pair = &stand.pairs[0];
    ack.frame_hanko = Some(vec![0]);
    let root = stand.payer.accounts_root();
    let revision = stand.payer.revision();
    let pending_hash = stand
        .payer
        .account(&pair.payer_account)
        .expect("account")
        .pending()
        .expect("pending first frame")
        .state_hash;

    let results = stand
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_001),
            vec![fixture::input_row(
                0,
                pair.payer_account,
                pair.payee_entity,
                pair.payer_entity,
                AccountInputKind::FrameAck {
                    ack,
                    frame: Box::new(frame),
                },
            )],
        )
        .expect("invalid certificate is a typed phase rejection");
    assert!(matches!(
        &results[0].verdict,
        AccountInputVerdict::FrameAckRejected {
            phase: FrameAckPhase::Ack,
            reason,
        } if reason.starts_with("ACCOUNT_PEER_FRAME_HANKO_INVALID")
    ));
    assert_eq!(stand.payer.accounts_root(), root);
    assert_eq!(stand.payer.revision(), revision);
    let account = stand.payer.account(&pair.payer_account).expect("account");
    assert_eq!(account.current_height(), 0);
    assert_eq!(
        account.pending().expect("pending survives").state_hash,
        pending_hash,
    );
}

#[test]
fn registered_board_frame_commits_only_with_the_parent_certified_hash() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 25)])
        .expect("admit frame");
    let proposed = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose frame");
    let mut frame = proposed[0].incoming().expect("incoming frame");
    let key = fixture::signer_key("payer-0");
    let signer = fixture::signing_identity("payer-0")
        .signer_address()
        .expect("signer address");
    let mut signer_word = [0_u8; 32];
    signer_word[12..].copy_from_slice(&signer);
    frame.frame_hanko = Some(
        build_single_signer_hanko(
            &pair.payer_entity,
            &frame.state_hash,
            &key,
            2,
            2,
            BoardDelays::default(),
        )
        .expect("registered board hanko"),
    );
    let committed_hash = frame.state_hash;
    let board_hash = hash_hanko_board_claim(&SemanticClaim {
        entity_id: pair.payer_entity,
        threshold: 2,
        members: vec![BoardMember {
            entity_id: signer_word,
            weight: 2,
        }],
        delays: BoardDelays::default(),
    });
    let mut row = fixture::input_row(
        0,
        pair.payee_account,
        pair.payer_entity,
        pair.payee_entity,
        AccountInputKind::Frame(Box::new(frame)),
    );
    row.certified_board_authority =
        xln_rscore_batch::PeerBoardAuthority::Certified(CertifiedBoardAuthority {
            entity_id: pair.payer_entity,
            registered_board_hash: board_hash,
            previous_board_hash: [0_u8; 32],
            previous_board_valid_until: 0,
            activated_at_j_height: 1,
            activation_log_index: 0,
        });
    let result = stand
        .payee
        .apply_inputs(fixture::clock(1_700_000_000_000), vec![row])
        .expect("registered frame application");
    assert!(matches!(
        result[0].verdict,
        AccountInputVerdict::FrameCommitted { height: 1, .. }
    ));

    let rotated_key = [0x35_u8; 32];
    let rotated_signer =
        xln_rscore_engine::address_of_private_key(&rotated_key).expect("rotated signer address");
    let mut rotated_signer_word = [0_u8; 32];
    rotated_signer_word[12..].copy_from_slice(&rotated_signer);
    let rotated_board_hash = hash_hanko_board_claim(&SemanticClaim {
        entity_id: pair.payer_entity,
        threshold: 2,
        members: vec![BoardMember {
            entity_id: rotated_signer_word,
            weight: 2,
        }],
        delays: BoardDelays::default(),
    });
    let root_before_refresh = stand.payee.accounts_root();
    let mut refresh = fixture::input_row(
        1,
        pair.payee_account,
        pair.payer_entity,
        pair.payee_entity,
        AccountInputKind::BoardHankoRefresh(BoardHankoRefreshInput {
            height: 1,
            frame_hash: committed_hash,
            frame_hanko: Some(
                build_single_signer_hanko(
                    &pair.payer_entity,
                    &committed_hash,
                    &rotated_key,
                    2,
                    2,
                    BoardDelays::default(),
                )
                .expect("rotated frame hanko"),
            ),
            dispute: None,
            board_activation_j_height: 2,
            board_activation_log_index: 1,
        }),
    );
    refresh.certified_board_authority =
        xln_rscore_batch::PeerBoardAuthority::Certified(CertifiedBoardAuthority {
            entity_id: pair.payer_entity,
            registered_board_hash: rotated_board_hash,
            previous_board_hash: board_hash,
            previous_board_valid_until: 1_700_604_800,
            activated_at_j_height: 2,
            activation_log_index: 1,
        });
    let refreshed = stand
        .payee
        .apply_inputs(fixture::clock(1_700_000_000_001), vec![refresh])
        .expect("board refresh application");
    assert!(matches!(
        refreshed[0].verdict,
        AccountInputVerdict::BoardHankoRefreshApplied { .. }
    ));
    assert_ne!(root_before_refresh, stand.payee.accounts_root());

    let root_before_bad_dispute = stand.payee.accounts_root();
    let rejected = stand
        .payee
        .apply_inputs(
            fixture::clock(1_700_000_000_002),
            vec![fixture::input_row(
                2,
                pair.payee_account,
                pair.payer_entity,
                pair.payee_entity,
                AccountInputKind::Dispute(CounterpartyDispute {
                    hanko: Some(vec![0x01]),
                    hash: [0x71_u8; 32],
                    proof_body_hash: [0x72_u8; 32],
                    nonce: 1,
                    proposer_is_left: true,
                }),
            )],
        )
        .expect("bad standalone dispute is an isolated peer rejection");
    assert!(matches!(
        rejected[0].verdict,
        AccountInputVerdict::DisputeRejected { .. }
    ));
    assert_eq!(root_before_bad_dispute, stand.payee.accounts_root());
}

#[test]
fn unresolved_parent_board_authority_never_reaches_account_execution() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    let root = stand.payee.accounts_root();
    let mut row = fixture::input_row(
        0,
        pair.payee_account,
        pair.payer_entity,
        pair.payee_entity,
        AccountInputKind::Ack(IncomingAck {
            height: 1,
            frame_hash: [0x44_u8; 32],
            frame_hanko: Some(vec![0x01]),
            dispute: None,
        }),
    );
    row.certified_board_authority = PeerBoardAuthority::Unresolved;
    assert_eq!(
        stand
            .payee
            .apply_inputs(fixture::clock(1_700_000_000_000), vec![row])
            .expect_err("unresolved parent authority must fail loudly"),
        BatchError::BoardAuthorityUnresolved,
    );
    assert_eq!(stand.payee.accounts_root(), root);
}
