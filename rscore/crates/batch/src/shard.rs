//! Independent work units from the canonical accounts tree's top-level slots.
//!
//! Each root nibble is processed serially by exactly one worker during a phase,
//! while Rayon schedules the sixteen subtrees across the available CPUs. This
//! preserves subtree isolation without pinning a hot nibble to an idle peer;
//! only the sixteen resulting child roots meet above this boundary.

use rayon::{ThreadPool, prelude::*};

use crate::AccountId;

pub(crate) const ROOT_SLOTS: usize = 16;

pub(crate) fn account_slot(account_id: AccountId) -> usize {
    usize::from(account_id.as_bytes()[0] >> 4)
}

fn partition_accounts<T>(items: Vec<T>, account_id: impl Fn(&T) -> AccountId) -> Vec<Vec<T>> {
    let mut shards = (0..ROOT_SLOTS).map(|_| Vec::new()).collect::<Vec<_>>();
    for item in items {
        let slot = account_slot(account_id(&item));
        shards[slot].push(item);
    }
    shards
}

/// Run small waves inline; otherwise give each root nibble to one worker.
///
/// This keeps all mutation, hashing and signing for one canonical subtree on
/// one CPU during the phase. Rayon may move a subtree between CPUs across
/// phases, but two CPUs never mutate the same subtree inside one phase.
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
    if items.len() <= crate::fanout::SEQUENTIAL_FANOUT_MAX {
        return items.into_iter().map(map).collect();
    }
    let shards = partition_accounts(items, account_id);
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
    use super::{ROOT_SLOTS, account_slot, partition_accounts};
    use crate::AccountId;

    #[test]
    fn every_root_nibble_is_one_independent_work_unit() {
        let accounts = (0_u8..16)
            .map(|slot| {
                let mut bytes = [0_u8; 32];
                bytes[0] = slot << 4;
                AccountId::from_bytes(bytes)
            })
            .collect::<Vec<_>>();
        let shards = partition_accounts(accounts, |account_id| *account_id);
        assert_eq!(shards.len(), ROOT_SLOTS);
        for (slot, shard) in shards.iter().enumerate() {
            assert_eq!(shard.len(), 1);
            assert_eq!(account_slot(shard[0]), slot);
        }
    }
}
