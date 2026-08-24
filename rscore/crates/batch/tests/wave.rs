//! One runtime frame as one call: admit, apply, propose — against a candidate
//! the runtime can still abort if its own record does not become durable.

mod fixture;

use fixture::{Stand, clock, payment, stand};
use xln_rscore_batch::{AccountInputVerdict, BatchError, WaveRequest, WaveResult};
use xln_rscore_engine::{AckOutcome, IncomingOutcome};

fn wave(stand: &Stand, timestamp: u64) -> WaveRequest {
    WaveRequest {
        timestamp,
        j_height: 100,
        clock: clock(timestamp),
        admissions: stand.pairs.iter().map(|pair| payment(pair, 25)).collect(),
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
