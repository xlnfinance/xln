use std::collections::BTreeMap;

use xln_rscore_protocol::CanonicalNumber;

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
pub enum ScheduledHookKind {
    HtlcTimeout {
        account_id: String,
        lock_id: String,
    },
    DisputeDeadline {
        account_id: String,
    },
    HtlcSecretAckTimeout {
        hashlock: String,
        counterparty_entity_id: String,
        inbound_lock_id: String,
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

impl ScheduledHook {
    pub fn htlc_timeout(account_id: String, lock_id: String, trigger_at: u64) -> Self {
        Self {
            id: format!("htlc-timeout:{lock_id}"),
            trigger_at,
            kind: ScheduledHookKind::HtlcTimeout {
                account_id,
                lock_id,
            },
        }
    }

    pub fn htlc_secret_ack_timeout(
        hashlock: String,
        counterparty_entity_id: String,
        inbound_lock_id: String,
        trigger_at: u64,
    ) -> Self {
        Self {
            id: format!("htlc-secret-ack:{hashlock}"),
            trigger_at,
            kind: ScheduledHookKind::HtlcSecretAckTimeout {
                hashlock,
                counterparty_entity_id,
                inbound_lock_id,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrontabState {
    pub tasks: BTreeMap<CrontabTaskMethod, CrontabTaskState>,
    pub hooks: BTreeMap<String, ScheduledHook>,
}
