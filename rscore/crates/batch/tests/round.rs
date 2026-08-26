//! The two visits one Entity frame makes to the Account layer.

mod fixture;

use fixture::stand;
use xln_rscore_batch::{
    AccountInputVerdict, EntityInboundRequest, EntityOutboundRequest, FailedHtlcRoute,
    ReceiverClock,
};

const TIMESTAMP: u64 = 1_700_000_000_000;

fn clock() -> ReceiverClock {
    ReceiverClock {
        entity_timestamp: TIMESTAMP,
        finalized_j_height: 100,
    }
}

fn enter(engine: &mut xln_rscore_batch::StatefulConsensusEngine, owner_entity_id: [u8; 32]) {
    let expected_accounts_root = engine.accounts_root();
    engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id,
            expected_accounts_root,
            clock: clock(),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("inbound half");
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

    enter(&mut stand.payer, payer_entity);
    let outbound = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payer_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(payer_account, txs)],
            propose: vec![payer_account],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
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
    let expected_accounts_root = stand.payee.accounts_root();
    let inbound = stand
        .payee
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: payee_entity,
            expected_accounts_root,
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
    let payee_final = stand
        .payee
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payee_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: vec![payee_account],
            failed_htlc_routes: Vec::new(),
            post_accounts: true,
        })
        .expect("outbound half");
    assert_eq!(payee_final.post_accounts.len(), 1);
    assert_eq!(payee_final.post_accounts[0].account_id, payee_account);
    assert!(
        payee_final.post_accounts[0].put_count() > 0,
        "the outbound diff spans the inbound mutation, not merely outbound work"
    );
}

#[test]
fn the_next_parent_root_promotes_or_drops_the_path_copy_candidate() {
    let mut accepted = stand(1);
    let owner = accepted.pairs[0].payer_entity;
    let account = accepted.pairs[0].payer_account;
    let (_, txs) = fixture::payment(&accepted.pairs[0], 25);
    let base_root = accepted.payer.accounts_root();
    enter(&mut accepted.payer, owner);
    accepted
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: owner,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(account, txs)],
            propose: vec![account],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .expect("candidate");
    let candidate_root = accepted.payer.accounts_root();
    assert_ne!(candidate_root, base_root);
    accepted
        .payer
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: owner,
            expected_accounts_root: candidate_root,
            clock: clock(),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("the parent accepted the candidate root");
    assert_eq!(accepted.payer.accounts_root(), candidate_root);

    let mut rejected = stand(1);
    let owner = rejected.pairs[0].payer_entity;
    let account = rejected.pairs[0].payer_account;
    let (_, txs) = fixture::payment(&rejected.pairs[0], 25);
    let base_root = rejected.payer.accounts_root();
    enter(&mut rejected.payer, owner);
    rejected
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: owner,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(account, txs)],
            propose: vec![account],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .expect("candidate");
    assert_ne!(rejected.payer.accounts_root(), base_root);
    rejected
        .payer
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: owner,
            expected_accounts_root: base_root,
            clock: clock(),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("the parent retained the base root");
    assert_eq!(rejected.payer.accounts_root(), base_root);
}

#[test]
fn the_two_visit_protocol_refuses_missing_or_overlapping_halves() {
    let mut stand = stand(1);
    let payer_entity = stand.pairs[0].payer_entity;

    let missing = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payer_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .err()
        .expect("outbound without inbound");
    assert!(missing.to_string().contains("ENTITY_ROUND_MISSING"));

    enter(&mut stand.payer, payer_entity);
    let wrong_head = [0x7a; 32];
    let overlapping = stand
        .payer
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: payer_entity,
            expected_accounts_root: wrong_head,
            clock: clock(),
            rows: Vec::new(),
            post_accounts: false,
        })
        .err()
        .expect("second inbound while the first is open");
    assert!(overlapping.to_string().contains("ENTITY_HEAD_ROOT"));
}

