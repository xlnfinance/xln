mod common;

use xln_rscore_batch::{AccountSeed, BatchError, BatchVerdict, StatefulBatchEngine};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountOutput, AccountReplica, AccountState, AccountTx,
    ValidationRejection,
};

use common::{
    HTLC_HASHLOCK, HTLC_SECRET, account_id, delta_root, direct_job, full_seed, generation,
    htlc_lock_job, htlc_resolve_job, locks_root, seed, token, trusted_job,
};

const ACCOUNT_COUNT: u32 = 64;
const PAYMENT_JOBS_PER_ACCOUNT: u32 = 33;

fn engine(workers: usize) -> StatefulBatchEngine {
    let seeds = (0..ACCOUNT_COUNT).map(seed).collect();
    StatefulBatchEngine::new(generation(), workers, seeds).expect("batch engine")
}

#[test]
fn restore_starts_at_committed_revision_and_prepares_the_next_revision() {
    let mut restored = StatefulBatchEngine::restore(generation(), 2, 41, vec![seed(0)])
        .expect("restored batch engine");
    assert_eq!(restored.revision(), 41);
    let prepared = restored
        .prepare(&[direct_job(0, 0, 1)])
        .expect("restored prepare");
    assert_eq!(prepared.base_revision(), 41);
    assert_eq!(prepared.next_revision(), 42);
}

fn mixed_jobs() -> Vec<xln_rscore_batch::BatchJob> {
    let mut jobs = Vec::new();
    for round in 0..PAYMENT_JOBS_PER_ACCOUNT {
        for account in 0..ACCOUNT_COUNT {
            let index = jobs.len() as u32;
            let amount = if (round + account) % 19 == 0 { 0 } else { 1 };
            let job = if round % 2 == 0 {
                direct_job(index, account, amount)
            } else {
                trusted_job(index, account, amount)
            };
            jobs.push(job);
        }
    }
    for account in 0..ACCOUNT_COUNT {
        let lock_id = format!("parallel-lock-{account}");
        let index = jobs.len() as u32;
        jobs.push(htlc_lock_job(index, account, &lock_id));
        let index = jobs.len() as u32;
        jobs.push(htlc_resolve_job(index, account, &lock_id));
    }
    jobs
}

#[test]
fn one_and_twenty_workers_are_byte_order_equivalent() {
    let jobs = mixed_jobs();
    assert_eq!(jobs.len(), 2_240);
    let mut serial = engine(1);
    let mut parallel = engine(20);
    assert_eq!(serial.worker_count(), 1);
    assert_eq!(parallel.worker_count(), 20);
    let serial_prepared = serial.prepare(&jobs).expect("serial prepare");
    let parallel_prepared = parallel.prepare(&jobs).expect("parallel prepare");
    assert_eq!(serial_prepared.results(), parallel_prepared.results());
    assert_eq!(serial_prepared.outputs(), parallel_prepared.outputs());
    let serial_response = serial.commit(serial_prepared).expect("serial commit");
    let parallel_response = parallel.commit(parallel_prepared).expect("parallel commit");
    assert_eq!(serial_response, parallel_response);
    assert!(
        serial_response
            .results
            .windows(2)
            .all(|pair| pair[0].input_index < pair[1].input_index)
    );
    assert!(serial_response.outputs.windows(2).all(|pair| {
        (pair[0].input_index, pair[0].output_index) < (pair[1].input_index, pair[1].output_index)
    }));
    for account in 0..ACCOUNT_COUNT {
        assert_eq!(delta_root(&serial, account), delta_root(&parallel, account));
        assert_eq!(locks_root(&serial, account), locks_root(&parallel, account));
    }
}

fn spread_account_id(value: u32) -> xln_rscore_batch::AccountId {
    let mut bytes = [0_u8; 32];
    bytes[0] = value as u8;
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    xln_rscore_batch::AccountId::from_bytes(bytes)
}

fn spread_seed(value: u32) -> AccountSeed {
    AccountSeed {
        account_id: spread_account_id(value),
        ..seed(value)
    }
}

#[test]
fn twenty_workers_publish_a_wide_two_level_tree_identical_to_serial() {
    const WIDE_ACCOUNTS: u32 = 768;
    let seeds = (0..WIDE_ACCOUNTS).map(spread_seed).collect::<Vec<_>>();
    let jobs = (0..WIDE_ACCOUNTS)
        .map(|account| {
            let mut job = direct_job(account, account, 1);
            job.account_id = spread_account_id(account);
            job
        })
        .collect::<Vec<_>>();
    let mut serial = StatefulBatchEngine::new(generation(), 1, seeds.clone()).expect("serial");
    let mut parallel = StatefulBatchEngine::new(generation(), 20, seeds).expect("parallel");
    let serial_prepared = serial.prepare(&jobs).expect("serial prepare");
    let serial_response = serial.commit(serial_prepared).expect("serial commit");
    let parallel_prepared = parallel.prepare(&jobs).expect("parallel prepare");
    let parallel_response = parallel.commit(parallel_prepared).expect("parallel commit");
    assert_eq!(parallel_response, serial_response);
}

