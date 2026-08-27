//! Fan out only when the work is worth a thread hop.
//!
//! Rayon's `install` moves the closure onto a pool thread and parks the caller
//! on a latch until it finishes. Measured on this engine that hand-off costs
//! more than the work whenever a wave touches only a few accounts, and it gets
//! worse as the pool grows: one account input in isolation cost 36 us with one
//! worker and 215 us with sixteen, none of it account work. A hub wave carries
//! well under one account input on average, so the pool was the whole bill.
//!
//! Below the threshold the same closure runs inline on the calling thread.
//! `par_iter().map().collect()` into a `Vec` preserves input order, so the
//! results are identical either way and account-local order is untouched.

use std::sync::Mutex;
use std::time::Instant;

use rayon::ThreadPool;
use rayon::prelude::*;
use xln_rscore_protocol::{PersistentRadixMapError, SlotOutcome, SlotWork};

use super::AccountShardPlan;

/// Item counts at or below this run inline; above it the pool earns its hop.
pub(crate) const SEQUENTIAL_FANOUT_MAX: usize = 16;

/// Root-branch slots holding leaves at or below this count run inline.
pub(crate) const SEQUENTIAL_SLOT_FANOUT_MAX: usize = 4;

const SECOND_LEVEL_SLOTS: usize = 256;

/// A second Patricia level creates enough independent subtrees to keep more
/// than sixteen workers busy. Below this many accounts, the extra empty shard
/// scheduling costs more than the additional parallelism.
pub(crate) const SECOND_LEVEL_FANOUT_MIN: usize = SECOND_LEVEL_SLOTS * 2;

/// The 4096-way splitter is sparse, but reconnecting three levels still has a
/// fixed cost. Require enough changed leaves to amortize it.
pub(crate) const THREE_LEVEL_FANOUT_MIN: usize = 1024;

/// Map owned work, sequentially for a small batch.
pub(crate) fn map_owned<T, R, F>(pool: &ThreadPool, items: Vec<T>, map: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Sync + Send,
{
    if items.len() <= SEQUENTIAL_FANOUT_MAX {
        return items.into_iter().map(map).collect();
    }
    pool.install(|| items.into_par_iter().map(map).collect())
}

/// Map borrowed work, sequentially for a small batch.
pub(crate) fn map_borrowed<T, R, F>(pool: &ThreadPool, items: &[T], map: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync + Send,
{
    if items.len() <= SEQUENTIAL_FANOUT_MAX {
        return items.iter().map(map).collect();
    }
    pool.install(|| items.par_iter().map(map).collect())
}

/// Rebuild independent Patricia prefixes on the configured worker pool.
/// Array order is canonical tree order and Rayon preserves it on collect.
pub(crate) fn map_slots<V: Clone + Send + Sync, const N: usize>(
    pool: &ThreadPool,
    slots: [SlotWork<V>; N],
) -> [Result<SlotOutcome<V>, PersistentRadixMapError>; N] {
    if slots.iter().filter(|slot| slot.has_work()).count() <= SEQUENTIAL_SLOT_FANOUT_MAX {
        return slots.map(SlotWork::apply);
    }
    pool.install(|| {
        let mut results = slots
            .into_iter()
            .collect::<Vec<_>>()
            .into_par_iter()
            .map(SlotWork::apply)
            .collect::<Vec<_>>()
            .into_iter();
        std::array::from_fn(|_| {
            results
                .next()
                .unwrap_or_else(|| Err(PersistentRadixMapError::EmptyKey))
        })
    })
}

/// Rebuild the 4096 canonical three-nibble Account prefixes on their assigned
/// workers. Empty prefixes stay on the coordinator; only actual leaf folds
/// pay a worker wake-up.
pub(crate) fn map_account_slots<V: Clone + Send + Sync>(
    pool: &ThreadPool,
    plan: &AccountShardPlan,
    slots: Vec<SlotWork<V>>,
) -> Vec<Result<SlotOutcome<V>, PersistentRadixMapError>> {
    let mut completed = (0..slots.len()).map(|_| None).collect::<Vec<_>>();
    let mut lanes = (0..pool.current_num_threads())
        .map(|_| Vec::new())
        .collect::<Vec<_>>();
    for (shard, slot) in slots.into_iter().enumerate() {
        if slot.has_work() {
            lanes[plan.worker(shard)].push((shard, slot));
        } else {
            completed[shard] = Some(slot.apply());
        }
    }
    let lanes = lanes
        .into_iter()
        .map(Mutex::new)
        .collect::<Vec<Mutex<Vec<(usize, SlotWork<V>)>>>>();
    let worker_rows = pool.broadcast(|context| {
        let lane = std::mem::take(
            &mut *lanes[context.index()]
                .lock()
                .expect("RSCORE_ACCOUNT_SHARD_LANE_POISONED"),
        );
        lane.into_iter()
            .map(|(shard, slot)| {
                let count = slot.work_len();
                let started = Instant::now();
                let outcome = slot.apply();
                plan.record_fold(shard, count, started.elapsed());
                (shard, outcome)
            })
            .collect::<Vec<_>>()
    });
    for (shard, outcome) in worker_rows.into_iter().flatten() {
        completed[shard] = Some(outcome);
    }
    completed
        .into_iter()
        .map(|outcome| outcome.expect("RSCORE_ACCOUNT_SHARD_OUTCOME_MISSING"))
        .collect()
}
