//! Independent work units from the canonical accounts tree's top-level slots.
//!
//! Each root nibble is processed serially by exactly one worker during a phase,
//! while Rayon schedules the sixteen subtrees across the available CPUs. This
//! preserves subtree isolation without pinning a hot nibble to an idle peer;
//! only the sixteen resulting child roots meet above this boundary.

use crate::AccountId;

pub(crate) const ROOT_SLOTS: usize = 16;

pub(crate) fn account_slot(account_id: AccountId) -> usize {
    usize::from(account_id.as_bytes()[0] >> 4)
}

pub(crate) fn partition_accounts<T>(
    items: Vec<T>,
    account_id: impl Fn(&T) -> AccountId,
) -> Vec<Vec<T>> {
    let mut shards = (0..ROOT_SLOTS).map(|_| Vec::new()).collect::<Vec<_>>();
    for item in items {
        let slot = account_slot(account_id(&item));
        shards[slot].push(item);
    }
    shards
}

pub(crate) fn partition_root_slots<T>(slots: [T; ROOT_SLOTS]) -> Vec<Vec<(usize, T)>> {
    slots
        .into_iter()
        .enumerate()
        .map(|entry| vec![entry])
        .collect()
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
