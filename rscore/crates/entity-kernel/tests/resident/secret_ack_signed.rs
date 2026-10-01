use super::*;

pub(super) fn signed_inbound_lock(
    hub: &EntityId,
    peer: &EntityId,
    entry: &PaybookEntry,
) -> AccountConsensus {
    let peer_label = (0..10)
        .map(|i| format!("ack-peer-{i}"))
        .find(|label| entity(&identity(label)) == *peer)
        .expect("fixture signer");
    let peer_identity = identity(&peer_label);
    let shared = account_state(hub, peer);
    let mut hub_replica = AccountReplica::new(hub.clone(), shared.clone()).unwrap();
    hub_replica.set_delta_transformer([0x77; 20]);
    let mut peer_replica = AccountReplica::new(peer.clone(), shared).unwrap();
    peer_replica.set_delta_transformer([0x77; 20]);
    let mut hub_account = AccountConsensus::new(hub_replica);
    let mut peer_account = AccountConsensus::new(peer_replica);
    peer_account
        .admit_txs(
            vec![AccountTx::HtlcLock(HtlcLockTx {
                lock_id: entry.hashlock.clone(),
                hashlock: HtlcHashlock::parse(&entry.hashlock).unwrap(),
                timelock: BigInt::from(DUE + 60_000),
                reveal_before_height: 1_000,
                amount: BigInt::from(100),
                token_id: TokenId::new(1).unwrap(),
                delivery_mode: None,
                envelope: None,
            })],
            "secret-ack-real-proof",
        )
        .unwrap();
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut peer_account,
        &peer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .unwrap() else {
        panic!("signed lock proposal required")
    };
    let draft = proposed.dispute.as_ref().expect("real dispute draft");
    let counter = CounterpartyDispute {
        hanko: Some(proposed.dispute_hanko.clone().expect("real dispute Hanko")),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    };
    let outcome = apply_incoming_frame(
        &mut hub_account,
        &identity("hub"),
        &AccountInputEnvelope {
            from_entity_id: *peer.as_bytes(),
            to_entity_id: *hub.as_bytes(),
            domain: domain(),
            dispute_config: AccountDisputeConfig::new(10, 10).unwrap(),
            watch_seed: Some(WatchSeed::parse(&format!("0x{}", "99".repeat(32))).unwrap()),
        },
        ReceiverClock {
            entity_timestamp: TIMESTAMP,
            finalized_j_height: 100,
        },
        IncomingFrame {
            frame: proposed.frame.clone(),
            state_hash: proposed.state_hash,
            frame_hanko: Some(proposed.hanko.clone()),
            dispute: Some(counter),
        },
        &support::market(),
        true,
    )
    .expect("verify real peer frame and dispute signatures");
    assert!(matches!(
        outcome,
        IncomingOutcome::Committed { height: 1, .. }
    ));
    hub_account
}
