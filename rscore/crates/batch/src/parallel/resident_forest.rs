//! Resident, worker-owned Account Patricia subtrees.
//!
//! The coordinator owns only the compact three-level commitment above 4096
//! logical shards. Every value and every node below that boundary is moved into
//! one permanent actor thread during restore and stays there. A phase sends one
//! typed batch to each active worker and receives ordinary results plus the
//! value-free descriptors of shards that changed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(test)]
use xln_rscore_protocol::PersistentRadixOverlayWork;
use xln_rscore_protocol::{
    PERSISTENT_RADIX_SHARD_COUNT, PersistentRadixMapError, PersistentRadixShard,
    PersistentRadixShardCoordinator, PersistentRadixShardDescriptor, PersistentRadixShardOverlay,
};

use super::{AccountShardPlan, ResidentWorkerPool, logical_account_shard};
use crate::{AccountId, BatchError};

#[derive(Clone)]
struct ResidentLogicalShard<V> {
    base: PersistentRadixShard<V>,
    inbound: Option<PersistentRadixShard<V>>,
    candidate: Option<PersistentRadixShard<V>>,
    checkpoint: PersistentRadixShard<V>,
}

struct ResidentWorkerState<V> {
    shards: BTreeMap<usize, ResidentLogicalShard<V>>,
    rollback: Option<ResidentWorkerRollback<V>>,
    checkpoint_dirty: BTreeSet<AccountId>,
}

struct ResidentWorkerRollback<V> {
    phase: u64,
    shards: BTreeMap<usize, ResidentLogicalShard<V>>,
    checkpoint_dirty: BTreeSet<AccountId>,
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
struct ResidentShardSnapshot {
    index: usize,
    base: PersistentRadixShardDescriptor,
    inbound: Option<PersistentRadixShardDescriptor>,
    candidate: Option<PersistentRadixShardDescriptor>,
}

struct ShardSeedBatch<V> {
    shard: usize,
    entries: Vec<(AccountId, V, [u8; 32])>,
}

struct ShardMutationBatch<T> {
    shard: usize,
    entries: Vec<(AccountId, T)>,
}

struct WorkerMutationBatch<T> {
    phase: u64,
    mode: WorkerPhase,
    reconcile: Vec<usize>,
    shards: Vec<ShardMutationBatch<T>>,
    control: Arc<PhaseControl>,
    allow_change: bool,
}

struct WorkerMutationReply<R> {
    rows: Vec<(AccountId, R)>,
    changed: Vec<AccountId>,
    descriptors: Vec<PersistentRadixShardDescriptor>,
    metrics: Vec<ShardPhaseMetric>,
}

struct ShardPhaseMetric {
    shard: usize,
    items: usize,
    work_elapsed: Duration,
    fold_leaves: usize,
    fold_elapsed: Duration,
}

struct PhaseControl {
    barrier: Barrier,
    failed: AtomicBool,
}

impl PhaseControl {
    fn new(active_workers: usize) -> Self {
        Self {
            barrier: Barrier::new(active_workers.max(1)),
            failed: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Copy)]
enum WorkerPhase {
    Inbound {
        head: ReconcileHead,
        checkpoint_ack: bool,
    },
    OutboundReset,
    OutboundContinue,
}

#[derive(Clone, Copy)]
enum ReconcileHead {
    Base,
    Candidate,
}

#[derive(Clone, Copy)]
struct PendingCheckpoint {
    revision: u64,
    accounts_root: [u8; 32],
}

/// The only choices an Account operation can make about its resident value.
pub(crate) enum ResidentAccountAction<V, R> {
    Keep(R),
    Put {
        value: V,
        value_digest: [u8; 32],
        result: R,
    },
}

#[derive(Debug)]
pub(crate) struct ResidentAccountBatch<R> {
    pub(crate) revision: u64,
    pub(crate) accounts_root: [u8; 32],
    pub(crate) rows: Vec<(AccountId, R)>,
}

#[derive(Debug)]
pub(crate) struct ResidentCheckpointBatch<R> {
    pub(crate) base_revision: u64,
    pub(crate) revision: u64,
    pub(crate) accounts_root: [u8; 32],
    pub(crate) rows: Vec<(AccountId, R)>,
    pub(crate) removed: Vec<AccountId>,
}

/// A single coordinator with permanently resident worker-owned subtrees.
pub(crate) struct ResidentAccountForest<V> {
    workers: ResidentWorkerPool<ResidentWorkerState<V>>,
    plan: AccountShardPlan,
    base_top: PersistentRadixShardCoordinator,
    inbound_top: Option<PersistentRadixShardOverlay>,
    candidate_top: Option<PersistentRadixShardOverlay>,
    base_revision: u64,
    inbound_revision: Option<u64>,
    candidate_revision: Option<u64>,
    inbound_shards: BTreeSet<usize>,
    candidate_shards: BTreeSet<usize>,
    checkpoint_workers: BTreeSet<usize>,
    checkpoint_revision: u64,
    pending_checkpoint: Option<PendingCheckpoint>,
    phase: u64,
}

impl<V: Clone + Send + Sync + 'static> ResidentAccountForest<V> {
    pub(crate) fn restore(
        worker_count: usize,
        revision: u64,
        entries: Vec<(AccountId, V, [u8; 32])>,
    ) -> Result<Self, BatchError> {
        Self::restore_with_checkpoint(worker_count, revision, entries, false)
    }

    pub(crate) fn import_existing(
        worker_count: usize,
        entries: Vec<(AccountId, V, [u8; 32])>,
    ) -> Result<Self, BatchError> {
        Self::restore_with_checkpoint(worker_count, 0, entries, true)
    }

