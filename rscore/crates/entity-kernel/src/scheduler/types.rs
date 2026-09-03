use std::collections::BTreeMap;

use xln_rscore_protocol::{CanonicalNumber, PersistentRadixMap};

use crate::commitment::raw_text_key;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CrontabTaskMethod {
    HubRebalance,
}

impl CrontabTaskMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HubRebalance => "hubRebalance",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CrontabTaskParam {
    String(String),
    Number(CanonicalNumber),
    Bool(bool),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrontabTaskState {
    pub method: CrontabTaskMethod,
    pub interval_ms: u64,
    pub last_run: u64,
    pub enabled: bool,
    pub params: BTreeMap<String, CrontabTaskParam>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Per-payment deadlines (HTLC timeout, secret-ack timeout) are not hooks:
/// they are derived from Account locks and paybook entries at wake time.
pub enum ScheduledHookKind {
    DisputeDeadline {
        account_id: String,
    },
    SettlementWindow,
    Watchdog,
    HubRebalanceKick {
        reason: String,
        counterparty_id: String,
    },
    BoardHankoRefresh {
        activation_j_height: u64,
        activation_log_index: u64,
        after_counterparty_id: String,
    },
    CounterpartyBoardHankoRefreshDeadline {
        account_id: String,
        activation_j_height: u64,
        activation_log_index: u64,
    },
    CrossJOrderbookSweep {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledHook {
    pub id: String,
    pub trigger_at: u64,
    pub kind: ScheduledHookKind,
}

#[derive(Clone)]
pub struct ScheduledHookMap {
    pub(crate) entries: PersistentRadixMap<ScheduledHook>,
    /// Deadline index `trigger_at(be) ++ id-key -> hook id`. Only `entries`
    /// is committed (see `root_hash`), so this is plain ordered RAM: a
    /// second Patricia map here doubled every hook mutation's path-copy
    /// cost on the Entity's serial thread for no consensus value.
    pub(crate) due: BTreeMap<Vec<u8>, String>,
}

impl ScheduledHookMap {
    pub fn empty() -> Self {
        Self {
            entries: PersistentRadixMap::empty(),
            due: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn root_hash(&self) -> [u8; 32] {
        self.entries.root_hash()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &ScheduledHook)> {
        self.entries.iter().map(|(_, hook)| (&hook.id, hook))
    }

    pub fn values(&self) -> impl Iterator<Item = &ScheduledHook> {
        self.entries.iter().map(|(_, hook)| hook)
    }

    pub fn due(&self, now: u64) -> impl Iterator<Item = &ScheduledHook> {
        self.due
            .iter()
            .take_while(move |(key, _)| {
                let prefix: [u8; 8] = key[..8]
                    .try_into()
                    .expect("SCHEDULED_HOOK_DEADLINE_KEY_INVALID");
                u64::from_be_bytes(prefix) <= now
            })
            .map(|(_, hook_id)| {
                self.get(hook_id)
                    .expect("SCHEDULED_HOOK_DEADLINE_INDEX_DIVERGED")
            })
    }

    fn get(&self, hook_id: &str) -> Option<&ScheduledHook> {
        raw_text_key(hook_id)
            .ok()
            .and_then(|key| self.entries.get(&key))
    }

    pub fn contains_key(&self, hook_id: &str) -> bool {
        self.get(hook_id).is_some()
    }
}

impl Default for ScheduledHookMap {
    fn default() -> Self {
        Self::empty()
    }
}

impl std::fmt::Debug for ScheduledHookMap {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_map().entries(self.iter()).finish()
    }
}

impl PartialEq for ScheduledHookMap {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}

impl Eq for ScheduledHookMap {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrontabState {
    pub tasks: BTreeMap<CrontabTaskMethod, CrontabTaskState>,
    pub hooks: ScheduledHookMap,
}

impl Default for CrontabState {
    fn default() -> Self {
        Self {
            tasks: BTreeMap::from([(
                CrontabTaskMethod::HubRebalance,
                CrontabTaskState {
                    method: CrontabTaskMethod::HubRebalance,
                    interval_ms: 1_000,
                    last_run: 0,
                    enabled: true,
                    params: BTreeMap::new(),
                },
            )]),
            hooks: ScheduledHookMap::empty(),
        }
    }
}
