use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::{AccountId, BatchError};

/// Twelve Account-key bits keep the logical partition count independent from the
/// machine's physical core count. Reassigning a shard changes scheduling only;
/// it can never change Account order, Patricia paths, or committed bytes.
pub const LOGICAL_ACCOUNT_SHARDS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountShardMetric {
    pub shard: u16,
    pub worker: u16,
    pub work_batches: u64,
    pub work_items: u64,
    pub work_nanos: u64,
    pub max_work_items: u64,
    pub fold_batches: u64,
    pub fold_leaves: u64,
    pub fold_nanos: u64,
    pub max_fold_leaves: u64,
}

#[derive(Default)]
struct ShardCounters {
    work_batches: AtomicU64,
    work_items: AtomicU64,
    work_nanos: AtomicU64,
    max_work_items: AtomicU64,
    fold_batches: AtomicU64,
    fold_leaves: AtomicU64,
    fold_nanos: AtomicU64,
    max_fold_leaves: AtomicU64,
}

pub(crate) struct AccountShardPlan {
    worker_by_shard: Box<[u16]>,
    counters: Box<[ShardCounters]>,
}

impl AccountShardPlan {
    pub(crate) fn balanced(worker_count: usize) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > u16::MAX as usize {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        let worker_by_shard = (0..LOGICAL_ACCOUNT_SHARDS)
            .map(|shard| (shard % worker_count) as u16)
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let counters = (0..LOGICAL_ACCOUNT_SHARDS)
            .map(|_| ShardCounters::default())
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Ok(Self {
            worker_by_shard,
            counters,
        })
    }

    pub(crate) fn worker(&self, shard: usize) -> usize {
        usize::from(self.worker_by_shard[shard])
    }

    pub(crate) fn record_work(&self, shard: usize, items: usize, elapsed: Duration) {
        let counters = &self.counters[shard];
        counters.work_batches.fetch_add(1, Ordering::Relaxed);
        counters
            .work_items
            .fetch_add(items as u64, Ordering::Relaxed);
        counters
            .work_nanos
            .fetch_add(duration_nanos(elapsed), Ordering::Relaxed);
        counters
            .max_work_items
            .fetch_max(items as u64, Ordering::Relaxed);
    }

    pub(crate) fn record_fold(&self, shard: usize, leaves: usize, elapsed: Duration) {
        let counters = &self.counters[shard];
        counters.fold_batches.fetch_add(1, Ordering::Relaxed);
        counters
            .fold_leaves
            .fetch_add(leaves as u64, Ordering::Relaxed);
        counters
            .fold_nanos
            .fetch_add(duration_nanos(elapsed), Ordering::Relaxed);
        counters
            .max_fold_leaves
            .fetch_max(leaves as u64, Ordering::Relaxed);
    }

    pub(crate) fn metrics(&self) -> Vec<AccountShardMetric> {
        self.counters
            .iter()
            .enumerate()
            .map(|(shard, counters)| AccountShardMetric {
                shard: shard as u16,
                worker: self.worker_by_shard[shard],
                work_batches: counters.work_batches.load(Ordering::Relaxed),
                work_items: counters.work_items.load(Ordering::Relaxed),
                work_nanos: counters.work_nanos.load(Ordering::Relaxed),
                max_work_items: counters.max_work_items.load(Ordering::Relaxed),
                fold_batches: counters.fold_batches.load(Ordering::Relaxed),
                fold_leaves: counters.fold_leaves.load(Ordering::Relaxed),
                fold_nanos: counters.fold_nanos.load(Ordering::Relaxed),
                max_fold_leaves: counters.max_fold_leaves.load(Ordering::Relaxed),
            })
            .collect()
    }
}

pub(crate) fn logical_account_shard(account_id: AccountId) -> usize {
    let bytes = account_id.as_bytes();
    (usize::from(bytes[0]) << 4) | usize::from(bytes[1] >> 4)
}

fn duration_nanos(elapsed: Duration) -> u64 {
    elapsed.as_nanos().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::{AccountShardPlan, LOGICAL_ACCOUNT_SHARDS, logical_account_shard};
    use crate::AccountId;

    #[test]
    fn first_three_nibbles_select_every_logical_shard() {
        for expected in 0..LOGICAL_ACCOUNT_SHARDS {
            let mut bytes = [0_u8; 32];
            bytes[0] = (expected >> 4) as u8;
            bytes[1] = ((expected & 0x0f) as u8) << 4;
            assert_eq!(
                logical_account_shard(AccountId::from_bytes(bytes)),
                expected
            );
        }
    }

    #[test]
    fn balanced_assignment_is_total_and_deterministic() {
        let plan = AccountShardPlan::balanced(20).expect("plan");
        for shard in 0..LOGICAL_ACCOUNT_SHARDS {
            assert_eq!(plan.worker(shard), shard % 20);
        }
    }
}
