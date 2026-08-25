//! Exact bilateral `frame_ack` atomicity coverage.

mod fixture;

use num_bigint::BigInt;
use xln_rscore_batch::{AccountInputKind, AccountInputVerdict};
use xln_rscore_engine::{
    AccountTx, DeliveryMode, Delta, FrameAckPhase, IncomingAck, IncomingFrame, TokenId,
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
fn invalid_frame_ack_rolls_back_ack_root_and_revision() {
    let (mut stand, ack, mut frame) = frame_ack_fixture();
    let pair = &stand.pairs[0];
    frame.frame.deltas[0] = Delta::zero(TokenId::new(1).expect("token"));
    frame.state_hash = frame.frame.hash().expect("tampered frame hash");
    frame.frame_hanko = Some(
        fixture::signing_identity("payee-0")
            .sign_frame(&frame.state_hash)
            .expect("tampered frame signature"),
    );
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
        .expect("invalid frame_ack is a typed rejection");
    assert!(matches!(
        &results[0].verdict,
        AccountInputVerdict::FrameAckRejected {
            phase: FrameAckPhase::Frame,
            reason,
        } if reason == "ACCOUNT_PEER_FRAME_DELTAS_MISMATCH"
    ));
    assert_eq!(stand.payer.accounts_root(), root);
    assert_eq!(stand.payer.revision(), revision);
    let account = stand.payer.account(&pair.payer_account).expect("account");
    assert_eq!(account.current_height(), 0);
    assert_eq!(
        account
            .pending()
            .expect("ACK commit rolled back")
            .state_hash,
        pending_hash,
    );
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
