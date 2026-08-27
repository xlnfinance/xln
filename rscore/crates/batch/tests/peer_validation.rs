//! Exact peer-envelope and hostile-certificate rejection coverage.

mod fixture;

use xln_rscore_batch::{AccountInputKind, AccountInputVerdict};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, CounterpartyDispute, DepositoryAddress, IncomingAck, Side,
    WatchSeed, dispute_proof_hash,
};

#[test]
fn envelope_sentinels_reject_without_root_or_revision_change() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 25)])
        .expect("admit");
    let proposals = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    let incoming = proposals[0].incoming().expect("incoming frame");
    let root = stand.payee.accounts_root();
    let revision = stand.payee.revision();

    let mut rows = Vec::new();
    for sentinel in 0..5 {
        let mut row = fixture::input_row(
            sentinel,
            pair.payee_account,
            pair.payer_entity,
            pair.payee_entity,
            AccountInputKind::Frame(Box::new(incoming.clone())),
        );
        match sentinel {
            0 => row.input.envelope.from_entity_id = [0x41; 32],
            1 => row.input.envelope.to_entity_id = [0x42; 32],
            2 => {
                row.input.envelope.domain = AccountDomain::new(
                    31_338,
                    DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                        .expect("depository"),
                )
                .expect("sentinel domain");
            }
            3 => {
                row.input.envelope.dispute_config =
                    AccountDisputeConfig::new(11, 10).expect("sentinel config");
            }
            4 => {
                row.input.envelope.watch_seed = Some(
                    WatchSeed::parse(&format!("0x{}", "aa".repeat(32)))
                        .expect("sentinel watch seed"),
                );
            }
            _ => unreachable!(),
        }
        rows.push(row);
    }

    let results = stand
        .payee
        .apply_inputs(fixture::clock(1_700_000_000_000), rows)
        .expect("sentinels are typed rejections");
    assert_eq!(results.len(), 5);
    assert!(matches!(results[0].verdict, AccountInputVerdict::Failed(_)));
    assert!(
        results[1..]
            .iter()
            .all(|row| matches!(row.verdict, AccountInputVerdict::FrameRejected { .. }))
    );
    assert_eq!(stand.payee.accounts_root(), root);
    assert_eq!(stand.payee.revision(), revision);
    assert_eq!(
        stand
            .payee
            .account(&pair.payee_account)
            .expect("account")
            .current_height(),
        0,
    );
}

#[test]
fn hostile_peer_certificates_are_rejected_without_root_or_revision_change() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    stand
        .payer
        .admit_txs(vec![fixture::payment(pair, 25)])
        .expect("admit");
    let proposals = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    let incoming = proposals[0].incoming().expect("incoming frame");
    let receiver = stand
        .payee
        .account(&pair.payee_account)
        .expect("receiver account");
    let identity = receiver.replica().state().identity();
    let proposer_is_left = receiver.replica().owner_side().opposite() == Side::Left;
    let proof_body_hash = [0x73; 32];
    let dispute_hash = dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.entity(Side::Left).as_bytes(),
        identity.entity(Side::Right).as_bytes(),
        1,
        proposer_is_left,
        &proof_body_hash,
        identity.watch_seed().bytes(),
    );

    let mut bad_frame_hanko = incoming.clone();
    bad_frame_hanko.frame_hanko = Some(vec![0]);
    let mut bad_dispute_hash = incoming.clone();
    bad_dispute_hash.dispute = Some(CounterpartyDispute {
        hanko: Some(vec![1]),
        hash: [0; 32],
        proof_body_hash,
        nonce: 1,
        proposer_is_left,
    });
    let mut bad_dispute_hanko = incoming.clone();
    bad_dispute_hanko.dispute = Some(CounterpartyDispute {
        hanko: Some(vec![0]),
        hash: dispute_hash,
        proof_body_hash,
        nonce: 1,
        proposer_is_left,
    });
    let receiver_root = stand.payee.accounts_root();
    let receiver_revision = stand.payee.revision();
    let results = stand
        .payee
        .apply_inputs(
            fixture::clock(1_700_000_000_000),
            vec![
                fixture::input_row(
                    0,
                    pair.payee_account,
                    pair.payer_entity,
                    pair.payee_entity,
                    AccountInputKind::Frame(Box::new(bad_frame_hanko)),
                ),
                fixture::input_row(
                    1,
                    pair.payee_account,
                    pair.payer_entity,
                    pair.payee_entity,
                    AccountInputKind::Frame(Box::new(bad_dispute_hash)),
                ),
                fixture::input_row(
                    2,
                    pair.payee_account,
                    pair.payer_entity,
                    pair.payee_entity,
                    AccountInputKind::Frame(Box::new(bad_dispute_hanko)),
                ),
            ],
        )
        .expect("hostile evidence remains typed peer traffic");
    assert!(matches!(
        &results[0].verdict,
        AccountInputVerdict::FrameRejected { reason }
            if reason.starts_with("ACCOUNT_PEER_FRAME_HANKO_INVALID")
    ));
    assert!(matches!(
        &results[1].verdict,
        AccountInputVerdict::FrameRejected { reason }
            if reason == "ACCOUNT_PEER_DISPUTE_HANKO_INVALID:HASH_MISMATCH"
    ));
    assert!(matches!(
        &results[2].verdict,
        AccountInputVerdict::FrameRejected { reason }
            if reason.starts_with("ACCOUNT_PEER_DISPUTE_HANKO_INVALID")
    ));
    assert_eq!(stand.payee.accounts_root(), receiver_root);
    assert_eq!(stand.payee.revision(), receiver_revision);

    let proposer_root = stand.payer.accounts_root();
    let proposer_revision = stand.payer.revision();
    let pending_hash = stand
        .payer
        .account(&pair.payer_account)
        .expect("proposer account")
        .pending()
        .expect("pending proposal")
        .state_hash;
    let bad_ack = fixture::input_row(
        0,
        pair.payer_account,
        pair.payee_entity,
        pair.payer_entity,
        AccountInputKind::Ack(IncomingAck {
            height: 1,
            frame_hash: pending_hash,
            frame_hanko: Some(vec![0]),
            dispute: None,
        }),
    );
    let result = stand
        .payer
        .apply_inputs(fixture::clock(1_700_000_000_000), vec![bad_ack])
        .expect("bad ACK is a typed rejection");
    assert!(matches!(
        &result[0].verdict,
        AccountInputVerdict::AckRejected { reason }
            if reason.starts_with("ACCOUNT_PEER_FRAME_HANKO_INVALID")
    ));
    assert_eq!(stand.payer.accounts_root(), proposer_root);
    assert_eq!(stand.payer.revision(), proposer_revision);
    assert_eq!(
        stand
            .payer
            .account(&pair.payer_account)
            .expect("proposer account")
            .pending()
            .expect("pending survives")
            .state_hash,
        pending_hash,
    );
}
