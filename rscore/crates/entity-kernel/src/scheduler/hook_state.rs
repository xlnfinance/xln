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

    #[test]
    fn restore_rebuilds_deadline_index_exactly() {
        let mut state = CrontabState {
            tasks: BTreeMap::new(),
            hooks: ScheduledHookMap::empty(),
        };

        // 20 hooks with varied trigger_at, many sharing the same deadline
        // to exercise duplicate deadline-key handling.
        let spec = [
            ("peer-a", "alpha", 10),
            ("peer-b", "bravo", 10), // same trigger as alpha
            ("peer-c", "charlie", 25),
            ("peer-d", "delta", 15),
            ("peer-e", "echo", 30),
            ("peer-f", "foxtrot", 25), // same trigger as charlie
            ("peer-g", "golf", 5),
            ("peer-h", "hotel", 20),
            ("peer-i", "india", 35),
            ("peer-j", "juliett", 15), // same trigger as delta
            ("peer-k", "kilo", 40),
            ("peer-l", "lima", 45),
            ("peer-m", "mike", 10), // same trigger as alpha, bravo
            ("peer-n", "november", 50),
            ("peer-o", "oscar", 55),
            ("peer-p", "papa", 60),
            ("peer-q", "quebec", 20), // same trigger as hotel
            ("peer-r", "romeo", 35),  // same trigger as india
            ("peer-s", "sierra", 70),
            ("peer-t", "tango", 65),
        ];

        for (account_id, lock_id, trigger_at) in &spec {
            schedule_hook(
                &mut state,
                ScheduledHook::htlc_timeout(
                    account_id.to_string(),
                    lock_id.to_string(),
                    *trigger_at,
                ),
            )
            .expect("schedule_hook");
        }

        // Cancel four hooks so that entries and due no longer cover the
        // exact initial set.
        cancel_hook(&mut state, "htlc-timeout:charlie").expect("cancel charlie");
        cancel_hook(&mut state, "htlc-timeout:hotel").expect("cancel hotel");
        cancel_hook(&mut state, "htlc-timeout:mike").expect("cancel mike");
        cancel_hook(&mut state, "htlc-timeout:romeo").expect("cancel romeo");

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
    }

    #[test]
    fn frame_overlay_and_sequential_agree_under_random_mutations() {
        const POOL_SIZE: usize = 40;
        const STEPS: usize = 300;

        // Minimal LCG for deterministic pseudo-random sequences.
        fn lcg(state: &mut u64) -> u64 {
            *state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *state
        }

        // Pre-generate the full operation list so both timelines see exactly
        // the same sequence.
        let mut rng = 123_456_789u64;
        let mut ops: Vec<(usize, bool, u64)> = Vec::with_capacity(STEPS);
        for _ in 0..STEPS {
            let idx = (lcg(&mut rng) as usize) % POOL_SIZE;
            let is_remove = lcg(&mut rng) % 4 == 3;
            let trigger = if is_remove { 0 } else { lcg(&mut rng) % 200 };
            ops.push((idx, is_remove, trigger));
        }

        fn make_hook(idx: usize, trigger: u64) -> ScheduledHook {
            ScheduledHook::htlc_timeout(format!("peer-{idx}"), format!("lock-{idx}"), trigger)
        }

        let mut sequential = ScheduledHookMap::empty();
        let mut batched = ScheduledHookMap::empty();

        // Buffer operations into batches whose size is drawn from the same
        // deterministic stream.
        let mut batch_start = 0;
        while batch_start < STEPS {
            let batch_size = ((lcg(&mut rng) as usize) % 10)
                .min(STEPS - batch_start)
                .max(1);
            let batch_end = (batch_start + batch_size).min(STEPS);

            // --- sequential: apply each op individually ---
            for (idx, is_remove, trigger) in &ops[batch_start..batch_end] {
                if *is_remove {
                    sequential
                        .remove(&make_hook(*idx, 0).id)
                        .expect("seq remove");
                } else {
                    sequential.put(make_hook(*idx, *trigger)).expect("seq put");
                }
            }

            // --- batched: apply the same ops through a frame ---
            let mut frame = ScheduledHookFrame::default();
            for (idx, is_remove, trigger) in &ops[batch_start..batch_end] {
                if *is_remove {
                    frame.remove(&make_hook(*idx, 0).id).expect("frame remove");
                } else {
                    frame.put(make_hook(*idx, *trigger)).expect("frame put");
                }
            }
            frame.commit(&mut batched).expect("frame commit");

            // --- assert full agreement after this batch ---
            assert_eq!(
                batched.entries.root_hash(),
                sequential.entries.root_hash(),
                "root_hash mismatch at batch {batch_start}..{batch_end}"
            );
            assert_eq!(
                batched.due, sequential.due,
                "due mismatch at batch {batch_start}..{batch_end}"
            );

            let seq_order: Vec<&str> = sequential.due(u64::MAX).map(|h| h.id.as_str()).collect();
            let bat_order: Vec<&str> = batched.due(u64::MAX).map(|h| h.id.as_str()).collect();
            assert_eq!(
                bat_order, seq_order,
                "due(u64::MAX) order mismatch at batch {batch_start}..{batch_end}"
            );

            // Every key in due maps to a hook id present in entries.
            let due_ids: std::collections::HashSet<&str> =
                batched.due.values().map(|s| s.as_str()).collect();
            for id in &due_ids {
                assert!(
                    batched.contains_key(id),
                    "due key missing from entries: {id}"
                );
            }
            // Mirror check: every entry has its id in due.
            assert_eq!(
                batched.due.len(),
                batched.entries.len(),
                "due.len != entries.len at batch {batch_start}..{batch_end}"
            );

            batch_start = batch_end;
        }
    }
}
