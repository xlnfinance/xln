use std::collections::BTreeMap;

use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use xln_rscore_engine::AccountReplica;

use crate::execution::{AccountExecution, AccountWork, execute_account_caught, supported, tx_tag};
use crate::types::ReplicaFingerprint;
use crate::{
    AccountId, AccountSeed, BatchError, BatchJob, BatchResponse, EngineGeneration, PreparedBatch,
};

pub const MAX_BATCH_WORKERS: usize = 256;
const MAX_BATCH_JOBS: usize = 1_000_000;

pub struct StatefulBatchEngine {
    engine_generation: EngineGeneration,
    revision: u64,
    pool: ThreadPool,
    accounts: BTreeMap<AccountId, AccountReplica>,
}

impl StatefulBatchEngine {
    pub fn new(
        engine_generation: EngineGeneration,
        worker_count: usize,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        Self::restore(engine_generation, worker_count, 0, seeds)
    }

    pub fn restore(
        engine_generation: EngineGeneration,
        worker_count: usize,
        revision: u64,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > MAX_BATCH_WORKERS {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        let accounts = collect_accounts(seeds)?;
        let pool = ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .thread_name(|index| format!("rscore-account-{index}"))
            .build()
            .map_err(|error| BatchError::ThreadPoolBuild(error.to_string()))?;
        Ok(Self {
            engine_generation,
            revision,
            pool,
            accounts,
        })
    }

    pub fn worker_count(&self) -> usize {
        self.pool.current_num_threads()
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn account(&self, account_id: &AccountId) -> Option<&AccountReplica> {
        self.accounts.get(account_id)
    }

    pub fn prepare(&self, jobs: &[BatchJob]) -> Result<PreparedBatch, BatchError> {
        self.validate_jobs(jobs)?;
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(BatchError::RevisionOverflow)?;
        let work = self.group_work(jobs)?;
        let attempted = self.pool.install(|| {
            work.into_par_iter()
                .map(execute_account_caught)
                .collect::<Vec<_>>()
        });
        let completed = collect_executions(attempted)?;
        Ok(build_prepared(
            self.engine_generation,
            self.revision,
            next_revision,
            completed,
        ))
    }

    pub fn commit(&mut self, prepared: PreparedBatch) -> Result<BatchResponse, BatchError> {
        if prepared.engine_generation != self.engine_generation {
            return Err(BatchError::EngineGenerationMismatch);
        }
        if prepared.base_revision != self.revision {
            return Err(BatchError::StaleCandidate {
                actual: prepared.base_revision,
                expected: self.revision,
            });
        }
        self.validate_update_bases(&prepared)?;
        for (account_id, _, candidate) in prepared.updates {
            self.accounts.insert(account_id, candidate);
        }
        self.revision = prepared.next_revision;
        Ok(BatchResponse {
            committed_revision: self.revision,
            results: prepared.results,
            outputs: prepared.outputs,
        })
    }

    fn validate_update_bases(&self, prepared: &PreparedBatch) -> Result<(), BatchError> {
        for (account_id, expected, _) in &prepared.updates {
            let account = self
                .accounts
                .get(account_id)
                .ok_or(BatchError::CandidateAccountNotFound(*account_id))?;
            let actual = replica_fingerprint(*account_id, account)?;
            if actual != *expected {
                return Err(BatchError::CandidateBaseMismatch(*account_id));
            }
        }
        Ok(())
    }

    fn validate_jobs(&self, jobs: &[BatchJob]) -> Result<(), BatchError> {
        if jobs.is_empty() {
            return Err(BatchError::EmptyBatch);
        }
        if jobs.len() > MAX_BATCH_JOBS {
            return Err(BatchError::BatchTooLarge {
                actual: jobs.len(),
                maximum: MAX_BATCH_JOBS,
            });
        }
        for (expected, job) in jobs.iter().enumerate() {
            let expected = u32::try_from(expected).map_err(|_| BatchError::BatchTooLarge {
                actual: jobs.len(),
                maximum: MAX_BATCH_JOBS,
            })?;
            if job.input_index != expected {
                return Err(BatchError::InputIndex {
                    actual: job.input_index,
                    expected,
                });
            }
            if !self.accounts.contains_key(&job.account_id) {
                return Err(BatchError::AccountNotFound {
                    input_index: job.input_index,
                    account_id: job.account_id,
                });
            }
            if !supported(&job.tx) {
                return Err(BatchError::UnsupportedTx {
                    input_index: job.input_index,
                    tag: tx_tag(&job.tx),
                });
            }
        }
        Ok(())
    }

    fn group_work<'a>(&'a self, jobs: &'a [BatchJob]) -> Result<Vec<AccountWork<'a>>, BatchError> {
        let mut grouped = BTreeMap::<AccountId, Vec<&BatchJob>>::new();
        for job in jobs {
            grouped.entry(job.account_id).or_default().push(job);
        }
        grouped
            .into_iter()
            .map(|(account_id, jobs)| {
                let input_index = jobs
                    .first()
                    .map(|job| job.input_index)
                    .ok_or(BatchError::EmptyBatch)?;
                let base = self
                    .accounts
                    .get(&account_id)
                    .ok_or(BatchError::AccountNotFound {
                        input_index,
                        account_id,
                    })?;
                Ok(AccountWork {
                    account_id,
                    base_fingerprint: replica_fingerprint(account_id, base)?,
                    base,
                    jobs,
                })
            })
            .collect()
    }
}

fn collect_accounts(
    seeds: Vec<AccountSeed>,
) -> Result<BTreeMap<AccountId, AccountReplica>, BatchError> {
    let mut accounts = BTreeMap::new();
    for seed in seeds {
        if accounts.insert(seed.account_id, seed.replica).is_some() {
            return Err(BatchError::DuplicateAccount(seed.account_id));
        }
    }
    Ok(accounts)
}

fn collect_executions(
    attempted: Vec<Result<AccountExecution, BatchError>>,
) -> Result<Vec<AccountExecution>, BatchError> {
    let mut completed = Vec::with_capacity(attempted.len());
    for result in attempted {
        completed.push(result?);
    }
    Ok(completed)
}

fn build_prepared(
    engine_generation: EngineGeneration,
    base_revision: u64,
    next_revision: u64,
    completed: Vec<AccountExecution>,
) -> PreparedBatch {
    let mut updates = Vec::new();
    let mut results = Vec::new();
    let mut outputs = Vec::new();
    for execution in completed {
        if let Some(candidate) = execution.candidate {
            updates.push((execution.account_id, execution.base_fingerprint, candidate));
        }
        results.extend(execution.results);
        outputs.extend(execution.outputs);
    }
    results.sort_unstable_by_key(|result| result.input_index);
    outputs.sort_unstable_by_key(|output| (output.input_index, output.output_index));
    PreparedBatch {
        engine_generation,
        base_revision,
        next_revision,
        updates,
        results,
        outputs,
    }
}

fn replica_fingerprint(
    account_id: AccountId,
    account: &AccountReplica,
) -> Result<ReplicaFingerprint, BatchError> {
    Ok(ReplicaFingerprint {
        owner: account.owner().clone(),
        owner_side: account.owner_side(),
        payment_profile_root: account
            .state()
            .payment_profile_account_state_root()
            .map_err(|source| BatchError::CandidateFingerprint { account_id, source })?,
    })
}