#[test]
fn prepare_is_private_until_commit_and_stale_candidates_do_not_publish() {
    let mut engine = engine(4);
    let base_root = delta_root(&engine, 0);
    let first = engine
        .prepare(&[direct_job(0, 0, 10)])
        .expect("first prepare");
    let stale = engine
        .prepare(&[direct_job(0, 0, 20)])
        .expect("stale prepare");
    assert_eq!(first.base_revision(), 0);
    assert_eq!(first.next_revision(), 1);
    assert_eq!(delta_root(&engine, 0), base_root);
    engine.commit(first).expect("first commit");
    let committed_root = delta_root(&engine, 0);
    assert_ne!(committed_root, base_root);
    assert_eq!(
        engine.commit(stale),
        Err(BatchError::StaleCandidate {
            actual: 0,
            expected: 1
        })
    );
    assert_eq!(delta_root(&engine, 0), committed_root);
}

#[test]
fn commit_rejects_different_payment_base_before_any_update() {
    let source_seeds = vec![seed(0), seed(1)];
    let mut source =
        StatefulBatchEngine::new(generation(), 2, source_seeds).expect("source engine");
    let prepared = source
        .prepare(&[direct_job(0, 0, 5), direct_job(1, 1, 7)])
        .expect("source prepare");

    let target_seeds = vec![seed(0), full_seed(1)];
    let mut target =
        StatefulBatchEngine::new(generation(), 2, target_seeds).expect("target engine");
    let first_root = delta_root(&target, 0);
    let second_root = delta_root(&target, 1);
    assert_eq!(
        target.commit(prepared),
        Err(BatchError::CandidateBaseMismatch(account_id(1)))
    );
    assert_eq!(target.revision(), 0);
    assert_eq!(delta_root(&target, 0), first_root);
    assert_eq!(delta_root(&target, 1), second_root);
}

#[test]
fn commit_rejects_different_replica_identity() {
    let mut source =
        StatefulBatchEngine::new(generation(), 1, vec![seed(0)]).expect("source engine");
    let prepared = source
        .prepare(&[direct_job(0, 0, 5)])
        .expect("source prepare");
    let foreign = seed(99);
    let target_seed = AccountSeed {
        account_id: account_id(0),
        replica: foreign.replica,
        consensus: None,
    };
    let mut target =
        StatefulBatchEngine::new(generation(), 1, vec![target_seed]).expect("target engine");
    let root = delta_root(&target, 0);
    assert_eq!(
        target.commit(prepared),
        Err(BatchError::CandidateBaseMismatch(account_id(0)))
    );
    assert_eq!(target.revision(), 0);
    assert_eq!(delta_root(&target, 0), root);
}

#[test]
fn commit_rejects_same_maps_with_different_dispute_config() {
    let mut source =
        StatefulBatchEngine::new(generation(), 1, vec![seed_with_dispute_config(0, 10, 10)])
            .expect("source engine");
    let prepared = source
        .prepare(&[direct_job(0, 0, 5)])
        .expect("source prepare");
    let mut target =
        StatefulBatchEngine::new(generation(), 1, vec![seed_with_dispute_config(0, 11, 10)])
            .expect("target engine");
    let root = delta_root(&target, 0);
    assert_eq!(
        target.commit(prepared),
        Err(BatchError::CandidateBaseMismatch(account_id(0)))
    );
    assert_eq!(delta_root(&target, 0), root);
}

#[test]
fn protocol_rejection_is_indexed_and_later_same_account_job_applies() {
    let mut engine = engine(2);
    let jobs = [direct_job(0, 0, 0), direct_job(1, 0, 7)];
    let prepared = engine.prepare(&jobs).expect("prepare rejection batch");
    assert!(matches!(
        &prepared.results()[0].verdict,
        BatchVerdict::Rejected(xln_rscore_engine::AccountRejection::Validation(
            ValidationRejection::PaymentAmount { .. }
        ))
    ));
    assert_eq!(prepared.results()[1].verdict, BatchVerdict::Applied);
    let response = engine.commit(prepared).expect("commit accepted suffix");
    assert_eq!(response.results.len(), 2);
    let delta = engine
        .account(&account_id(0))
        .expect("account")
        .state()
        .delta(token(1))
        .expect("delta");
    assert_eq!(delta.offdelta(), &7.into());
}

