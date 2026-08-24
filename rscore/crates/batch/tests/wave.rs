//! One runtime frame as one call: admit, apply, propose — against a candidate
//! the runtime can still abort if its own record does not become durable.

mod fixture;

use fixture::{Stand, clock, payment, stand};
use xln_rscore_batch::{
    AccountInputKind, AccountInputRow, AccountInputVerdict, BatchError, WaveRequest, WaveResult,
};
use xln_rscore_engine::{AckOutcome, IncomingOutcome};

fn wave(stand: &Stand, timestamp: u64) -> WaveRequest {
    wave_amount(stand, timestamp, 25)
}

fn wave_amount(stand: &Stand, timestamp: u64, amount: i64) -> WaveRequest {
    WaveRequest {
        timestamp,
        j_height: 100,
        clock: clock(timestamp),
        admissions: stand
            .pairs
            .iter()
            .map(|pair| payment(pair, amount))
            .collect(),
        inputs: Vec::new(),
        propose: true,
    }
}

/// The wave does all three steps and reports what each produced.
#[test]
fn one_call_admits_applies_and_proposes() {
    let mut stand = stand(3);
    let request = wave(&stand, 1_700_000_000_000);
    let result = stand.payer.prepare_wave(request).expect("wave");
    assert_eq!(result.proposals.len(), 3);
    assert!(result.applied.is_empty());
    assert_eq!(result.accounts_root, stand.payer.accounts_root());
    assert!(stand.payer.wave_pending());

    let root = stand.payer.commit_wave(result.revision).expect("commit");
    assert_eq!(root, result.accounts_root);
    assert!(!stand.payer.wave_pending());
}

/// A runtime that could not make its own record durable takes the wave back,
/// and the engine is exactly where it was.
#[test]
fn an_aborted_wave_leaves_no_trace() {
    let mut stand = stand(3);
    let before_root = stand.payer.accounts_root();
    let before_revision = stand.payer.revision();

    let result = stand
        .payer
        .prepare_wave(wave(&stand, 1_700_000_000_000))
        .expect("wave");
    assert_ne!(result.accounts_root, before_root);

    let revision = stand.payer.abort_wave(result.revision).expect("abort");
    assert_eq!(revision, before_revision);
    assert_eq!(stand.payer.accounts_root(), before_root);
    assert!(!stand.payer.wave_pending());

    // And the same wave can be run again, reaching the same candidate.
    let again = stand
        .payer
        .prepare_wave(wave(&stand, 1_700_000_000_000))
        .expect("wave again");
    assert_eq!(again.accounts_root, result.accounts_root);
    assert_eq!(again.revision, result.revision);
}

/// Nothing else may touch the engine while a wave is uncommitted: a second
/// mutation could not be rolled back to the state the runtime agreed on.
#[test]
fn a_pending_wave_closes_every_other_door() {
    let mut stand = stand(2);
    let result = stand
        .payer
        .prepare_wave(wave(&stand, 1_700_000_000_000))
        .expect("wave");
    assert!(matches!(
        stand.payer.prepare_wave(wave(&stand, 1_700_000_000_001)),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.admit_txs(vec![payment(&stand.pairs[0], 5)]),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.propose_frames(1_700_000_000_002, 100, None),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes(),
        Err(BatchError::WavePending),
    ));
    // Only the revision that was prepared may be committed.
    assert!(matches!(
        stand.payer.commit_wave(result.revision - 1),
        Err(BatchError::WaveRevision { .. }),
    ));
    stand.payer.commit_wave(result.revision).expect("commit");
    assert!(matches!(
        stand.payer.commit_wave(result.revision),
        Err(BatchError::WaveMissing),
    ));
}

/// The full round trip between two engines, each driven by one wave per side:
/// the payer proposes, the payee applies and acks, the payer commits on the
/// ack — and the ack is where the effects come back.
#[test]
fn two_engines_settle_a_payment_in_three_waves() {
    let mut stand = stand(2);
    let timestamp = 1_700_000_000_000;
    let proposed = stand
        .payer
        .prepare_wave(wave(&stand, timestamp))
        .expect("propose wave");
    stand
        .payer
        .commit_wave(proposed.revision)
        .expect("commit propose");

    let frames = fixture::frames_for(&stand, &proposed.proposals);
    let applied: WaveResult = stand
        .payee
        .prepare_wave(WaveRequest {
            timestamp,
            j_height: 100,
            clock: clock(timestamp),
            admissions: Vec::new(),
            inputs: frames,
            propose: false,
        })
        .expect("apply wave");
    stand
        .payee
        .commit_wave(applied.revision)
        .expect("commit apply");
    assert_eq!(applied.applied.len(), 2);
    for row in &applied.applied {
        assert!(
            matches!(
                row.verdict,
                AccountInputVerdict::Frame(IncomingOutcome::Committed { .. })
            ),
            "{:?}",
            row.verdict,
        );
    }

    let acks = fixture::acks_for(&stand, &applied.applied);
    let acked = stand
        .payer
        .prepare_wave(WaveRequest {
            timestamp,
            j_height: 100,
            clock: clock(timestamp),
            admissions: Vec::new(),
            inputs: acks,
            propose: false,
        })
        .expect("ack wave");
    stand.payer.commit_wave(acked.revision).expect("commit ack");
    for row in &acked.applied {
        assert!(
            matches!(
                row.verdict,
                AccountInputVerdict::Ack(AckOutcome::Committed { .. })
            ),
            "{:?}",
            row.verdict,
        );
    }
    // The two engines key their accounts by the counterparty, so their trees
    // are different shapes. What must agree is the account itself: same
    // height, same financial root, on both sides of every pair.
    for pair in &stand.pairs {
        let payer = stand
            .payer
            .account(&pair.payer_account)
            .expect("payer view");
        let payee = stand
            .payee
            .account(&pair.payee_account)
            .expect("payee view");
        assert_eq!(payer.current_height(), 1);
        assert_eq!(payee.current_height(), 1);
        assert_eq!(
            payer
                .replica()
                .state()
                .payment_profile_account_state_root()
                .expect("payer root"),
            payee
                .replica()
                .state()
                .payment_profile_account_state_root()
                .expect("payee root"),
        );
    }
}

