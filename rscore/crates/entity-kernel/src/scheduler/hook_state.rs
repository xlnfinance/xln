use std::collections::BTreeMap;

use xln_rscore_protocol::{PersistentRadixMutation, SlotWork};

use crate::{
    EntityKernelError,
    commitment::{consensus_digest_bytes, raw_text_key},
    scheduler::canonical_hook,
};

use super::{CrontabState, ScheduledHook, ScheduledHookMap};

/// Frame-local crontab overlay. A busy payment frame may touch the same hook
/// several times; only its final value and deadline reach the two canonical
/// radix maps.
#[derive(Default)]
pub(crate) struct ScheduledHookFrame {
    pending: BTreeMap<Vec<u8>, Option<ScheduledHook>>,
}

impl ScheduledHookFrame {
    pub(crate) fn put(&mut self, hook: ScheduledHook) -> Result<(), EntityKernelError> {
        self.pending.insert(raw_text_key(&hook.id)?, Some(hook));
        Ok(())
    }

    pub(crate) fn remove(&mut self, hook_id: &str) -> Result<(), EntityKernelError> {
        self.pending.insert(raw_text_key(hook_id)?, None);
        Ok(())
    }

    pub(crate) fn commit(self, state: &mut ScheduledHookMap) -> Result<(), EntityKernelError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let mut entry_mutations = Vec::with_capacity(self.pending.len());
        let mut due = BTreeMap::<Vec<u8>, Option<String>>::new();
        for (key, next) in self.pending {
            if let Some(previous) = state.entries.get(&key) {
                due.insert(deadline_key(previous.trigger_at, &previous.id)?, None);
            }
            match next {
                Some(hook) => {
                    let digest = consensus_digest_bytes(&canonical_hook(&hook)?)?;
                    due.insert(
                        deadline_key(hook.trigger_at, &hook.id)?,
                        Some(hook.id.clone()),
                    );
                    entry_mutations.push(PersistentRadixMutation::Put {
                        key,
                        value: hook,
                        value_digest: digest,
                    });
                }
                None => entry_mutations.push(PersistentRadixMutation::Remove { key }),
            }
        }
        let entries = state
            .entries
            .mutated_batch_two_levels(entry_mutations, |slots| slots.map(SlotWork::apply))
            .map_err(map_radix_error)?;
        state.entries = entries;
        for (key, value) in due {
            match value {
                Some(hook_id) => {
                    state.due.insert(key, hook_id);
                }
                None => {
                    state.due.remove(&key);
                }
            }
        }
        Ok(())
    }
}

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

    #[test]
    fn replacement_and_cancel_keep_deadline_index_exact() {
        let mut state = CrontabState {
            tasks: BTreeMap::new(),
            hooks: ScheduledHookMap::empty(),
        };
        schedule_hook(
            &mut state,
            ScheduledHook::htlc_timeout("peer".to_string(), "lock".to_string(), 10),
        )
        .expect("initial hook");
        schedule_hook(
            &mut state,
            ScheduledHook::htlc_timeout("peer".to_string(), "lock".to_string(), 20),
        )
        .expect("replacement hook");

        assert_eq!(state.hooks.due(10).count(), 0);
        assert_eq!(
            state
                .hooks
                .due(20)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
            vec!["htlc-timeout:lock"]
        );

        cancel_hook(&mut state, "htlc-timeout:lock").expect("cancel hook");
        assert_eq!(state.hooks.due(u64::MAX).count(), 0);
        assert!(state.hooks.is_empty());
    }

    #[test]
    fn batched_hooks_match_sequential_roots_and_deadlines() {
        let initial = ScheduledHook::htlc_timeout("peer-a".into(), "lock-a".into(), 10);
        let replacement = ScheduledHook::htlc_timeout("peer-a".into(), "lock-a".into(), 30);
        let retained = ScheduledHook::htlc_timeout("peer-b".into(), "lock-b".into(), 20);
        let mut sequential = ScheduledHookMap::empty();
        sequential.put(initial.clone()).expect("initial");
        sequential.put(retained.clone()).expect("retained");
        sequential.put(replacement.clone()).expect("replacement");

        let mut batched = ScheduledHookMap::empty();
        batched.put(initial).expect("initial");
        let mut frame = ScheduledHookFrame::default();
        frame.put(retained).expect("retained");
        frame.put(replacement).expect("replacement");
        frame.commit(&mut batched).expect("batch");

        assert_eq!(batched.entries.root_hash(), sequential.entries.root_hash());
        assert_eq!(batched.due, sequential.due);
        assert_eq!(
            batched
                .due(u64::MAX)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
            sequential
                .due(u64::MAX)
                .map(|hook| hook.id.as_str())
                .collect::<Vec<_>>(),
        );
    }
}
