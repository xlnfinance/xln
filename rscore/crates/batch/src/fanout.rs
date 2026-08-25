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
use xln_rscore_protocol::{PersistentRadixMapError, SlotOutcome, SlotWork};

use crate::AccountId;

/// Item counts at or below this run inline; above it the pool earns its hop.
pub(crate) const SEQUENTIAL_FANOUT_MAX: usize = 16;

/// Root-branch slots holding leaves at or below this count run inline.
pub(crate) const SEQUENTIAL_SLOT_FANOUT_MAX: usize = 4;

const ROOT_SLOTS: usize = 16;
const SECOND_LEVEL_SLOTS: usize = 256;

/// A second Patricia level creates enough independent subtrees to keep more
/// than sixteen workers busy. Below this many accounts, the extra empty shard
/// scheduling costs more than the additional parallelism.
pub(crate) const SECOND_LEVEL_FANOUT_MIN: usize = SECOND_LEVEL_SLOTS * 2;

fn account_slot(account_id: AccountId, second_level: bool) -> usize {
    let first = account_id.as_bytes()[0];
    if second_level {
        usize::from(first)
    } else {
        usize::from(first >> 4)
    }
}

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

/// Run small waves inline; otherwise give each canonical Patricia prefix to
/// one worker. Pools up to sixteen workers use the root nibble. Larger pools
/// use the second nibble once the wave is large enough, so twenty workers are
/// not artificially capped by sixteen root children. Every mutation,
/// signature and leaf hash for one prefix stays serial within that shard;
/// only finished child results meet above the prefix boundary.
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
    let second_level =
        pool.current_num_threads() > ROOT_SLOTS && items.len() >= SECOND_LEVEL_FANOUT_MIN;
    let shard_count = if second_level {
        SECOND_LEVEL_SLOTS
    } else {
        ROOT_SLOTS
    };
    let mut shards = (0..shard_count).map(|_| Vec::new()).collect::<Vec<_>>();
    for item in items {
        let slot = account_slot(account_id(&item), second_level);
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
    use super::{ROOT_SLOTS, SECOND_LEVEL_SLOTS, map_accounts};
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

    #[test]
    fn pools_above_sixteen_split_the_second_nibble_without_reordering() {
        let accounts = (0_u16..SECOND_LEVEL_SLOTS as u16)
            .rev()
            .flat_map(|prefix| {
                (0_u8..2).map(move |suffix| {
                    let mut bytes = [0_u8; 32];
                    bytes[0] = prefix as u8;
                    bytes[31] = suffix;
                    AccountId::from_bytes(bytes)
                })
            })
            .collect::<Vec<_>>();
        let pool = ThreadPoolBuilder::new()
            .num_threads(20)
            .build()
            .expect("test pool");
        let ordered = map_accounts(&pool, accounts, |account_id| *account_id, |id| id);
        assert_eq!(ordered.len(), SECOND_LEVEL_SLOTS * 2);
        for (index, account_id) in ordered.iter().enumerate() {
            assert_eq!(usize::from(account_id.as_bytes()[0]), index / 2);
        }
    }
}