    fn restore_with_checkpoint(
        worker_count: usize,
        revision: u64,
        entries: Vec<(AccountId, V, [u8; 32])>,
        import_existing: bool,
    ) -> Result<Self, BatchError> {
        let mut shard_weights = vec![0_u64; PERSISTENT_RADIX_SHARD_COUNT];
        for (account_id, _, _) in &entries {
            let shard = logical_account_shard(*account_id);
            shard_weights[shard] =
                shard_weights[shard]
                    .checked_add(1)
                    .ok_or_else(|| BatchError::AccountsTree {
                        account_id: *account_id,
                        detail: "ACCOUNT_SHARD_WEIGHT_OVERFLOW".to_string(),
                    })?;
        }
        let plan = AccountShardPlan::weighted(worker_count, &shard_weights)?;
        let mut states = (0..worker_count)
            .map(|_| ResidentWorkerState {
                shards: BTreeMap::new(),
                rollback: None,
                checkpoint_dirty: BTreeSet::new(),
            })
            .collect::<Vec<_>>();
        let mut descriptors = Vec::with_capacity(PERSISTENT_RADIX_SHARD_COUNT);
        for shard in 0..PERSISTENT_RADIX_SHARD_COUNT {
            let state = PersistentRadixShard::empty(shard)
                .map_err(|error| forest_error(AccountId::from_bytes([0; 32]), error))?;
            descriptors.push(state.descriptor());
            states[plan.worker(shard)].shards.insert(
                shard,
                ResidentLogicalShard {
                    base: state.clone(),
                    inbound: None,
                    candidate: None,
                    checkpoint: state,
                },
            );
        }
        let mut workers = ResidentWorkerPool::start("rscore-account-resident", states)?;

        let mut seen = BTreeSet::new();
        let mut buckets = BTreeMap::<usize, Vec<(AccountId, V, [u8; 32])>>::new();
        for (account_id, value, digest) in entries {
            if !seen.insert(account_id) {
                return Err(BatchError::DuplicateAccount(account_id));
            }
            buckets
                .entry(logical_account_shard(account_id))
                .or_default()
                .push((account_id, value, digest));
        }
        let mut lanes = empty_lanes(worker_count);
        for (shard, entries) in buckets {
            lanes[plan.worker(shard)].push(ShardSeedBatch { shard, entries });
        }
        let seeded = workers.run_lanes(lanes, move |state, batch| {
            if import_existing {
                state
                    .checkpoint_dirty
                    .extend(batch.entries.iter().map(|(account_id, _, _)| *account_id));
            }
            let resident = resident_shard_mut(state, batch.shard)?;
            let entries = batch
                .entries
                .into_iter()
                .map(|(account_id, value, digest)| (account_id.as_bytes().to_vec(), value, digest))
                .collect();
            resident.base = resident
                .base
                .updated_batch(entries)
                .map_err(|error| forest_error(zero_account(), error))?;
            if !import_existing {
                resident.checkpoint = resident.base.clone();
            }
            Ok::<_, BatchError>(resident.base.descriptor())
        })?;
        for descriptor in seeded.into_iter().flatten() {
            let descriptor = descriptor?;
            let index = descriptor.index();
            descriptors[index] = descriptor;
        }
        let top = PersistentRadixShardCoordinator::from_descriptors(descriptors)
            .map_err(|error| forest_error(AccountId::from_bytes([0; 32]), error))?;
        let checkpoint_workers = if import_existing {
            seen.iter()
                .map(|account_id| plan.worker(logical_account_shard(*account_id)))
                .collect()
        } else {
            BTreeSet::new()
        };
        Ok(Self {
            workers,
            plan,
            base_top: top,
            inbound_top: None,
            candidate_top: None,
            base_revision: revision,
            inbound_revision: None,
            candidate_revision: None,
            inbound_shards: BTreeSet::new(),
            candidate_shards: BTreeSet::new(),
            checkpoint_workers,
            checkpoint_revision: revision,
            pending_checkpoint: None,
            phase: 0,
        })
    }

    pub(crate) fn worker_count(&self) -> usize {
        self.workers.worker_count()
    }

    pub(crate) fn len(&self) -> usize {
        self.candidate_top
            .as_ref()
            .or(self.inbound_top.as_ref())
            .map_or(self.base_top.len(), PersistentRadixShardOverlay::len)
    }

    pub(crate) fn accounts_root(&self) -> [u8; 32] {
        self.candidate_top
            .as_ref()
            .or(self.inbound_top.as_ref())
            .map_or(
                self.base_top.root_hash(),
                PersistentRadixShardOverlay::root_hash,
            )
    }

    pub(crate) fn revision(&self) -> u64 {
        self.active_revision()
    }

    pub(crate) fn metrics(&self) -> Vec<super::AccountShardMetric> {
        self.plan.metrics()
    }

    pub(crate) fn expected_uses_candidate(
        &self,
        expected_root: [u8; 32],
    ) -> Result<bool, BatchError> {
        Ok(matches!(
            self.reconcile_head(expected_root)?.0,
            ReconcileHead::Candidate
        ))
    }

    /// Reconcile the prior parent head, then apply all inbound Account inputs
    /// in exactly one worker join. A prior outbound candidate is promoted only
    /// when `expected_root` names it; naming the base rolls it back.
    pub(crate) fn apply_inbound<T, R, F>(
        &mut self,
        expected_root: [u8; 32],
        entries: Vec<(AccountId, T)>,
        apply: F,
    ) -> Result<ResidentAccountBatch<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>
            + Send
            + Sync
            + 'static,
    {
        let pending_checkpoint = self.pending_checkpoint;
        let checkpoint_ack =
            pending_checkpoint.is_some_and(|pending| pending.accounts_root == expected_root);
        let (head, base_revision) = self.reconcile_head(expected_root)?;
        let reconcile = self
            .inbound_shards
            .union(&self.candidate_shards)
            .copied()
            .collect();
        let (worker_batches, inbound_shards) = self.worker_batches(entries)?;
        let (reply, inbound_revision) = self.run_phase(
            WorkerPhase::Inbound {
                head,
                checkpoint_ack,
            },
            worker_batches,
            reconcile,
            apply,
            base_revision,
            checkpoint_ack,
        )?;
        if matches!(head, ReconcileHead::Candidate) {
            let candidate = self
                .candidate_top
                .as_ref()
                .ok_or(BatchError::EntityRoundMissing)?;
            self.base_top
                .apply_sparse_overlay(candidate)
                .map_err(|error| forest_error(zero_account(), error))?;
        }
        let inbound_top = self
            .base_top
            .sparse_overlay(None, reply.descriptors)
            .map_err(|error| forest_error(zero_account(), error))?;
        let batch = ResidentAccountBatch {
            revision: inbound_revision,
            accounts_root: inbound_top.root_hash(),
            rows: reply.rows,
        };
        self.base_revision = base_revision;
        self.inbound_top = Some(inbound_top);
        self.inbound_revision = Some(inbound_revision);
        self.candidate_top = None;
        self.candidate_revision = None;
        self.inbound_shards = inbound_shards;
        self.candidate_shards.clear();
        if checkpoint_ack {
            self.checkpoint_revision = pending_checkpoint
                .ok_or(BatchError::EntityRoundMissing)?
                .revision;
        }
        if pending_checkpoint.is_some() {
            self.pending_checkpoint = None;
        }
        Ok(batch)
    }

    /// Apply all proposals from the immutable post-inbound snapshots in one
    /// worker join. Repeating this call never stacks on the prior candidate.
    pub(crate) fn apply_outbound<T, R, F>(
        &mut self,
        entries: Vec<(AccountId, T)>,
        apply: F,
    ) -> Result<ResidentAccountBatch<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>
            + Send
            + Sync
            + 'static,
    {
        self.apply_outbound_phase(entries, apply, false)
    }

    /// Append another proposal batch to the current outbound candidate.
    /// Unlike `apply_outbound`, this deliberately retains earlier candidate
    /// updates and folds only the newly dirty shard descriptors.
    pub(crate) fn apply_outbound_continue<T, R, F>(
        &mut self,
        entries: Vec<(AccountId, T)>,
        apply: F,
    ) -> Result<ResidentAccountBatch<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>
            + Send
            + Sync
            + 'static,
    {
        self.apply_outbound_phase(entries, apply, true)
    }

