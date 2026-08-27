use std::collections::BTreeMap;

use xln_rscore_entity_kernel::{EntityStateSlice, ScheduledHook};

use super::RuntimeMachineError;

/// Deterministic due index rebuilt from committed Entity crontab state.
///
/// The map key orders equal deadlines by stable hook id, never by insertion
/// order or a randomized hash seed. Rebuilding is O(number of live hooks), and
/// selecting due work is an ordered prefix.
pub struct ScheduledWakeIndex {
    by_deadline: BTreeMap<(u64, String), ScheduledHook>,
}

impl ScheduledWakeIndex {
    pub fn empty() -> Self {
        Self {
            by_deadline: BTreeMap::new(),
        }
    }

    pub fn from_entity_state(state: &EntityStateSlice) -> Result<Self, RuntimeMachineError> {
        let mut index = Self::empty();
        let Some(crontab) = &state.crontab else {
            return Ok(index);
        };
        for hook in crontab.hooks.values() {
            let key = (hook.trigger_at, hook.id.clone());
            if index.by_deadline.insert(key, hook.clone()).is_some() {
                return Err(RuntimeMachineError::ScheduledWakeDuplicate {
                    id: hook.id.clone(),
                });
            }
        }
        Ok(index)
    }

    pub fn due(&self, timestamp: u64) -> Vec<&ScheduledHook> {
        self.by_deadline
            .iter()
            .take_while(|((due_at, _), _)| *due_at <= timestamp)
            .map(|(_, hook)| hook)
            .collect()
    }

    pub fn next_timestamp(&self) -> Option<u64> {
        self.by_deadline
            .keys()
            .next()
            .map(|(timestamp, _)| *timestamp)
    }

    pub fn len(&self) -> usize {
        self.by_deadline.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_deadline.is_empty()
    }
}

impl Default for ScheduledWakeIndex {
    fn default() -> Self {
        Self::empty()
    }
}
