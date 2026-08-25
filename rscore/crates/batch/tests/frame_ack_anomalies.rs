//! Adversarial TypeScript `frame_ack` behaviors awaiting an owner decision.

mod fixture;

use num_bigint::BigInt;
use xln_rscore_batch::{AccountInputKind, AccountInputVerdict};
use xln_rscore_engine::{AccountTx, DeliveryMode, IncomingAck, IncomingFrame, TokenId};

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
        panic!("expected first frame commit");
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
    let frame = successor[0].incoming().expect("successor frame");
    (stand, ack, frame)
}

#[test]
#[ignore = "pending owner decision: TS retargets a mismatched exact ACK height"]
fn pending_typescript_ack_target_override_is_isolated() {
    let (mut stand, mut ack, frame) = frame_ack_fixture();
    let pair = &stand.pairs[0];
    // `resolveAccountAckTarget` currently replaces this exact received height
    // with pendingHeight solely because the bundled proposal is P+1.
    ack.height = 99;
    let result = stand
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
        .expect("composite input");
    assert!(matches!(
        result[0].verdict,
        AccountInputVerdict::FrameAckApplied { .. }
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
#[ignore = "pending owner decision: TS duplicate proposal masks a moving ACK"]
fn pending_typescript_duplicate_proposal_short_circuit_is_isolated() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 25)])
        .expect("admit first");
    let first = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose first");
    let mut duplicate = first[0].incoming().expect("first frame");
    let committed = stand
        .payee
        .apply_inputs(
            fixture::clock(1_700_000_000_000),
            fixture::frames_for(&stand, &first),
        )
        .expect("commit first");
    let AccountInputVerdict::FrameCommitted {
        height,
        state_hash,
        ack_hanko,
        ..
    } = &committed[0].verdict
    else {
        panic!("expected first commit");
    };
    stand
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_000),
            vec![fixture::input_row(
                0,
                pair.payer_account,
                pair.payee_entity,
                pair.payer_entity,
                AccountInputKind::Ack(fixture::incoming_ack(
                    *height,
                    *state_hash,
                    ack_hanko.clone(),
                )),
            )],
        )
        .expect("commit first on proposer");
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 5)])
        .expect("admit second");
    stand
        .payer
        .propose_frames(1_700_000_000_001, 100, None)
        .expect("propose second");
    let pending_hash = stand
        .payer
        .account(&pair.payer_account)
        .expect("account")
        .pending()
        .expect("pending second")
        .state_hash;
    let moving_ack = IncomingAck {
        height: 2,
        frame_hash: pending_hash,
        frame_hanko: Some(
            fixture::signing_identity("payee-0")
                .sign_frame(&pending_hash)
                .expect("peer ACK"),
        ),
        dispute: None,
    };
    duplicate.frame_hanko = None;

    stand
        .payer
        .apply_inputs(
            fixture::clock(1_700_000_000_001),
            vec![fixture::input_row(
                0,
                pair.payer_account,
                pair.payee_entity,
                pair.payer_entity,
                AccountInputKind::FrameAck {
                    ack: moving_ack,
                    frame: Box::new(duplicate),
                },
            )],
        )
        .expect("composite input");
    // Current TypeScript replay returns the duplicate response before its ACK
    // phase, so the valid H2 ACK remains unapplied.
    let account = stand.payer.account(&pair.payer_account).expect("account");
    assert_eq!(account.current_height(), 1);
    assert_eq!(
        account.pending().expect("pending H2 remains").state_hash,
        pending_hash
    );
}