/// The market tables arrive with Hello and belong to the frame, not to the
/// account tree. An engine that never received them cannot propose a swap at
/// all — which is the check that catches a runtime that forgot to install
/// them, instead of a frame priced against an empty registry.
#[test]
fn the_market_from_hello_reaches_the_proposal() {
    let mut without = fixture::stand(1);
    without
        .payer
        .admit_txs(vec![fixture::swap_offer(&without.pairs[0])])
        .expect("admit");
    let Err(error) = without.payer.propose_frames(1_700_000_000_000, 100, None) else {
        panic!("an empty market cannot price an offer");
    };
    assert!(
        error.to_string().contains("SWAP_MARKET_POLICY_MISSING"),
        "{error}"
    );

    let mut with = fixture::stand_with_market(1, fixture::market());
    with.payer
        .admit_txs(vec![fixture::swap_offer(&with.pairs[0])])
        .expect("admit");
    let proposals = with
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    assert_eq!(proposals.len(), 1);
    let proposed = proposals[0].proposed.as_ref().expect("a frame");
    assert_eq!(proposed.frame.txs.len(), 1);
    assert!(proposals[0].dropped.is_empty());
}

/// A wave reports the accounts it moved, each with the leaf the Entity tree
/// would commit for it. The root says that two engines differ; these say
/// which account does.
#[test]
fn a_wave_reports_every_leaf_it_moved() {
    let mut stand = stand(2);
    let request = wave(&stand, 1_700_000_000_000);
    let first = stand.payer.prepare_wave(request).expect("wave");

    assert_eq!(first.touched.len(), 2);
    for (account_id, leaf) in &first.touched {
        let account = stand.payer.account(account_id).expect("account");
        assert_eq!(*leaf, account.entity_account_leaf().expect("leaf"));
    }
    assert!(
        first.touched.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "leaves are in account order, so the digest over them is stable"
    );

    // Aborting and re-running the same wave reaches the same tree.
    stand.payer.abort_wave(first.revision).expect("abort");
    let again = stand
        .payer
        .prepare_wave(wave(&stand, 1_700_000_000_000))
        .expect("wave");
    assert_eq!(again.accounts_root, first.accounts_root);
    assert_eq!(again.touched, first.touched);
}

/// A window where nothing survives still moves the account: the transactions
/// left the mempool, so the leaf changed. The attempt is reported with no
/// frame and with the rows it dropped — an engine that reported nothing here
/// would be silently ahead of the one it is compared against.
#[test]
fn a_window_that_proposes_nothing_still_reports_what_it_dropped() {
    let mut stand = stand(1);
    // More than the account can cover: rejected, and not the kind of rejection
    // that is retried, so the transaction leaves the mempool for good.
    stand
        .payer
        .admit_txs(vec![payment(&stand.pairs[0], 10_000_000_000)])
        .expect("admit");
    let before = stand.payer.accounts_root();

    let result = stand
        .payer
        .prepare_wave(WaveRequest {
            timestamp: 1_700_000_000_000,
            j_height: 100,
            clock: clock(1_700_000_000_000),
            admissions: Vec::new(),
            inputs: Vec::new(),
            propose: true,
        })
        .expect("wave");

    assert_eq!(result.proposals.len(), 1, "the attempt is reported");
    assert!(result.proposals[0].proposed.is_none(), "no frame survived");
    assert_eq!(result.proposals[0].dropped.len(), 1);
    let dropped = &result.proposals[0].dropped[0];
    assert_eq!(dropped.index, 0);
    assert_eq!(dropped.disposition, xln_rscore_engine::Disposition::Removed);
    assert!(!dropped.code.is_empty());
    assert_ne!(dropped.tx_digest, [0; 32]);

    // The account moved even though no frame did, and the wave says so.
    assert_ne!(result.accounts_root, before);
    assert_eq!(result.touched.len(), 1);
    assert_eq!(result.touched[0].0, stand.pairs[0].payer_account);
}

/// The driver pairs its own Nth raw input with the Nth verdict. Indices that
/// repeat or skip would still line up somewhere, and the comparison would
/// report agreement about the wrong input.
#[test]
fn input_indices_must_be_unique_and_sequential() {
    let mut stand = stand(1);
    let pair = &stand.pairs[0];
    let row = |input_index: u32| AccountInputRow {
        input_index,
        account_id: pair.payer_account,
        from_entity_id: pair.payee_entity,
        kind: AccountInputKind::Ack {
            height: 1,
            state_hash: [0; 32],
            hanko: Vec::new(),
        },
    };

    let duplicate = stand
        .payer
        .apply_inputs(clock(1_700_000_000_000), vec![row(0), row(0)]);
    assert!(
        matches!(
            duplicate,
            Err(BatchError::InputIndex {
                actual: 0,
                expected: 1
            })
        ),
        "{duplicate:?}"
    );

    let gap = stand
        .payer
        .apply_inputs(clock(1_700_000_000_000), vec![row(0), row(2)]);
    assert!(
        matches!(
            gap,
            Err(BatchError::InputIndex {
                actual: 2,
                expected: 1
            })
        ),
        "{gap:?}"
    );
}
