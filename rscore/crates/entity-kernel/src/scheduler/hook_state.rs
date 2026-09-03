use std::collections::BTreeMap;

use crate::{
    EntityKernelError,
    commitment::{consensus_digest_bytes, raw_text_key},
    scheduler::canonical_hook,
};

use super::{CrontabState, ScheduledHook, ScheduledHookMap};

impl ScheduledHookMap {
    pub fn restore(hooks: BTreeMap<String, ScheduledHook>) -> Result<Self, EntityKernelError> {
        let mut restored = Self::empty();
        for (key, hook) in hooks {
            if key != hook.id {
                return Err(EntityKernelError::CommitmentEncoding {
                    detail: format!("CRONTAB_HOOK_KEY_MISMATCH:{key}:{}", hook.id),
                });
            }
            restored.put(hook)?;
        }
        Ok(restored)
    }

    pub(crate) fn put(&mut self, hook: ScheduledHook) -> Result<(), EntityKernelError> {
        let key = raw_text_key(&hook.id)?;
        let previous_deadline = match self.entries.get(&key) {
            Some(previous) => Some(deadline_key(previous.trigger_at, &previous.id)?),
            None => None,
        };
        let digest = consensus_digest_bytes(&canonical_hook(&hook)?)?;
        let next_deadline = deadline_key(hook.trigger_at, &hook.id)?;
        let hook_id = hook.id.clone();
        let next_entries = self
            .entries
            .updated(key, hook, digest)
            .map_err(map_radix_error)?;
        self.entries = next_entries;
        if let Some(previous_deadline) = previous_deadline {
            self.due.remove(&previous_deadline);
        }
        self.due.insert(next_deadline, hook_id);
        Ok(())
    }

    pub(crate) fn remove(&mut self, hook_id: &str) -> Result<(), EntityKernelError> {
        let key = raw_text_key(hook_id)?;
        let Some(previous) = self.entries.get(&key) else {
            return Ok(());
        };
        let previous_deadline = deadline_key(previous.trigger_at, &previous.id)?;
        let next_entries = self.entries.removed(&key).map_err(map_radix_error)?;
        self.entries = next_entries;
        self.due.remove(&previous_deadline);
        Ok(())
    }
}

fn deadline_key(trigger_at: u64, hook_id: &str) -> Result<Vec<u8>, EntityKernelError> {
    let encoded_id = raw_text_key(hook_id)?;
    let mut key = Vec::with_capacity(8 + encoded_id.len());
    key.extend_from_slice(&trigger_at.to_be_bytes());
    key.extend_from_slice(&encoded_id);
    Ok(key)
}

fn map_radix_error(error: xln_rscore_protocol::PersistentRadixMapError) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: error.to_string(),
    }
}

/// Replace-or-create one deterministic hook by its stable identifier.
pub fn schedule_hook(
    state: &mut CrontabState,
    hook: ScheduledHook,
) -> Result<(), EntityKernelError> {
    state.hooks.put(hook)
}

/// Remove a hook if it still exists. Repeated cancellation is intentionally
/// idempotent, matching the TypeScript scheduler boundary.
pub fn cancel_hook(state: &mut CrontabState, hook_id: &str) -> Result<(), EntityKernelError> {
    state.hooks.remove(hook_id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::ScheduledHookKind;

    fn dispute_hook(account_id: &str, trigger_at: u64) -> ScheduledHook {
        ScheduledHook {
            id: format!("dispute-deadline:{account_id}"),
            trigger_at,
            kind: ScheduledHookKind::DisputeDeadline {
                account_id: account_id.to_string(),
            },
        }
    }

    #[test]
    fn replacement_and_cancel_keep_deadline_index_exact() {
        let mut state = CrontabState {
            tasks: BTreeMap::new(),
            hooks: ScheduledHookMap::empty(),
        };
        schedule_hook(&mut state, dispute_hook("peer", 10)).expect("initial hook");
        schedule_hook(&mut state, dispute_hook("peer", 20)).expect("replacement hook");

        assert_eq!(state.hooks.due(10).count(), 0);
        assert_eq!(
            state
                .hooks
                .due(20)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
            vec!["dispute-deadline:peer"]
        );

        cancel_hook(&mut state, "dispute-deadline:peer").expect("cancel hook");
        assert_eq!(state.hooks.due(u64::MAX).count(), 0);
        assert!(state.hooks.is_empty());
    }

    #[test]
    fn restore_rebuilds_deadline_index_exactly() {
        let mut state = CrontabState {
            tasks: BTreeMap::new(),
            hooks: ScheduledHookMap::empty(),
        };

        // 20 hooks with varied trigger_at, many sharing the same deadline
        // to exercise duplicate deadline-key handling.
        let spec = [
            ("alpha", 10),
            ("bravo", 10), // same trigger as alpha
            ("charlie", 25),
            ("delta", 15),
            ("echo", 30),
            ("foxtrot", 25), // same trigger as charlie
            ("golf", 5),
            ("hotel", 20),
            ("india", 35),
            ("juliett", 15), // same trigger as delta
            ("kilo", 40),
            ("lima", 45),
            ("mike", 10), // same trigger as alpha, bravo
            ("november", 50),
            ("oscar", 55),
            ("papa", 60),
            ("quebec", 20), // same trigger as hotel
            ("romeo", 35),  // same trigger as india
            ("sierra", 70),
            ("tango", 65),
        ];

        for (account_id, trigger_at) in &spec {
            schedule_hook(&mut state, dispute_hook(account_id, *trigger_at))
                .expect("schedule_hook");
        }

        // Cancel four hooks so that entries and due no longer cover the
        // exact initial set.
        for cancelled in ["charlie", "hotel", "mike", "romeo"] {
            cancel_hook(&mut state, &format!("dispute-deadline:{cancelled}")).expect("cancel");
        }

        let original = state.hooks.clone();

        // Rebuild from map.iter() exactly as a consumer would.
        let collected: BTreeMap<String, ScheduledHook> = original
            .iter()
            .map(|(id, hook)| (id.clone(), hook.clone()))
            .collect();
        let restored = ScheduledHookMap::restore(collected).expect("restore");

        assert_eq!(
            restored.entries.root_hash(),
            original.entries.root_hash(),
            "root_hash mismatch after restore"
        );
        assert_eq!(
            restored.due, original.due,
            "due index mismatch after restore"
        );
        assert_eq!(
            restored
                .due(u64::MAX)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
            original
                .due(u64::MAX)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
        );
    }
}