    /// Read final candidate values and their pre-inbound bases on the owning
    /// workers. No Account value, replica or Patricia node crosses to the
    /// coordinator; only callback results do.
    pub(crate) fn read_outbound<T, R, F>(
        &mut self,
        entries: Vec<(AccountId, T)>,
        read: F,
    ) -> Result<Vec<(AccountId, R)>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, &V, Option<&V>, T) -> Result<R, BatchError> + Send + Sync + 'static,
    {
        if self.inbound_top.is_none() {
            return Err(BatchError::EntityRoundMissing);
        }
        let (lanes, _) = self.worker_batches(entries)?;
        let replies = self.workers.run_lanes(lanes, move |state, batch| {
            read_worker_batch(state, batch, &read)
        })?;
        let mut rows = Vec::new();
        let mut first_error = None;
        for result in replies.into_iter().flatten() {
            match result {
                Ok(batch_rows) => rows.extend(batch_rows),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        rows.sort_by_key(|(account_id, _)| *account_id);
        Ok(rows)
    }

    /// Read one compact projection for every Account at the active head.
    /// Values remain resident in their workers; only the callback result
    /// crosses the worker boundary. Checkpoint metadata uses this to bind the
    /// complete signer configuration, including Accounts that were unchanged
    /// since the previous checkpoint.
    pub(crate) fn read_all<R, F>(&mut self, read: F) -> Result<Vec<(AccountId, R)>, BatchError>
    where
        R: Send + 'static,
        F: Fn(AccountId, &V) -> Result<R, BatchError> + Send + Sync + 'static,
    {
        let lanes = (0..self.workers.worker_count()).map(|_| vec![()]).collect();
        let replies = self.workers.run_lanes(lanes, move |state, ()| {
            let mut rows = Vec::new();
            for resident in state.shards.values() {
                for (key, value) in active_resident_shard(resident).iter() {
                    let account_id = AccountId::from_key(key);
                    rows.push((account_id, read(account_id, value)?));
                }
            }
            Ok::<_, BatchError>(rows)
        })?;
        let mut rows = Vec::new();
        for reply in replies.into_iter().flatten() {
            rows.extend(reply?);
        }
        rows.sort_by_key(|(account_id, _)| *account_id);
        Ok(rows)
    }

    /// Export the exact Account rows changed since the last durable Runtime
    /// checkpoint, without moving Account values out of their worker.
    ///
    /// Export is non-acknowledging: repeated calls always diff from the last
    /// durable baseline. The latest successful export becomes pending, and a
    /// later inbound visit implicitly acknowledges it only when the parent
    /// names that exact exported root. This permits several Entity rounds in
    /// one Runtime frame without losing cumulative changes.
    pub(crate) fn export_checkpoint_dirty<R, F>(
        &mut self,
        read: F,
    ) -> Result<ResidentCheckpointBatch<R>, BatchError>
    where
        R: Send + 'static,
        F: Fn(AccountId, &V, Option<&V>) -> Result<R, BatchError> + Send + Sync + 'static,
    {
        let base_revision = self.checkpoint_revision;
        let accounts_root = self.accounts_root();
        let revision = self.revision();
        if self.checkpoint_workers.is_empty() {
            self.pending_checkpoint = Some(PendingCheckpoint {
                revision,
                accounts_root,
            });
            return Ok(ResidentCheckpointBatch {
                base_revision,
                revision,
                accounts_root,
                rows: Vec::new(),
                removed: Vec::new(),
            });
        }

        let lanes = (0..self.workers.worker_count())
            .map(|worker| {
                self.checkpoint_workers
                    .contains(&worker)
                    .then_some(())
                    .into_iter()
                    .collect()
            })
            .collect();
        let replies = self.workers.run_lanes(lanes, move |state, ()| {
            prepare_worker_checkpoint(state, &read)
        })?;
        let mut rows = Vec::new();
        let mut first_error = None;
        for result in replies.into_iter().flatten() {
            match result {
                Ok(worker_rows) => rows.extend(worker_rows),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        rows.sort_by_key(|(account_id, _)| *account_id);
        self.pending_checkpoint = Some(PendingCheckpoint {
            revision,
            accounts_root,
        });
        Ok(ResidentCheckpointBatch {
            base_revision,
            revision,
            accounts_root,
            rows,
            removed: Vec::new(),
        })
    }

    fn apply_outbound_phase<T, R, F>(
        &mut self,
        entries: Vec<(AccountId, T)>,
        apply: F,
        continue_candidate: bool,
    ) -> Result<ResidentAccountBatch<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>
            + Send
            + Sync
            + 'static,
    {
        let start_revision = if continue_candidate {
            self.candidate_revision
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            self.inbound_revision
                .ok_or(BatchError::EntityRoundMissing)?
        };
        let reconcile = if continue_candidate {
            BTreeSet::new()
        } else {
            self.candidate_shards.clone()
        };
        let (worker_batches, touched) = self.worker_batches(entries)?;
        let mode = if continue_candidate {
            WorkerPhase::OutboundContinue
        } else {
            WorkerPhase::OutboundReset
        };
        let (reply, candidate_revision) = self.run_phase(
            mode,
            worker_batches,
            reconcile,
            apply,
            start_revision,
            false,
        )?;
        let parent = if continue_candidate {
            self.candidate_top
                .as_ref()
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            self.inbound_top
                .as_ref()
                .ok_or(BatchError::EntityRoundMissing)?
        };
        let candidate_top = self
            .base_top
            .sparse_overlay(Some(parent), reply.descriptors)
            .map_err(|error| forest_error(zero_account(), error))?;
        let batch = ResidentAccountBatch {
            revision: candidate_revision,
            accounts_root: candidate_top.root_hash(),
            rows: reply.rows,
        };
        self.candidate_top = Some(candidate_top);
        self.candidate_revision = Some(candidate_revision);
        if continue_candidate {
            self.candidate_shards.extend(touched);
        } else {
            self.candidate_shards = touched;
        }
        Ok(batch)
    }

    fn run_phase<T, R, F>(
        &mut self,
        mode: WorkerPhase,
        worker_batches: Vec<Vec<ShardMutationBatch<T>>>,
        reconcile: BTreeSet<usize>,
        apply: F,
        start_revision: u64,
        checkpoint_ack: bool,
    ) -> Result<(WorkerMutationReply<R>, u64), BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>
            + Send
            + Sync
            + 'static,
    {
        let phase = self.next_phase()?;
        let mut reconcile_by_worker = empty_lanes(self.workers.worker_count());
        for shard in reconcile {
            reconcile_by_worker[self.plan.worker(shard)].push(shard);
        }
        let checkpoint_workers = checkpoint_ack.then(|| self.checkpoint_workers.clone());
        let active_workers = worker_batches
            .iter()
            .zip(&reconcile_by_worker)
            .enumerate()
            .map(|(worker, (shards, reconcile))| {
                !shards.is_empty()
                    || !reconcile.is_empty()
                    || checkpoint_workers
                        .as_ref()
                        .is_some_and(|workers| workers.contains(&worker))
            })
            .collect::<Vec<_>>();
        let active = active_workers.iter().filter(|active| **active).count();
        let control = Arc::new(PhaseControl::new(active));
        let lanes = worker_batches
            .into_iter()
            .zip(reconcile_by_worker)
            .zip(active_workers)
            .map(|((shards, reconcile), active)| {
                if !active {
                    Vec::new()
                } else {
                    vec![WorkerMutationBatch {
                        allow_change: start_revision < u64::MAX,
                        control: Arc::clone(&control),
                        reconcile,
                        shards,
                        mode,
                        phase,
                    }]
                }
            })
            .collect();
        let replies = self.workers.run_lanes(lanes, move |state, batch| {
            run_worker_phase(state, batch, &apply)
        })?;
        let reply = collect_worker_replies(replies)?;
        if checkpoint_ack {
            self.checkpoint_workers.clear();
        }
        for account_id in &reply.changed {
            self.checkpoint_workers
                .insert(self.plan.worker(logical_account_shard(*account_id)));
        }
        for metric in &reply.metrics {
            self.plan
                .record_work(metric.shard, metric.items, metric.work_elapsed);
            if metric.fold_leaves > 0 {
                self.plan
                    .record_fold(metric.shard, metric.fold_leaves, metric.fold_elapsed);
            }
        }
        let revision = next_revision(start_revision, !reply.descriptors.is_empty())?;
        Ok((reply, revision))
    }

    fn worker_batches<T>(
        &self,
        entries: Vec<(AccountId, T)>,
    ) -> Result<WorkerMutationBatches<T>, BatchError> {
        let mut ordered = BTreeMap::new();
        for (account_id, payload) in entries {
            if ordered.insert(account_id, payload).is_some() {
                return Err(BatchError::DuplicateAccount(account_id));
            }
        }
        let mut buckets = BTreeMap::<usize, Vec<(AccountId, T)>>::new();
        for (account_id, payload) in ordered {
            buckets
                .entry(logical_account_shard(account_id))
                .or_default()
                .push((account_id, payload));
        }
        let mut workers = empty_lanes(self.workers.worker_count());
        let mut touched = BTreeSet::new();
        for (shard, entries) in buckets {
            touched.insert(shard);
            workers[self.plan.worker(shard)].push(ShardMutationBatch { shard, entries });
        }
        Ok((workers, touched))
    }

    fn reconcile_head(&self, expected: [u8; 32]) -> Result<(ReconcileHead, u64), BatchError> {
        if let Some(candidate) = self.candidate_top.as_ref()
            && candidate.root_hash() == expected
        {
            return Ok((
                ReconcileHead::Candidate,
                self.candidate_revision
                    .ok_or(BatchError::EntityRoundMissing)?,
            ));
        }
        if self.base_top.root_hash() == expected {
            return Ok((ReconcileHead::Base, self.base_revision));
        }
        Err(BatchError::EntityHeadRoot {
            actual: root_hex(expected),
            base: root_hex(self.base_top.root_hash()),
            candidate: root_hex(
                self.candidate_top
                    .as_ref()
                    .map_or(self.base_top.root_hash(), |top| top.root_hash()),
            ),
        })
    }

    fn next_phase(&mut self) -> Result<u64, BatchError> {
        self.phase = self
            .phase
            .checked_add(1)
            .ok_or(BatchError::CandidateAttemptOverflow)?;
        Ok(self.phase)
    }

    fn active_revision(&self) -> u64 {
        self.candidate_revision
            .or(self.inbound_revision)
            .unwrap_or(self.base_revision)
    }

    #[cfg(test)]
    fn active_overlay_work(&self) -> PersistentRadixOverlayWork {
        self.candidate_top
            .as_ref()
            .or(self.inbound_top.as_ref())
            .map_or(PersistentRadixOverlayWork::default(), |overlay| {
                overlay.work()
            })
    }

    #[cfg(test)]
    fn active_overlay_dirty_len(&self) -> usize {
        self.candidate_top
            .as_ref()
            .or(self.inbound_top.as_ref())
            .map_or(0, PersistentRadixShardOverlay::dirty_len)
    }

    #[cfg(test)]
    fn shard_snapshots(&mut self) -> Result<Vec<ResidentShardSnapshot>, BatchError> {
        let lanes = (0..self.workers.worker_count()).map(|_| vec![()]).collect();
        let replies = self.workers.run_lanes(lanes, |state, ()| {
            state
                .shards
                .iter()
                .map(|(index, resident)| ResidentShardSnapshot {
                    index: *index,
                    base: resident.base.descriptor(),
                    inbound: resident
                        .inbound
                        .as_ref()
                        .map(PersistentRadixShard::descriptor),
                    candidate: resident
                        .candidate
                        .as_ref()
                        .map(PersistentRadixShard::descriptor),
                })
                .collect::<Vec<_>>()
        })?;
        let mut snapshots = replies.into_iter().flatten().flatten().collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| snapshot.index);
        Ok(snapshots)
    }

    #[cfg(test)]
    fn rollback_snapshot_sizes(&mut self) -> Result<Vec<usize>, BatchError> {
        let lanes = (0..self.workers.worker_count()).map(|_| vec![()]).collect();
        let replies = self.workers.run_lanes(lanes, |state, ()| {
            state
                .rollback
                .as_ref()
                .map_or(0, |rollback| rollback.shards.len())
        })?;
        Ok(replies.into_iter().flatten().collect())
    }
}

type WorkerMutationBatches<T> = (Vec<Vec<ShardMutationBatch<T>>>, BTreeSet<usize>);

fn run_worker_phase<V, T, R, F>(
    state: &mut ResidentWorkerState<V>,
    batch: WorkerMutationBatch<T>,
    apply: &F,
) -> Result<WorkerMutationReply<R>, BatchError>
where
    V: Clone,
    F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>,
{
    let WorkerMutationBatch {
        phase,
        mode,
        reconcile,
        shards,
        control,
        allow_change,
    } = batch;
    let checkpoint_ack = matches!(
        mode,
        WorkerPhase::Inbound {
            checkpoint_ack: true,
            ..
        }
    );
    let mutation_shards = shards
        .iter()
        .map(|batch| batch.shard)
        .collect::<BTreeSet<_>>();
    let checkpoint_shards = if checkpoint_ack {
        state
            .checkpoint_dirty
            .iter()
            .copied()
            .map(logical_account_shard)
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    let touched = reconcile
        .iter()
        .copied()
        .chain(mutation_shards.iter().copied())
        .chain(checkpoint_shards)
        .collect::<BTreeSet<_>>();
    let snapshot = snapshot_worker_shards(state, phase, &touched);
    let result = match snapshot {
        Ok(()) => apply_worker_phase(
            state,
            mode,
            &reconcile,
            &mutation_shards,
            shards,
            allow_change,
            apply,
        ),
        Err(error) => Err(error),
    };
    if result.is_err() {
        control.failed.store(true, Ordering::Release);
    }
    control.barrier.wait();
    let failed = control.failed.load(Ordering::Acquire);
    finish_worker_phase(state, phase, failed)?;
    if !failed && let Ok(reply) = &result {
        state.checkpoint_dirty.extend(reply.changed.iter().copied());
    }
    result
}

fn apply_worker_phase<V, T, R, F>(
    state: &mut ResidentWorkerState<V>,
    mode: WorkerPhase,
    reconcile: &[usize],
    mutation_shards: &BTreeSet<usize>,
    batches: Vec<ShardMutationBatch<T>>,
    allow_change: bool,
    apply: &F,
) -> Result<WorkerMutationReply<R>, BatchError>
where
    V: Clone,
    F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>,
{
    match mode {
        WorkerPhase::Inbound {
            head,
            checkpoint_ack,
        } => reconcile_worker_head(state, head, reconcile, mutation_shards, checkpoint_ack)?,
        WorkerPhase::OutboundReset => prepare_worker_outbound(state, reconcile, mutation_shards)?,
        WorkerPhase::OutboundContinue => {}
    }
    let mut reply = WorkerMutationReply {
        rows: Vec::new(),
        changed: Vec::new(),
        descriptors: Vec::new(),
        metrics: Vec::new(),
    };
    for batch in batches {
        mutate_shard(state, mode, batch, allow_change, apply, &mut reply)?;
    }
    Ok(reply)
}

fn reconcile_worker_head<V: Clone>(
    state: &mut ResidentWorkerState<V>,
    head: ReconcileHead,
    reconcile: &[usize],
    mutation_shards: &BTreeSet<usize>,
    checkpoint_ack: bool,
) -> Result<(), BatchError> {
    let checkpoint_shards = if checkpoint_ack {
        state
            .checkpoint_dirty
            .iter()
            .copied()
            .map(logical_account_shard)
            .collect::<BTreeSet<_>>()
    } else {
        BTreeSet::new()
    };
    for shard in reconcile
        .iter()
        .copied()
        .chain(mutation_shards.iter().copied())
        .chain(checkpoint_shards.iter().copied())
        .collect::<BTreeSet<_>>()
    {
        let resident = resident_shard_mut(state, shard)?;
        let base = match head {
            ReconcileHead::Base => resident.base.clone(),
            ReconcileHead::Candidate => resident
                .candidate
                .take()
                .or_else(|| resident.inbound.take())
                .unwrap_or_else(|| resident.base.clone()),
        };
        resident.base = base.clone();
        resident.inbound = mutation_shards.contains(&shard).then_some(base);
        resident.candidate = None;
    }
    if checkpoint_ack {
        for shard in checkpoint_shards {
            let resident = resident_shard_mut(state, shard)?;
            resident.checkpoint = resident.base.clone();
        }
        state.checkpoint_dirty.clear();
    }
    Ok(())
}

fn prepare_worker_outbound<V>(
    state: &mut ResidentWorkerState<V>,
    reconcile: &[usize],
    mutation_shards: &BTreeSet<usize>,
) -> Result<(), BatchError> {
    for shard in reconcile
        .iter()
        .copied()
        .chain(mutation_shards.iter().copied())
        .collect::<BTreeSet<_>>()
    {
        let resident = resident_shard_mut(state, shard)?;
        resident.candidate = None;
    }
    Ok(())
}

fn mutate_shard<V, T, R, F>(
    state: &mut ResidentWorkerState<V>,
    mode: WorkerPhase,
    batch: ShardMutationBatch<T>,
    allow_change: bool,
    apply: &F,
    reply: &mut WorkerMutationReply<R>,
) -> Result<(), BatchError>
where
    V: Clone,
    F: Fn(AccountId, Option<V>, T) -> Result<ResidentAccountAction<V, R>, BatchError>,
{
    let started = Instant::now();
    let items = batch.entries.len();
    let resident = state
        .shards
        .get_mut(&batch.shard)
        .ok_or(BatchError::ResidentShardMissing { shard: batch.shard })?;
    let mut changed_in_shard = 0;
    for (account_id, payload) in batch.entries {
        let current = phase_shard(resident, mode)?
            .get(account_id.as_bytes())
            .map_err(|error| forest_error(account_id, error))?
            .cloned();
        match apply(account_id, current, payload)? {
            ResidentAccountAction::Keep(result) => reply.rows.push((account_id, result)),
            ResidentAccountAction::Put {
                value,
                value_digest,
                result,
            } => {
                if !allow_change {
                    return Err(BatchError::RevisionOverflow);
                }
                let updated = phase_shard(resident, mode)?
                    .updated(account_id.as_bytes().to_vec(), value, value_digest)
                    .map_err(|error| forest_error(account_id, error))?;
                *phase_shard_mut(resident, mode)? = updated;
                changed_in_shard += 1;
                reply.changed.push(account_id);
                reply.rows.push((account_id, result));
            }
        }
    }
    let work_elapsed = started.elapsed();
    let fold_started = Instant::now();
    if changed_in_shard > 0 {
        reply
            .descriptors
            .push(phase_shard(resident, mode)?.descriptor());
    }
    reply.metrics.push(ShardPhaseMetric {
        shard: batch.shard,
        items,
        work_elapsed,
        fold_leaves: changed_in_shard,
        fold_elapsed: fold_started.elapsed(),
    });
    Ok(())
}

fn phase_shard<V>(
    resident: &ResidentLogicalShard<V>,
    mode: WorkerPhase,
) -> Result<&PersistentRadixShard<V>, BatchError> {
    match mode {
        WorkerPhase::Inbound { .. } => resident
            .inbound
            .as_ref()
            .ok_or(BatchError::EntityRoundMissing),
        WorkerPhase::OutboundReset | WorkerPhase::OutboundContinue => Ok(resident
            .candidate
            .as_ref()
            .or(resident.inbound.as_ref())
            .unwrap_or(&resident.base)),
    }
}

fn phase_shard_mut<V>(
    resident: &mut ResidentLogicalShard<V>,
    mode: WorkerPhase,
) -> Result<&mut PersistentRadixShard<V>, BatchError>
where
    V: Clone,
{
    match mode {
        WorkerPhase::Inbound { .. } => resident
            .inbound
            .as_mut()
            .ok_or(BatchError::EntityRoundMissing),
        WorkerPhase::OutboundReset | WorkerPhase::OutboundContinue => {
            if resident.candidate.is_none() {
                resident.candidate =
                    Some(resident.inbound.as_ref().unwrap_or(&resident.base).clone());
            }
            resident
                .candidate
                .as_mut()
                .ok_or(BatchError::EntityRoundMissing)
        }
    }
}

fn read_worker_batch<V, T, R, F>(
    state: &mut ResidentWorkerState<V>,
    batch: ShardMutationBatch<T>,
    read: &F,
) -> Result<Vec<(AccountId, R)>, BatchError>
where
    V: Clone,
    F: Fn(AccountId, &V, Option<&V>, T) -> Result<R, BatchError>,
{
    let resident = state
        .shards
        .get(&batch.shard)
        .ok_or(BatchError::ResidentShardMissing { shard: batch.shard })?;
    let current_shard = resident
        .candidate
        .as_ref()
        .or(resident.inbound.as_ref())
        .unwrap_or(&resident.base);
    let mut rows = Vec::with_capacity(batch.entries.len());
    for (account_id, payload) in batch.entries {
        let current = current_shard
            .get(account_id.as_bytes())
            .map_err(|error| forest_error(account_id, error))?
            .ok_or(BatchError::CandidateAccountNotFound(account_id))?;
        let base = resident
            .base
            .get(account_id.as_bytes())
            .map_err(|error| forest_error(account_id, error))?;
        rows.push((account_id, read(account_id, current, base, payload)?));
    }
    Ok(rows)
}

fn prepare_worker_checkpoint<V, R, F>(
    state: &ResidentWorkerState<V>,
    read: &F,
) -> Result<Vec<(AccountId, R)>, BatchError>
where
    V: Clone,
    F: Fn(AccountId, &V, Option<&V>) -> Result<R, BatchError>,
{
    let mut rows = Vec::new();
    for account_id in &state.checkpoint_dirty {
        let shard = logical_account_shard(*account_id);
        let resident = state
            .shards
            .get(&shard)
            .ok_or(BatchError::ResidentShardMissing { shard })?;
        let current = active_resident_shard(resident)
            .get_with_digest(account_id.as_bytes())
            .map_err(|error| forest_error(*account_id, error))?;
        let previous = resident
            .checkpoint
            .get_with_digest(account_id.as_bytes())
            .map_err(|error| forest_error(*account_id, error))?;
        match (current, previous) {
            (None, None) => continue,
            (None, Some(_)) => {
                return Err(BatchError::ResidentCheckpointAccountRemoved(*account_id));
            }
            (Some(current), previous) => {
                if previous.is_some_and(|(_, digest)| digest == current.1) {
                    continue;
                }
                rows.push((
                    *account_id,
                    read(*account_id, current.0, previous.map(|row| row.0))?,
                ));
            }
        }
    }
    Ok(rows)
}

fn active_resident_shard<V>(resident: &ResidentLogicalShard<V>) -> &PersistentRadixShard<V> {
    resident
        .candidate
        .as_ref()
        .or(resident.inbound.as_ref())
        .unwrap_or(&resident.base)
}

fn snapshot_worker_shards<V: Clone>(
    state: &mut ResidentWorkerState<V>,
    phase: u64,
    touched: &BTreeSet<usize>,
) -> Result<(), BatchError> {
    state.rollback = Some(ResidentWorkerRollback {
        phase,
        shards: BTreeMap::new(),
        checkpoint_dirty: state.checkpoint_dirty.clone(),
    });
    for shard in touched {
        let resident = state
            .shards
            .get(shard)
            .ok_or(BatchError::ResidentShardMissing { shard: *shard })?
            .clone();
        let rollback = state
            .rollback
            .as_mut()
            .ok_or(BatchError::ResidentRollbackMissing { phase })?;
        rollback.shards.insert(*shard, resident);
    }
    Ok(())
}

fn finish_worker_phase<V>(
    state: &mut ResidentWorkerState<V>,
    phase: u64,
    rollback: bool,
) -> Result<(), BatchError> {
    let rollback_state = state
        .rollback
        .take()
        .ok_or(BatchError::ResidentRollbackMissing { phase })?;
    if rollback_state.phase != phase {
        let actual = rollback_state.phase;
        state.rollback = Some(rollback_state);
        return Err(BatchError::ResidentRollbackPhase {
            actual,
            expected: phase,
        });
    }
    if rollback {
        for (shard, resident) in rollback_state.shards {
            state.shards.insert(shard, resident);
        }
        state.checkpoint_dirty = rollback_state.checkpoint_dirty;
    }
    Ok(())
}

fn collect_worker_replies<R>(
    replies: Vec<Vec<Result<WorkerMutationReply<R>, BatchError>>>,
) -> Result<WorkerMutationReply<R>, BatchError> {
    let mut combined = WorkerMutationReply {
        rows: Vec::new(),
        changed: Vec::new(),
        descriptors: Vec::new(),
        metrics: Vec::new(),
    };
    let mut first_error = None;
    for mut lane in replies {
        if lane.is_empty() {
            continue;
        }
        if lane.len() != 1 {
            first_error.get_or_insert(BatchError::ResidentWorkerResultCount {
                actual: lane.len(),
                expected: 1,
            });
            continue;
        }
        let Some(reply) = lane.pop() else {
            first_error.get_or_insert(BatchError::ResidentWorkerReplyMissing);
            continue;
        };
        match reply {
            Ok(reply) => {
                combined.rows.extend(reply.rows);
                combined.changed.extend(reply.changed);
                combined.descriptors.extend(reply.descriptors);
                combined.metrics.extend(reply.metrics);
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    combined.rows.sort_by_key(|(account_id, _)| *account_id);
    combined.changed.sort_unstable();
    combined
        .descriptors
        .sort_by_key(|descriptor| descriptor.index());
    Ok(combined)
}

fn next_revision(revision: u64, changed: bool) -> Result<u64, BatchError> {
    if !changed {
        return Ok(revision);
    }
    revision.checked_add(1).ok_or(BatchError::RevisionOverflow)
}

fn resident_shard_mut<V>(
    state: &mut ResidentWorkerState<V>,
    shard: usize,
) -> Result<&mut ResidentLogicalShard<V>, BatchError> {
    state
        .shards
        .get_mut(&shard)
        .ok_or(BatchError::ResidentShardMissing { shard })
}

fn empty_lanes<T>(worker_count: usize) -> Vec<Vec<T>> {
    (0..worker_count).map(|_| Vec::new()).collect()
}

fn forest_error(account_id: AccountId, error: PersistentRadixMapError) -> BatchError {
    BatchError::AccountsTree {
        account_id,
        detail: error.to_string(),
    }
}

fn zero_account() -> AccountId {
    AccountId::from_bytes([0; 32])
}

fn root_hex(root: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in root {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use xln_rscore_protocol::{PersistentRadixMap, PersistentRadixOverlayWork};

    use super::{ResidentAccountAction, ResidentAccountForest};
    use crate::{AccountId, BatchError};

    fn account(shard: usize, suffix: u8) -> AccountId {
        let mut bytes = [0_u8; 32];
        bytes[0] = (shard >> 4) as u8;
        bytes[1] = ((shard & 0x0f) as u8) << 4;
        bytes[31] = suffix;
        AccountId::from_bytes(bytes)
    }

    fn digest(value: u64) -> [u8; 32] {
        let mut digest = [0_u8; 32];
        digest[24..].copy_from_slice(&value.to_be_bytes());
        digest
    }

    fn seeds(shards: &[usize]) -> Vec<(AccountId, u64, [u8; 32])> {
        shards
            .iter()
            .map(|shard| {
                (
                    account(*shard, 0),
                    *shard as u64 + 10,
                    digest(*shard as u64 + 10),
                )
            })
            .collect()
    }

    fn put(
        _account_id: AccountId,
        _current: Option<u64>,
        value: u64,
    ) -> Result<ResidentAccountAction<u64, u64>, BatchError> {
        Ok(ResidentAccountAction::Put {
            value,
            value_digest: digest(value),
            result: value,
        })
    }

    fn serial_map(seeds: &[(AccountId, u64, [u8; 32])]) -> PersistentRadixMap<u64> {
        let mut map = PersistentRadixMap::empty();
        for (account_id, value, value_digest) in seeds {
            map = map
                .updated(account_id.as_bytes().to_vec(), *value, *value_digest)
                .expect("serial seed");
        }
        map
    }

    #[test]
    fn next_inbound_accepts_the_parent_named_candidate() {
        let seeds = seeds(&[0x123]);
        let mut forest = ResidentAccountForest::restore(2, 7, seeds).expect("restore");
        let base = forest.accounts_root();
        forest
            .apply_inbound(base, vec![(account(0x123, 0), 20)], put)
            .expect("inbound");
        let candidate = forest
            .apply_outbound(vec![(account(0x123, 0), 30)], put)
            .expect("outbound");
        let accepted = forest
            .apply_inbound(
                candidate.accounts_root,
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| {
                    Ok::<_, BatchError>(ResidentAccountAction::<u64, ()>::Keep(()))
                },
            )
            .expect("accept candidate");
        let probe = forest
            .apply_outbound(vec![(account(0x123, 0), ())], |_account_id, current, ()| {
                let value = current.ok_or(BatchError::EmptyBatch)?;
                Ok(ResidentAccountAction::Keep(value))
            })
            .expect("probe accepted base");
        assert!(accepted.rows.is_empty());
        assert_eq!(accepted.accounts_root, candidate.accounts_root);
        assert_eq!(probe.rows, vec![(account(0x123, 0), 30)]);
    }

    #[test]
    fn next_inbound_rolls_an_unselected_candidate_back_to_base() {
        let seeds = seeds(&[0x123]);
        let mut forest = ResidentAccountForest::restore(2, 7, seeds).expect("restore");
        let base = forest.accounts_root();
        forest
            .apply_inbound(base, vec![(account(0x123, 0), 20)], put)
            .expect("inbound");
        forest
            .apply_outbound(vec![(account(0x123, 0), 30)], put)
            .expect("outbound");
        let rolled_back = forest
            .apply_inbound(
                base,
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| {
                    Ok::<_, BatchError>(ResidentAccountAction::<u64, ()>::Keep(()))
                },
            )
            .expect("rollback candidate");
        let probe = forest
            .apply_outbound(vec![(account(0x123, 0), ())], |_account_id, current, ()| {
                let value = current.ok_or(BatchError::EmptyBatch)?;
                Ok(ResidentAccountAction::Keep(value))
            })
            .expect("probe rolled back base");
        assert!(rolled_back.rows.is_empty());
        assert_eq!(rolled_back.accounts_root, base);
        assert_eq!(rolled_back.revision, 7);
        assert_eq!(probe.rows, vec![(account(0x123, 0), 0x123 + 10)]);
    }

    #[test]
    fn unknown_parent_root_is_fatal_and_changes_nothing() {
        let seeds = seeds(&[0, 1, 2, 3]);
        let mut forest = ResidentAccountForest::restore(4, 9, seeds).expect("restore");
        let root = forest.accounts_root();
        let revision = forest.revision();
        let before = forest.shard_snapshots().expect("before");
        let error = forest
            .apply_inbound([0x55; 32], vec![(account(0, 0), 99)], put)
            .expect_err("unknown root");
        assert!(matches!(error, BatchError::EntityHeadRoot { .. }));
        assert_eq!(forest.accounts_root(), root);
        assert_eq!(forest.revision(), revision);
        assert_eq!(forest.shard_snapshots().expect("after"), before);
        assert!(
            forest
                .rollback_snapshot_sizes()
                .expect("rollback cleared")
                .iter()
                .all(|size| *size == 0)
        );
    }

    #[test]
    fn cross_worker_error_rolls_every_shard_and_top_back_atomically() {
        let seeds = seeds(&[0, 1, 2, 3]);
        let mut forest = ResidentAccountForest::restore(2, 11, seeds).expect("restore");
        let root = forest.accounts_root();
        let revision = forest.revision();
        let before = forest.shard_snapshots().expect("before");
        let fail = account(1, 0);
        let error = forest
            .apply_inbound(
                root,
                vec![(account(0, 0), 100), (fail, 101)],
                move |account_id, _current, value| {
                    if account_id == fail {
                        return Err(BatchError::EmptyBatch);
                    }
                    put(account_id, None, value)
                },
            )
            .expect_err("worker error");
        assert_eq!(error, BatchError::EmptyBatch);
        assert_eq!(forest.accounts_root(), root);
        assert_eq!(forest.revision(), revision);
        assert_eq!(forest.shard_snapshots().expect("after"), before);
        assert!(
            forest
                .rollback_snapshot_sizes()
                .expect("error snapshots cleared")
                .iter()
                .all(|size| *size == 0)
        );
    }

    #[test]
    fn outbound_retry_always_restarts_from_inbound_snapshot() {
        let seeds = seeds(&[0x456]);
        let mut forest = ResidentAccountForest::restore(2, 3, seeds).expect("restore");
        let base = forest.accounts_root();
        forest
            .apply_inbound(base, vec![(account(0x456, 0), 20)], put)
            .expect("inbound");
        let propose = |account_id, current: Option<u64>, increment| {
            let value = current.ok_or(BatchError::EmptyBatch)? + increment;
            put(account_id, current, value)
        };
        let first = forest
            .apply_outbound(vec![(account(0x456, 0), 1)], propose)
            .expect("first outbound");
        let second = forest
            .apply_outbound(vec![(account(0x456, 0), 1)], propose)
            .expect("retry outbound");
        assert_eq!(first.rows, vec![(account(0x456, 0), 21)]);
        assert_eq!(second.rows, first.rows);
        assert_eq!(second.accounts_root, first.accounts_root);
        assert_eq!(second.revision, first.revision);
        assert!(
            forest
                .rollback_snapshot_sizes()
                .expect("success snapshots cleared")
                .iter()
                .all(|size| *size == 0)
        );
    }

    #[test]
    fn empty_inbound_without_prior_round_dispatches_no_worker_work() {
        let seeds = seeds(&[0x123]);
        let mut forest = ResidentAccountForest::restore(4, 1, seeds).expect("restore");
        let root = forest.accounts_root();
        let result = forest
            .apply_inbound(
                root,
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| {
                    Ok::<_, BatchError>(ResidentAccountAction::<u64, ()>::Keep(()))
                },
            )
            .expect("empty inbound");
        assert_eq!(result.accounts_root, root);
        assert!(result.rows.is_empty());
        assert!(
            forest
                .metrics()
                .iter()
                .all(|metric| metric.work_batches == 0)
        );
    }

    #[test]
    fn resident_work_updates_only_operator_metrics_for_touched_shard() {
        let seeds = seeds(&[0x123, 0x456]);
        let mut forest = ResidentAccountForest::restore(2, 1, seeds).expect("restore");
        let root = forest.accounts_root();
        forest
            .apply_inbound(root, vec![(account(0x123, 0), 99)], put)
            .expect("inbound");
        let metrics = forest.metrics();
        assert_eq!(metrics[0x123].work_batches, 1);
        assert_eq!(metrics[0x123].work_items, 1);
        assert_eq!(metrics[0x123].fold_batches, 1);
        assert_eq!(metrics[0x456].work_batches, 0);
    }

    #[test]
    fn one_account_phase_folds_one_descriptor_and_three_top_ancestors() {
        let initial = seeds(&[0x123]);
        let mut serial = serial_map(&initial);
        let mut forest = ResidentAccountForest::restore(4, 1, initial).expect("restore");
        let root = forest.accounts_root();
        let inbound = forest
            .apply_inbound(root, vec![(account(0x123, 0), 20)], put)
            .expect("inbound");
        serial = serial
            .updated(account(0x123, 0).as_bytes().to_vec(), 20, digest(20))
            .expect("serial inbound");
        assert_eq!(inbound.accounts_root, serial.root_hash());
        assert_eq!(forest.active_overlay_dirty_len(), 1);
        assert_eq!(
            forest.active_overlay_work(),
            PersistentRadixOverlayWork {
                dirty_descriptors: 1,
                second_level_folds: 1,
                first_level_folds: 1,
                root_folds: 1,
            }
        );

        let outbound = forest
            .apply_outbound(vec![(account(0x123, 0), 30)], put)
            .expect("outbound");
        serial = serial
            .updated(account(0x123, 0).as_bytes().to_vec(), 30, digest(30))
            .expect("serial outbound");
        assert_eq!(outbound.accounts_root, serial.root_hash());
        assert_eq!(forest.active_overlay_dirty_len(), 1);
        assert_eq!(
            forest.active_overlay_work(),
            PersistentRadixOverlayWork {
                dirty_descriptors: 1,
                second_level_folds: 1,
                first_level_folds: 1,
                root_folds: 1,
            }
        );
    }

    #[test]
    fn outbound_continuation_and_read_stay_on_resident_workers() {
        let initial = seeds(&[0x123, 0x456]);
        let mut forest = ResidentAccountForest::restore(2, 1, initial).expect("restore");
        let root = forest.accounts_root();
        forest
            .apply_inbound(root, vec![(account(0x123, 0), 20)], put)
            .expect("inbound");
        forest
            .apply_outbound(vec![(account(0x123, 0), 30)], put)
            .expect("outbound");
        let continued = forest
            .apply_outbound_continue(vec![(account(0x456, 0), 40)], put)
            .expect("continue outbound");
        assert_eq!(continued.rows, vec![(account(0x456, 0), 40)]);
        assert_eq!(forest.active_overlay_dirty_len(), 2);

        let rows = forest
            .read_outbound(
                vec![(account(0x123, 0), ()), (account(0x456, 0), ())],
                |_account_id, current, base, ()| Ok((*current, base.copied())),
            )
            .expect("worker-local read");
        assert_eq!(
            rows,
            vec![
                (account(0x123, 0), (30, Some(0x123 + 10))),
                (account(0x456, 0), (40, Some(0x456 + 10))),
            ]
        );
    }

    #[test]
    fn repeated_exports_share_the_durable_base_and_matching_inbound_acknowledges_latest() {
        let initial = seeds(&[0, 1]);
        let mut forest = ResidentAccountForest::restore(2, 5, initial).expect("restore");
        let root = forest.accounts_root();
        forest
            .apply_inbound(root, vec![(account(0, 0), 100)], put)
            .expect("inbound");
        forest
            .apply_outbound(vec![(account(1, 0), 101)], put)
            .expect("outbound");
        let first = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("first checkpoint export");
        assert_eq!(first.base_revision, 5);
        assert_eq!(
            first.rows,
            vec![
                (account(0, 0), (100, Some(10))),
                (account(1, 0), (101, Some(11))),
            ]
        );

        forest
            .apply_outbound(vec![(account(1, 0), 202)], put)
            .expect("replace candidate before reconciliation");
        let second = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("second checkpoint export");
        assert_eq!(second.base_revision, first.base_revision);
        assert_eq!(
            second.rows,
            vec![
                (account(0, 0), (100, Some(10))),
                (account(1, 0), (202, Some(11))),
            ]
        );

        forest
            .apply_inbound(second.accounts_root, vec![(account(0, 0), 102)], put)
            .expect("matching inbound implicitly acknowledges latest export");
        let next = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("next checkpoint");
        assert_eq!(next.rows, vec![(account(0, 0), (102, Some(100)))]);
        assert_eq!(next.base_revision, second.revision);
    }

    #[test]
    fn failed_checkpoint_callback_leaves_every_worker_dirty_for_exact_retry() {
        let initial = seeds(&[0, 1]);
        let mut forest = ResidentAccountForest::restore(2, 5, initial).expect("restore");
        let root = forest.accounts_root();
        forest
            .apply_inbound(root, vec![(account(0, 0), 100), (account(1, 0), 101)], put)
            .expect("inbound");
        let fail = account(1, 0);
        let error = forest
            .export_checkpoint_dirty(move |account_id, current, previous| {
                if account_id == fail {
                    return Err(BatchError::EmptyBatch);
                }
                Ok((*current, previous.copied()))
            })
            .expect_err("encoding failure");
        assert_eq!(error, BatchError::EmptyBatch);

        let retried = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("retry all dirty rows");
        assert_eq!(
            retried.rows,
            vec![
                (account(0, 0), (100, Some(10))),
                (account(1, 0), (101, Some(11))),
            ]
        );
        let repeated = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("export remains repeatable before implicit ack");
        assert_eq!(repeated.base_revision, retried.base_revision);
        assert_eq!(repeated.rows, retried.rows);
    }

    #[test]
    fn selecting_the_base_drops_pending_export_but_keeps_dirty_baseline() {
        let initial = seeds(&[0]);
        let mut forest = ResidentAccountForest::restore(1, 5, initial).expect("restore");
        let base_root = forest.accounts_root();
        forest
            .apply_inbound(base_root, vec![(account(0, 0), 100)], put)
            .expect("inbound");
        forest
            .apply_outbound(Vec::<(AccountId, u64)>::new(), put)
            .expect("outbound");
        forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("pending export");

        forest
            .apply_inbound(
                base_root,
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| Ok(ResidentAccountAction::Keep(())),
            )
            .expect("parent selects durable base");
        assert!(forest.pending_checkpoint.is_none());
        assert_eq!(forest.checkpoint_revision, 5);
        assert!(!forest.checkpoint_workers.is_empty());
    }

    #[test]
    fn failed_matching_inbound_rolls_back_checkpoint_ack_and_keeps_pending_export() {
        let initial = seeds(&[0]);
        let mut forest = ResidentAccountForest::restore(1, 5, initial).expect("restore");
        let base_root = forest.accounts_root();
        forest
            .apply_inbound(base_root, vec![(account(0, 0), 100)], put)
            .expect("inbound");
        forest
            .apply_outbound(Vec::<(AccountId, u64)>::new(), put)
            .expect("outbound");
        let pending = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("pending export");

        let error = forest
            .apply_inbound(
                pending.accounts_root,
                vec![(account(0, 0), ())],
                |_account_id, _current, ()| {
                    Err::<ResidentAccountAction<u64, ()>, _>(BatchError::EmptyBatch)
                },
            )
            .expect_err("failed inbound must not acknowledge checkpoint");
        assert_eq!(error, BatchError::EmptyBatch);
        assert_eq!(forest.checkpoint_revision, 5);
        assert!(forest.pending_checkpoint.is_some());

        let retried = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("same checkpoint retries after failed inbound");
        assert_eq!(retried.base_revision, pending.base_revision);
        assert_eq!(retried.accounts_root, pending.accounts_root);
        assert_eq!(retried.rows, pending.rows);
    }

    #[test]
    fn rolled_back_uncheckpointed_creation_nets_to_no_dirty_row() {
        let mut forest = ResidentAccountForest::<u64>::restore(2, 1, Vec::new()).expect("restore");
        let root = forest.accounts_root();
        forest
            .apply_inbound(
                root,
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| Ok(ResidentAccountAction::Keep(())),
            )
            .expect("empty inbound");
        forest
            .apply_outbound(vec![(account(0, 0), 50)], put)
            .expect("create candidate");
        forest
            .apply_outbound(
                Vec::<(AccountId, ())>::new(),
                |_account_id, _current, ()| Ok(ResidentAccountAction::Keep(())),
            )
            .expect("reset candidate");
        let checkpoint = forest
            .export_checkpoint_dirty(|_account_id, current, previous| {
                Ok((*current, previous.copied()))
            })
            .expect("net-empty checkpoint");
        assert!(checkpoint.rows.is_empty());
        assert_eq!(checkpoint.accounts_root, root);
    }

    #[test]
    fn resident_round_root_is_identical_with_1_2_4_8_16_workers() {
        let seeds = (0..4096)
            .map(|shard| (account(shard, 0), shard as u64, digest(shard as u64)))
            .collect::<Vec<_>>();
        let mut serial = serial_map(&seeds);
        let expected_seed_root = serial.root_hash();
        let inbound = (0..4096)
            .step_by(7)
            .map(|shard| (account(shard, 0), (shard as u64) + 10_000))
            .collect::<Vec<_>>();
        for (account_id, value) in &inbound {
            serial = serial
                .updated(account_id.as_bytes().to_vec(), *value, digest(*value))
                .expect("serial inbound");
        }
        let outbound = (0..4096)
            .step_by(11)
            .map(|shard| (account(shard, 0), (shard as u64) + 20_000))
            .collect::<Vec<_>>();
        for (account_id, value) in &outbound {
            serial = serial
                .updated(account_id.as_bytes().to_vec(), *value, digest(*value))
                .expect("serial outbound");
        }
        let expected_final_root = serial.root_hash();

        for workers in [1, 2, 4, 8, 16] {
            let mut forest = ResidentAccountForest::restore(workers, 7, seeds.clone())
                .expect("resident restore");
            assert_eq!(forest.worker_count(), workers);
            assert_eq!(forest.len(), 4096);
            assert_eq!(forest.revision(), 7);
            assert_eq!(forest.accounts_root(), expected_seed_root);
            let inbound_result = forest
                .apply_inbound(expected_seed_root, inbound.clone(), put)
                .expect("resident inbound");
            assert_eq!(inbound_result.rows.len(), inbound.len());
            let outbound_result = forest
                .apply_outbound(outbound.clone(), put)
                .expect("resident outbound");
            assert_eq!(outbound_result.revision, 9);
            assert_eq!(outbound_result.accounts_root, expected_final_root);
            assert_eq!(outbound_result.rows.len(), outbound.len());
        }
    }
}