#[test]
fn unsupported_or_malformed_batches_fail_before_any_candidate_publish() {
    let mut engine = engine(2);
    let base = delta_root(&engine, 0);
    let mut unsupported = direct_job(1, 0, 1);
    // A tx the engine models but cannot execute yet — add_delta and
    // set_credit_limit are executable now, so they no longer prove this.
    unsupported.tx = AccountTx::ReserveToCollateral {
        token_id: token(1),
        collateral: "0".into(),
        ondelta: "0".into(),
        side: xln_rscore_engine::ReserveSide::Receiving,
        block_number: 1,
        transaction_hash: format!("0x{}", "ab".repeat(32)),
    };
    let jobs = [direct_job(0, 0, 1), unsupported];
    assert_eq!(
        prepare_error(&mut engine, &jobs),
        BatchError::UnsupportedTx {
            input_index: 1,
            tag: "reserve_to_collateral"
        }
    );
    assert_eq!(engine.revision(), 0);
    assert_eq!(delta_root(&engine, 0), base);

    let out_of_order = [direct_job(1, 0, 1)];
    assert_eq!(
        prepare_error(&mut engine, &out_of_order),
        BatchError::InputIndex {
            actual: 1,
            expected: 0
        }
    );
    let missing = [xln_rscore_batch::BatchJob {
        account_id: account_id(999),
        ..direct_job(0, 0, 1)
    }];
    assert_eq!(
        prepare_error(&mut engine, &missing),
        BatchError::AccountNotFound {
            input_index: 0,
            account_id: account_id(999),
        }
    );
    assert_eq!(delta_root(&engine, 0), base);
}

#[test]
fn parallel_infrastructure_failure_discards_every_account_candidate() {
    let seeds = vec![seed(0), full_seed(1)];
    let mut engine = StatefulBatchEngine::new(generation(), 2, seeds).expect("batch engine");
    let first_root = delta_root(&engine, 0);
    let second_root = delta_root(&engine, 1);
    let valid = direct_job(0, 0, 5);
    let mut fatal = direct_job(1, 1, 1);
    let AccountTx::DirectPayment { token_id, .. } = &mut fatal.tx else {
        panic!("direct-payment fixture changed")
    };
    *token_id = token(128);
    let error = prepare_error(&mut engine, &[valid, fatal]);
    assert!(matches!(
        error,
        BatchError::Transition {
            input_index: 1,
            source: xln_rscore_engine::TransitionError::InvalidState(_),
        }
    ));
    assert_eq!(engine.revision(), 0);
    assert_eq!(delta_root(&engine, 0), first_root);
    assert_eq!(delta_root(&engine, 1), second_root);
}

#[test]
fn same_account_htlc_lock_and_secret_resolve_are_sequential() {
    let mut engine = engine(20);
    let lock_id = "batch-same-account-lock";
    let jobs = [
        htlc_lock_job(0, 0, lock_id),
        htlc_resolve_job(1, 0, lock_id),
    ];
    let prepared = engine.prepare(&jobs).expect("prepare HTLC lifecycle");
    assert!(
        prepared
            .results()
            .iter()
            .all(|result| result.verdict == BatchVerdict::Applied)
    );
    assert_eq!(prepared.outputs().len(), 1);
    assert!(matches!(
        &prepared.outputs()[0].output,
        AccountOutput::HtlcSecret {
            lock_id: actual_lock,
            hashlock,
            secret,
            token_id,
            amount,
        } if actual_lock == lock_id
            && hashlock == HTLC_HASHLOCK
            && secret == HTLC_SECRET
            && *token_id == token(1)
            && amount == &3.into()
    ));
    assert!(
        engine
            .account(&account_id(0))
            .expect("committed account")
            .state()
            .htlc_lock(lock_id)
            .is_none()
    );
    engine.commit(prepared).expect("commit HTLC lifecycle");
    let account = engine.account(&account_id(0)).expect("committed account");
    assert!(account.state().htlc_lock(lock_id).is_none());
    assert_eq!(
        account.state().delta(token(1)).expect("delta").offdelta(),
        &3.into()
    );
}

fn prepare_error(
    engine: &mut StatefulBatchEngine,
    jobs: &[xln_rscore_batch::BatchJob],
) -> BatchError {
    match engine.prepare(jobs) {
        Ok(_) => panic!("expected batch preparation error"),
        Err(error) => error,
    }
}

fn seed_with_dispute_config(value: u32, left: u64, right: u64) -> AccountSeed {
    let original = seed(value);
    let owner = original.replica.owner().clone();
    let identity = original.replica.state().identity().clone();
    let delta = original
        .replica
        .state()
        .delta(token(1))
        .expect("seed delta")
        .clone();
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(left, right).expect("dispute config"),
        vec![delta],
    )
    .expect("account state");
    AccountSeed {
        account_id: account_id(value),
        replica: AccountReplica::new(owner, state).expect("account replica"),
        consensus: None,
    }
}
