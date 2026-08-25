//! The two visits one Entity frame makes to the Account layer.

mod fixture;

use fixture::stand;
use xln_rscore_batch::{
    AccountInputVerdict, EntityInboundRequest, EntityOutboundRequest, ReceiverClock,
};

const TIMESTAMP: u64 = 1_700_000_000_000;

fn clock() -> ReceiverClock {
    ReceiverClock {
        entity_timestamp: TIMESTAMP,
        finalized_j_height: 100,
    }
}

/// One Entity frame queues what its own logic decided, proposes, and the
/// counterparty applies the result — two calls each, not one per operation.
#[test]
fn two_visits_carry_a_whole_entity_frame() {
    let mut stand = stand(1);
    let payer_entity = stand.pairs[0].payer_entity;
    let payee_entity = stand.pairs[0].payee_entity;
    let payer_account = stand.pairs[0].payer_account;
    let payee_account = stand.pairs[0].payee_account;
    let (_, txs) = fixture::payment(&stand.pairs[0], 25);

    let outbound = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payer_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(payer_account, txs)],
            propose: vec![payer_account],
            post_accounts: true,
        })
        .expect("outbound");
    assert_eq!(outbound.admissions.len(), 1, "the queue took the payment");
    assert_eq!(outbound.proposals.len(), 1, "one account proposed");
    assert!(
        outbound.proposals[0].proposed.is_some(),
        "the proposal carries a signed frame"
    );
    assert_eq!(
        outbound.touched,
        vec![(payer_account, {
            let account = stand.payer.account(&payer_account).expect("account");
            account.entity_account_leaf().expect("leaf")
        })]
    );
    assert_eq!(outbound.post_accounts.len(), 1, "one body, once");

    let rows = fixture::frames_for(&stand, &outbound.proposals);
    let inbound = stand
        .payee
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: payee_entity,
            clock: clock(),
            rows,
            post_accounts: false,
        })
        .expect("inbound");
    assert_eq!(inbound.applied.len(), 1);
    assert_eq!(inbound.applied[0].account_id, payee_account);
    let AccountInputVerdict::FrameCommitted { events, .. } = &inbound.applied[0].verdict else {
        panic!(
            "expected a committed frame: {:?}",
            inbound.applied[0].verdict
        );
    };
    assert!(!events.is_empty(), "the frame says what it did");
    assert_eq!(inbound.touched.len(), 1, "the payee's account moved");
    assert!(
        inbound.post_accounts.is_empty(),
        "a caller that did not ask for bodies is not sent any"
    );
}

/// An account this Entity does not own is refused before anything executes.
#[test]
fn a_round_refuses_an_account_another_entity_owns() {
    let mut stand = stand(1);
    let payee_entity = stand.pairs[0].payee_entity;
    let payer_account = stand.pairs[0].payer_account;
    let refused = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payee_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: vec![payer_account],
            post_accounts: false,
        })
        .err()
        .expect("owner mismatch");
    assert!(
        refused.to_string().contains("WAVE_ACCOUNT_OWNER"),
        "named the owner mismatch: {refused}"
    );
}

/// A Runtime frame is one transaction: what its Entity inputs moved is undone
/// exactly if the frame never lands.
#[test]
fn an_aborted_runtime_frame_puts_every_account_back() {
    let mut stand = stand(1);
    let payer_entity = stand.pairs[0].payer_entity;
    let payer_account = stand.pairs[0].payer_account;
    let (_, txs) = fixture::payment(&stand.pairs[0], 25);

    let (_, before) = stand.payer.push_savepoint().expect("savepoint");
    stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payer_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(payer_account, txs)],
            propose: vec![payer_account],
            post_accounts: false,
        })
        .expect("outbound");
    assert_ne!(
        stand.payer.accounts_root(),
        before,
        "the frame moved the tree"
    );

    let (_, after) = stand.payer.undo_savepoint().expect("undo");
    assert_eq!(after, before, "an abandoned frame leaves nothing behind");
    assert!(
        stand.payer.keep_savepoint().is_err(),
        "there is nothing left to keep"
    );
}
