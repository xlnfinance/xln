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

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

use rayon::ThreadPool;
use rayon::prelude::*;
use xln_rscore_protocol::{
    PERSISTENT_RADIX_SHARD_COUNT, PersistentRadixMapError, SlotOutcome, SlotWork,
};

use super::{AccountShardPlan, logical_account_shard};
use crate::AccountId;

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

/// Run small waves inline; otherwise give each three-nibble logical shard to
/// its persistent worker. Every mutation, signature and leaf hash for one
/// prefix stays serial within that shard; only finished results meet here.
pub(crate) fn map_accounts<T, R, F, K>(
    pool: &ThreadPool,
    plan: &AccountShardPlan,
    items: Vec<T>,
    account_id: K,
    map: F,
) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Sync + Send,
    K: Fn(&T) -> AccountId,
{
    let sequential = items.len() <= SEQUENTIAL_FANOUT_MAX;
    if sequential {
        let mut shards = BTreeMap::<usize, Vec<T>>::new();
        for item in items {
            shards
                .entry(logical_account_shard(account_id(&item)))
                .or_default()
                .push(item);
        }
        return shards
            .into_iter()
            .flat_map(|(shard, items)| {
                let count = items.len();
                let started = Instant::now();
                let rows = items.into_iter().map(&map).collect::<Vec<_>>();
                plan.record_work(shard, count, started.elapsed());
                rows
            })
            .collect();
    }
    // A fixed directory is faster than one BTree allocation and comparison
    // chain per active prefix. At 4096 entries it is only 96 KiB of Vec
    // headers, reused for the whole dispatch and independent of Account size.
    let mut shards = (0..PERSISTENT_RADIX_SHARD_COUNT)
        .map(|_| Vec::new())
        .collect::<Vec<Vec<T>>>();
    for item in items {
        shards[logical_account_shard(account_id(&item))].push(item);
    }
    let mut lanes = (0..pool.current_num_threads())
        .map(|_| Vec::new())
        .collect::<Vec<_>>();
    for (shard, items) in shards.into_iter().enumerate() {
        if items.is_empty() {
            continue;
        }
        lanes[plan.worker(shard)].push((shard, items));
    }
    let lanes = lanes
        .into_iter()
        .map(Mutex::new)
        .collect::<Vec<Mutex<Vec<(usize, Vec<T>)>>>>();
    let worker_rows = pool.broadcast(|context| {
        let lane = std::mem::take(
            &mut *lanes[context.index()]
                .lock()
                .expect("RSCORE_ACCOUNT_SHARD_LANE_POISONED"),
        );
        lane.into_iter()
            .map(|(shard, items)| {
                let count = items.len();
                let started = Instant::now();
                let rows = items.into_iter().map(&map).collect::<Vec<_>>();
                plan.record_work(shard, count, started.elapsed());
                (shard, rows)
            })
            .collect::<Vec<_>>()
    });
    let mut rows = (0..PERSISTENT_RADIX_SHARD_COUNT)
        .map(|_| None)
        .collect::<Vec<Option<Vec<R>>>>();
    for (shard, shard_rows) in worker_rows.into_iter().flatten() {
        rows[shard] = Some(shard_rows);
    }
    rows.into_iter().flatten().flatten().collect()
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

#[cfg(test)]
mod tests {
    use super::AccountShardPlan;
    use super::map_accounts;
    use crate::AccountId;
    use rayon::ThreadPoolBuilder;
    use xln_rscore_protocol::PERSISTENT_RADIX_SHARD_COUNT;

    #[test]
    fn canonical_root_nibbles_keep_deterministic_order() {
        let accounts = (0_u8..16)
            .rev()
            .flat_map(|slot| {
                (0_u8..2).map(move |suffix| {
                    let mut bytes = [0_u8; 32];
                    bytes[0] = slot << 4;
                    bytes[31] = suffix;
                    AccountId::from_bytes(bytes)
                })
            })
            .collect::<Vec<_>>();
        let pool = ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .expect("test pool");
        let plan = AccountShardPlan::balanced(4).expect("plan");
        let ordered = map_accounts(&pool, &plan, accounts, |account_id| *account_id, |id| id);
        assert_eq!(ordered.len(), 32);
        for (index, account_id) in ordered.iter().enumerate() {
            assert_eq!(usize::from(account_id.as_bytes()[0] >> 4), index / 2);
        }
    }

    #[test]
    fn wide_pools_keep_three_nibble_shards_in_canonical_order() {
        let accounts = (0_u16..PERSISTENT_RADIX_SHARD_COUNT as u16)
            .rev()
            .flat_map(|prefix| {
                (0_u8..2).map(move |suffix| {
                    let mut bytes = [0_u8; 32];
                    bytes[0] = (prefix >> 4) as u8;
                    bytes[1] = ((prefix & 0x0f) as u8) << 4;
                    bytes[31] = suffix;
                    AccountId::from_bytes(bytes)
                })
            })
            .collect::<Vec<_>>();
        let pool = ThreadPoolBuilder::new()
            .num_threads(20)
            .build()
            .expect("test pool");
        let plan = AccountShardPlan::balanced(20).expect("plan");
        let ordered = map_accounts(&pool, &plan, accounts, |account_id| *account_id, |id| id);
        assert_eq!(ordered.len(), PERSISTENT_RADIX_SHARD_COUNT * 2);
        for (index, account_id) in ordered.iter().enumerate() {
            let bytes = account_id.as_bytes();
            let shard = (usize::from(bytes[0]) << 4) | usize::from(bytes[1] >> 4);
            assert_eq!(shard, index / 2);
        }
    }

    #[test]
    fn one_two_four_eight_and_sixteen_workers_keep_exact_shard_affinity() {
        let accounts = (0_u16..PERSISTENT_RADIX_SHARD_COUNT as u16)
            .map(|shard| {
                let mut bytes = [0_u8; 32];
                bytes[0] = (shard >> 4) as u8;
                bytes[1] = ((shard & 0x0f) as u8) << 4;
                AccountId::from_bytes(bytes)
            })
            .collect::<Vec<_>>();
        for workers in [1, 2, 4, 8, 16] {
            let pool = ThreadPoolBuilder::new()
                .num_threads(workers)
                .build()
                .expect("test pool");
            let plan = AccountShardPlan::balanced(workers).expect("plan");
            let actual = map_accounts(
                &pool,
                &plan,
                accounts.clone(),
                |account_id| *account_id,
                |account_id| {
                    (
                        account_id,
                        rayon::current_thread_index().expect("pool worker"),
                    )
                },
            );
            assert_eq!(actual.len(), PERSISTENT_RADIX_SHARD_COUNT);
            for (expected_shard, (account_id, worker)) in actual.iter().enumerate() {
                assert_eq!(super::logical_account_shard(*account_id), expected_shard);
                assert_eq!(*worker, expected_shard % workers);
            }
            let metrics = plan.metrics();
            assert_eq!(
                metrics.iter().map(|row| row.work_items).sum::<u64>(),
                PERSISTENT_RADIX_SHARD_COUNT as u64
            );
            assert!(metrics.iter().all(|row| row.work_batches == 1));
            assert!(metrics.iter().all(|row| row.work_items == 1));
        }
    }
}
