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

use rayon::ThreadPool;
use rayon::prelude::*;

use crate::AccountId;

/// Item counts at or below this run inline; above it the pool earns its hop.
pub(crate) const SEQUENTIAL_FANOUT_MAX: usize = 16;

/// Root-branch slots holding leaves at or below this count run inline.
pub(crate) const SEQUENTIAL_SLOT_FANOUT_MAX: usize = 4;

const ROOT_SLOTS: usize = 16;

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

/// Run small waves inline; otherwise give each canonical root nibble to one
/// worker. Every mutation, signature and leaf hash for a subtree therefore
/// stays on one CPU during the phase; only its finished child root meets the
/// other fifteen at the accounts-tree root.
pub(crate) fn map_accounts<T, R, F, K>(
    pool: &ThreadPool,
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
    if items.len() <= SEQUENTIAL_FANOUT_MAX {
        return items.into_iter().map(map).collect();
    }
    let mut shards = (0..ROOT_SLOTS).map(|_| Vec::new()).collect::<Vec<_>>();
    for item in items {
        let slot = usize::from(account_id(&item).as_bytes()[0] >> 4);
        shards[slot].push(item);
    }
    pool.install(|| {
        shards
            .into_par_iter()
            .map(|shard| shard.into_iter().map(&map).collect::<Vec<_>>())
            .collect::<Vec<_>>()
            .into_iter()
            .flatten()
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::{ROOT_SLOTS, map_accounts};
    use crate::AccountId;
    use rayon::ThreadPoolBuilder;

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
        let ordered = map_accounts(&pool, accounts, |account_id| *account_id, |id| id);
        assert_eq!(ordered.len(), ROOT_SLOTS * 2);
        for (index, account_id) in ordered.iter().enumerate() {
            assert_eq!(usize::from(account_id.as_bytes()[0] >> 4), index / 2);
        }
    }
}
