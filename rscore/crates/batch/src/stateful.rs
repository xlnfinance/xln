use std::collections::BTreeMap;

use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use xln_rscore_engine::AccountReplica;
use xln_rscore_protocol::PersistentRadixMap;

use crate::execution::{AccountExecution, AccountWork, execute_account_caught, supported, tx_tag};
use crate::types::ReplicaFingerprint;
use crate::{
    AccountId, AccountSeed, BatchError, BatchJob, BatchResponse, CandidateId, EngineGeneration,
    PreparedBatch,
};

pub const MAX_BATCH_WORKERS: usize = 256;
const MAX_BATCH_JOBS: usize = 1_000_000;

pub struct StatefulBatchEngine {
    engine_generation: EngineGeneration,
    revision: u64,
    candidate_attempt: u64,
    pool: ThreadPool,
    account_shards: crate::parallel::AccountShardPlan,
    // The one canonical account store: a radix-16 Patricia tree keyed by the
    // 32-byte account id, replicas living in the leaves, leaf digest = the
    // Entity's own account leaf (the replica shell plus this account's
    // payment-profile state root). Values and the Merkle commitment
    // can never diverge because they are the same structure; `accounts_root()`
    // is the single 32-byte summary the entity machine consumes.
    accounts: PersistentRadixMap<AccountReplica>,
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
        let seeded = collect_accounts(seeds)?;
        let pool = ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .thread_name(|index| format!("rscore-account-{index}"))
            .build()
            .map_err(|error| BatchError::ThreadPoolBuild(error.to_string()))?;
        let account_shards = crate::parallel::AccountShardPlan::balanced(worker_count)?;
        let roots = pool.install(|| {
            seeded
                .par_iter()
                .map(|(account_id, replica)| leaf_root(*account_id, replica))
                .collect::<Result<Vec<_>, BatchError>>()
        })?;
        let mut accounts = PersistentRadixMap::empty();
        for ((account_id, replica), (_, root)) in seeded.into_iter().zip(roots) {
            accounts = put_account(&accounts, account_id, replica, root)?;
        }
        Ok(Self {
            engine_generation,
            revision,
            candidate_attempt: 0,
            pool,
            account_shards,
            accounts,
        })
    }

    pub fn worker_count(&self) -> usize {
        self.pool.current_num_threads()
    }

    /// 32-byte root of the accounts-level Patricia tree (radix 16, leaf = the
    /// Entity account leaf digest). This is the account module's
    /// whole-state commitment handed up to the entity machine.
    pub fn accounts_root(&self) -> [u8; 32] {
        self.accounts.root_hash()
    }

    /// (branch nodes, leaves, max branch depth) of the canonical account tree.
    pub fn accounts_tree_stats(&self) -> (usize, usize, usize) {
        self.accounts.node_stats()
    }

    /// Create or replace accounts between waves. The whole call is atomic:
    /// leaf digests are computed on the pool first, then the tree and the map
    /// swap together. Like every other mutation of the tree this advances the
    /// revision: a reader paging the accounts detects a tree that moved under
    /// it by exactly that number. The session layer refuses upserts while a
    /// prepare is pending, so a candidate can never straddle an upsert.
    pub fn upsert_accounts(&mut self, seeds: Vec<AccountSeed>) -> Result<[u8; 32], BatchError> {
        let incoming = collect_accounts(seeds)?;
        if incoming.is_empty() {
            return Err(BatchError::EmptyBatch);
        }
        let roots = self.pool.install(|| {
            incoming
                .par_iter()
                .map(|(account_id, replica)| leaf_root(*account_id, replica))
                .collect::<Result<Vec<_>, BatchError>>()
        })?;
        let mut accounts = self.accounts.clone();
        for ((account_id, replica), (_, root)) in incoming.into_iter().zip(roots) {
            accounts = put_account(&accounts, account_id, replica, root)?;
        }
        self.accounts = accounts;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Replace only the replica shells the authority re-projected, leaving the
    /// financial state each account reached by execution untouched. A reseed
    /// would overwrite that state with the authority's and hide a divergence;
    /// this cannot, which is why the shell has its own operation.
    pub fn update_shells(
        &mut self,
        shells: Vec<(AccountId, xln_rscore_engine::AccountEnvelope)>,
    ) -> Result<[u8; 32], BatchError> {
        if shells.is_empty() {
            return Err(BatchError::EmptyBatch);
        }
        let mut accounts = self.accounts.clone();
        for (account_id, envelope) in shells {
            let mut replica = accounts
                .get(account_id.as_bytes())
                .ok_or(BatchError::AccountNotFound {
                    input_index: 0,
                    account_id,
                })?
                .clone();
            replica.set_envelope(envelope);
            let root = leaf_root(account_id, &replica)?.1;
            accounts = put_account(&accounts, account_id, replica, root)?;
        }
        self.accounts = accounts;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Drop accounts the caller stopped mirroring. Without it an account the
    /// mirror abandons (state the engine cannot represent) would sit in the
    /// tree at its last known leaf and make the whole accounts root disagree
    /// forever.
    pub fn remove_accounts(&mut self, account_ids: &[AccountId]) -> Result<[u8; 32], BatchError> {
        if account_ids.is_empty() {
            return Err(BatchError::EmptyBatch);
        }
        let mut accounts = self.accounts.clone();
        for account_id in account_ids {
            accounts = accounts.removed(account_id.as_bytes()).map_err(|error| {
                BatchError::AccountsTree {
                    account_id: *account_id,
                    detail: error.to_string(),
                }
            })?;
        }
        self.accounts = accounts;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn account(&self, account_id: &AccountId) -> Option<&AccountReplica> {
        self.accounts.get(account_id.as_bytes())
    }

    pub(crate) fn pool(&self) -> &ThreadPool {
        &self.pool
    }

    /// Committed accounts in ascending id order, starting strictly after
    /// `cursor` (or from the first account when `cursor` is `None`).
    pub fn accounts_after(
        &self,
        cursor: Option<AccountId>,
    ) -> impl Iterator<Item = (AccountId, &AccountReplica)> {
        self.accounts
            .iter()
            .map(|(key, replica)| {
                let mut bytes = [0_u8; 32];
                bytes.copy_from_slice(key);
                (AccountId::from_bytes(bytes), replica)
            })
            .skip_while(move |(account_id, _)| cursor.is_some_and(|cursor| *account_id <= cursor))
    }

    pub fn prepare(&mut self, jobs: &[BatchJob]) -> Result<PreparedBatch, BatchError> {
        self.validate_jobs(jobs)?;
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(BatchError::RevisionOverflow)?;
        let work = self.group_work(jobs)?;
        let attempted = crate::parallel::map_owned(&self.pool, work, execute_account_caught);
        let completed = collect_executions(attempted)?;
        let attempt = self
            .candidate_attempt
            .checked_add(1)
            .ok_or(BatchError::CandidateAttemptOverflow)?;
        let candidate_id = CandidateId::derive(
            self.engine_generation,
            attempt,
            self.revision,
            self.accounts.root_hash(),
        );
        self.candidate_attempt = attempt;
        Ok(build_prepared(
            candidate_id,
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
        // Rebranch fully before publishing so a failed root computation leaves
        // the engine untouched (commit stays atomic). Leaf digests are
        // independent per account — compute them on the pool; only the cheap
        // path-copy fold below is sequential.
        let leaf_roots = crate::parallel::map_borrowed(
            &self.pool,
            &prepared.updates,
            |(account_id, _, candidate)| leaf_root(*account_id, candidate),
        )
        .into_iter()
        .collect::<Result<Vec<_>, BatchError>>()?;
        let entries = prepared
            .updates
            .into_iter()
            .zip(leaf_roots)
            .map(|((account_id, _, candidate), (_, root))| {
                (account_id.as_bytes().to_vec(), candidate, root)
            })
            .collect::<Vec<_>>();
        let accounts = self.put_accounts(entries)?;
        self.accounts = accounts;
        self.revision = prepared.next_revision;
        Ok(BatchResponse {
            committed_revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            results: prepared.results,
            outputs: prepared.outputs,
        })
    }

    /// Publish many account leaves at once, one core per top-level branch.
    ///
    /// Account ids are entity ids — uniformly distributed — so the sixteen
    /// subtrees under the root carry roughly equal work, and each one is
    /// rebuilt and hashed on its own core. Only the root branch is left for
    /// this thread.
    fn put_accounts(
        &self,
        entries: Vec<(Vec<u8>, AccountReplica, [u8; 32])>,
    ) -> Result<PersistentRadixMap<AccountReplica>, BatchError> {
        let result = if entries.len() >= crate::parallel::THREE_LEVEL_FANOUT_MIN {
            self.accounts.updated_batch_three_levels(entries, |slots| {
                crate::parallel::map_account_slots(&self.pool, &self.account_shards, slots)
            })
        } else if self.pool.current_num_threads() > 16
            && entries.len() >= crate::parallel::SECOND_LEVEL_FANOUT_MIN
        {
            self.accounts.updated_batch_two_levels(entries, |slots| {
                crate::parallel::map_slots(&self.pool, slots)
            })
        } else {
            self.accounts.updated_batch(entries, |slots| {
                crate::parallel::map_slots(&self.pool, slots)
            })
        };
        result.map_err(|error| BatchError::AccountsTree {
            account_id: AccountId::from_bytes([0; 32]),
            detail: error.to_string(),
        })
    }

    fn validate_update_bases(&self, prepared: &PreparedBatch) -> Result<(), BatchError> {
        for (account_id, expected, _) in &prepared.updates {
            let account = self
                .accounts
                .get(account_id.as_bytes())
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
            if self.accounts.get(job.account_id.as_bytes()).is_none() {
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
                let base = self.accounts.get(account_id.as_bytes()).ok_or(
                    BatchError::AccountNotFound {
                        input_index,
                        account_id,
                    },
                )?;
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
    candidate_id: CandidateId,
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
        candidate_id,
        engine_generation,
        base_revision,
        next_revision,
        updates,
        results,
        outputs,
    }
}

fn leaf_root(
    account_id: AccountId,
    replica: &AccountReplica,
) -> Result<(AccountId, [u8; 32]), BatchError> {
    replica
        .entity_account_leaf()
        .map(|root| (account_id, root))
        .map_err(|error| BatchError::AccountsTree {
            account_id,
            detail: error.to_string(),
        })
}

fn put_account(
    accounts: &PersistentRadixMap<AccountReplica>,
    account_id: AccountId,
    replica: AccountReplica,
    root: [u8; 32],
) -> Result<PersistentRadixMap<AccountReplica>, BatchError> {
    accounts
        .updated(account_id.as_bytes().to_vec(), replica, root)
        .map_err(
            |error: xln_rscore_protocol::PersistentRadixMapError| BatchError::AccountsTree {
                account_id,
                detail: error.to_string(),
            },
        )
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