/// An account this Entity does not own is refused before anything executes.
#[test]
fn a_round_refuses_an_account_another_entity_owns() {
    let mut stand = stand(1);
    let payee_entity = stand.pairs[0].payee_entity;
    let payer_entity = stand.pairs[0].payer_entity;
    let payer_account = stand.pairs[0].payer_account;
    enter(&mut stand.payer, payer_entity);
    let refused = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payee_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: vec![payer_account],
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .err()
        .expect("owner mismatch");
    assert!(
        refused.to_string().contains("WAVE_ACCOUNT_OWNER"),
        "named the owner mismatch: {refused}"
    );
    stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: payer_entity,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .expect("a rejected outbound does not consume the inbound half");
}

/// A downstream rejection is resolved upstream inside the same outbound
/// visit. The parent later consumes these precomputed rows while running its
/// canonical worklist; no third process request exists.
#[test]
fn a_failed_forward_reaches_the_upstream_account_in_one_outbound_visit() {
    use num_bigint::BigInt;
    use xln_rscore_batch::{AccountId, AccountSeed};
    use xln_rscore_engine::{AccountReplica, AccountTx, HtlcHashlock, HtlcLockTx, TokenId};

    let mut stand = stand(1);
    let owner = stand.pairs[0].payer_entity;
    let downstream_account = stand.pairs[0].payer_account;
    let payer = stand.pairs[0].payer.clone();
    let (upstream_bytes, upstream_peer) = fixture::entity_of("upstream-peer");
    let (left, right) = if payer.to_string() < upstream_peer.to_string() {
        (payer.clone(), upstream_peer)
    } else {
        (upstream_peer, payer.clone())
    };
    let upstream_account = AccountId::from_bytes(upstream_bytes);
    stand
        .payer
        .upsert_accounts(vec![AccountSeed {
            account_id: upstream_account,
            replica: AccountReplica::new(payer, fixture::account_state(&left, &right))
                .expect("upstream replica"),
            consensus: None,
        }])
        .expect("second account owned by the same Entity");
    let hashlock = HtlcHashlock::parse(&format!("0x{}", "5a".repeat(32))).expect("hashlock");
    let downstream_lock_id = format!("0x{}", "4b".repeat(32));
    let upstream_lock_id = format!("0x{}", "3c".repeat(32));
    enter(&mut stand.payer, owner);

    let result = stand
        .payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: owner,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            admits: vec![(
                downstream_account,
                vec![AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: downstream_lock_id.clone(),
                    hashlock: hashlock.clone(),
                    timelock: BigInt::from(TIMESTAMP - 1),
                    reveal_before_height: 200,
                    amount: BigInt::from(10),
                    token_id: TokenId::new(1).expect("token"),
                    delivery_mode: None,
                    envelope: None,
                })],
            )],
            propose: vec![downstream_account],
            materialize: Vec::new(),
            failed_htlc_routes: vec![FailedHtlcRoute {
                hashlock: *hashlock.bytes(),
                outbound_account_id: downstream_account,
                outbound_lock_id: downstream_lock_id,
                inbound_account_id: upstream_account,
                inbound_lock_id: upstream_lock_id.clone(),
            }],
            post_accounts: true,
        })
        .expect("one outbound visit reaches fixed point");

    assert_eq!(
        result.admissions.len(),
        2,
        "original lock plus generated resolve"
    );
    assert_eq!(result.admissions[1].account_id, upstream_account);
    assert_eq!(
        result.proposals.len(),
        2,
        "generated account joins the worklist"
    );
    assert_eq!(result.proposals[0].account_id, downstream_account);
    assert_eq!(result.proposals[1].account_id, upstream_account);
    let failed = &result.proposals[0].failed_htlc_locks[0];
    assert_eq!(failed.lock_id, format!("0x{}", "4b".repeat(32)));
    let resolution = failed
        .upstream_resolution
        .as_ref()
        .expect("failure carries its exact upstream admission");
    assert_eq!(resolution.account_id, upstream_account);
    assert_eq!(resolution.lock_id, upstream_lock_id);
    assert_eq!(
        resolution.reason,
        "forward_failed:Timelock 1699999999999 already expired (timestamp)",
    );
    assert!(
        result
            .post_accounts
            .iter()
            .any(|row| row.account_id == upstream_account),
        "the parent receives the generated account's final body",
    );
}
