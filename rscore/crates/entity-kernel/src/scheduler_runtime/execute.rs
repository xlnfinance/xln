use std::cmp::Ordering;
use std::collections::BTreeSet;

use thiserror::Error;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::scheduler::{CrontabState, CrontabTaskMethod, ScheduledHook, ScheduledHookKind};
use crate::{CanonicalEntityTx, EntityTxKind};

pub const MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ScheduledWakeJobKind {
    Hook,
    Task,
}

impl ScheduledWakeJobKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::Task => "task",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledWakeJob {
    pub kind: ScheduledWakeJobKind,
    pub id: String,
    pub due_at: u64,
}

impl Ord for ScheduledWakeJob {
    fn cmp(&self, other: &Self) -> Ordering {
        self.due_at
            .cmp(&other.due_at)
            .then_with(|| self.kind.as_str().cmp(other.kind.as_str()))
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for ScheduledWakeJob {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledWake {
    pub version: u8,
    pub proposer_signer_id: String,
    pub due_at: u64,
    /// A bounded diagnostic prefix. Execution never trusts this list.
    pub jobs: Vec<ScheduledWakeJob>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchedulerCommand {
    ProcessHtlcTimeouts {
        expired_locks: Vec<(String, String)>,
    },
    HubRebalance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerExecution {
    pub crontab: CrontabState,
    pub commands: Vec<SchedulerCommand>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SchedulerError {
    #[error("SCHEDULED_WAKE_PROPOSER_MISMATCH")]
    ProposerMismatch,
    #[error("SCHEDULED_WAKE_INVALID_PAYLOAD:{detail}")]
    InvalidWake { detail: String },
    #[error("CRONTAB_TIMESTAMP_OVERFLOW:{method}")]
    TimestampOverflow { method: &'static str },
    #[error("CRONTAB_TASK_UNSUPPORTED:{method}")]
    UnsupportedTask { method: String },
    #[error("CRONTAB_HOOK_UNSUPPORTED:{kind}:{id}")]
    UnsupportedHook { kind: &'static str, id: String },
    #[error("HTLC_SECRET_ACK_DISPUTE_UNSUPPORTED:{hashlock}")]
    SecretAckDisputeUnsupported { hashlock: String },
    #[error("CRONTAB_HOOK_KEY_MISMATCH:key={key}:id={id}")]
    HookKeyMismatch { key: String, id: String },
}

fn task_due_at(last_run: u64, interval_ms: u64) -> Result<u64, SchedulerError> {
    last_run
        .checked_add(interval_ms)
        .ok_or(SchedulerError::TimestampOverflow {
            method: "hubRebalance",
        })
}

fn canonical_number(field: &'static str, value: u64) -> Result<CanonicalValue, SchedulerError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| SchedulerError::InvalidWake {
            detail: field.to_string(),
        })
}

/// Exact consensus transaction synthesized by Runtime for Entity
/// certification. This is data-only; executing it still requires
/// `execute_crontab` against the pre-command Entity state.
pub fn scheduled_wake_entity_tx(wake: &ScheduledWake) -> Result<CanonicalEntityTx, SchedulerError> {
    let jobs = wake
        .jobs
        .iter()
        .map(|job| {
            Ok(CanonicalValue::Object(vec![
                (
                    "kind".to_string(),
                    CanonicalValue::String(job.kind.as_str().to_string()),
                ),
                ("id".to_string(), CanonicalValue::String(job.id.clone())),
                (
                    "dueAt".to_string(),
                    canonical_number("job.dueAt", job.due_at)?,
                ),
            ]))
        })
        .collect::<Result<Vec<_>, SchedulerError>>()?;
    let data = CanonicalValue::Object(vec![
        (
            "version".to_string(),
            canonical_number("version", u64::from(wake.version))?,
        ),
        (
            "proposerSignerId".to_string(),
            CanonicalValue::String(wake.proposer_signer_id.clone()),
        ),
        ("dueAt".to_string(), canonical_number("dueAt", wake.due_at)?),
        ("jobs".to_string(), CanonicalValue::Array(jobs)),
    ]);
    CanonicalEntityTx::from_frame_projection(EntityTxKind::ScheduledWake, data).map_err(|_| {
        SchedulerError::InvalidWake {
            detail: "ENTITY_TX_PROJECTION".to_string(),
        }
    })
}

/// Canonical Runtime-side due-set calculation. The full set is sorted by
/// `(dueAt, kind, id)` exactly like TypeScript; callers may put only the first
/// 1,000 rows in a signed diagnostic wake.
pub fn collect_due_scheduled_wake_jobs(
    state: &CrontabState,
    now: u64,
    hub_rebalance_has_pending_work: bool,
) -> Result<Vec<ScheduledWakeJob>, SchedulerError> {
    for (key, hook) in &state.hooks {
        if key != &hook.id {
            return Err(SchedulerError::HookKeyMismatch {
                key: key.clone(),
                id: hook.id.clone(),
            });
        }
    }
    let mut jobs = state
        .hooks
        .values()
        .filter(|hook| hook.trigger_at <= now)
        .map(|hook| ScheduledWakeJob {
            kind: ScheduledWakeJobKind::Hook,
            id: hook.id.clone(),
            due_at: hook.trigger_at,
        })
        .collect::<Vec<_>>();

    for task in state.tasks.values() {
        if !task.enabled || !hub_rebalance_has_pending_work {
            continue;
        }
        match task.method {
            CrontabTaskMethod::HubRebalance => {
                let due_at = task_due_at(task.last_run, task.interval_ms)?;
                if due_at <= now {
                    jobs.push(ScheduledWakeJob {
                        kind: ScheduledWakeJobKind::Task,
                        id: task.method.as_str().to_string(),
                        due_at,
                    });
                }
            }
        }
    }
    jobs.sort();
    Ok(jobs)
}

pub(crate) fn validate_scheduled_wake(
    wake: &ScheduledWake,
    expected_proposer_signer_id: &str,
    now: u64,
) -> Result<(), SchedulerError> {
    if !wake
        .proposer_signer_id
        .eq_ignore_ascii_case(expected_proposer_signer_id)
    {
        return Err(SchedulerError::ProposerMismatch);
    }
    if wake.version != 1
        || wake.jobs.is_empty()
        || wake.jobs.len() > MAX_SCHEDULED_WAKE_DIAGNOSTIC_JOBS
        || wake.due_at > now
    {
        return Err(SchedulerError::InvalidWake {
            detail: "HEADER".to_string(),
        });
    }
    let mut canonical = wake.jobs.clone();
    canonical.sort();
    if canonical != wake.jobs || canonical[0].due_at != wake.due_at {
        return Err(SchedulerError::InvalidWake {
            detail: "ORDER".to_string(),
        });
    }
    let mut unique = BTreeSet::new();
    for job in &wake.jobs {
        if job.id.is_empty()
            || job.id.len() > 256
            || job.due_at > now
            || !unique.insert((job.kind, job.id.as_str(), job.due_at))
        {
            return Err(SchedulerError::InvalidWake {
                detail: "JOB".to_string(),
            });
        }
    }
    Ok(())
}

fn unsupported_hook(hook: &ScheduledHook, kind: &'static str) -> SchedulerError {
    SchedulerError::UnsupportedHook {
        kind,
        id: hook.id.clone(),
    }
}

/// Execute one signed scheduled wake atomically.
///
/// A clone is mutated and returned only on success. In particular, a due
/// dispute/cross-j hook cannot be removed from live state before its explicit
/// unsupported error reaches the Runtime.
pub fn execute_crontab(
    state: &CrontabState,
    wake: &ScheduledWake,
    expected_proposer_signer_id: &str,
    now: u64,
    hub_rebalance_has_pending_work: bool,
    active_htlc_locks: &BTreeSet<(String, String)>,
    secret_acks_requiring_dispute: &BTreeSet<String>,
) -> Result<SchedulerExecution, SchedulerError> {
    validate_scheduled_wake(wake, expected_proposer_signer_id, now)?;
    let mut next = state.clone();
    let mut due_hooks = next
        .hooks
        .values()
        .filter(|hook| hook.trigger_at <= now)
        .cloned()
        .collect::<Vec<_>>();
    due_hooks.sort_by(|left, right| {
        left.trigger_at
            .cmp(&right.trigger_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut expired_locks = Vec::new();
    let mut force_hub_rebalance = false;
    for hook in &due_hooks {
        match &hook.kind {
            ScheduledHookKind::HtlcTimeout {
                account_id,
                lock_id,
            } => {
                if active_htlc_locks.contains(&(account_id.clone(), lock_id.clone())) {
                    expired_locks.push((account_id.clone(), lock_id.clone()));
                }
            }
            ScheduledHookKind::HtlcSecretAckTimeout { hashlock, .. } => {
                if secret_acks_requiring_dispute.contains(hashlock) {
                    return Err(SchedulerError::SecretAckDisputeUnsupported {
                        hashlock: hashlock.clone(),
                    });
                }
            }
            ScheduledHookKind::HubRebalanceKick { .. } => {
                let task = next.tasks.get_mut(&CrontabTaskMethod::HubRebalance).ok_or(
                    SchedulerError::UnsupportedTask {
                        method: "hubRebalance".to_string(),
                    },
                )?;
                task.last_run = 0;
                force_hub_rebalance = true;
            }
            // TypeScript intentionally treats these two legacy hooks as no-op.
            ScheduledHookKind::SettlementWindow | ScheduledHookKind::Watchdog => {}
            ScheduledHookKind::DisputeDeadline { .. } => {
                return Err(unsupported_hook(hook, "dispute_deadline"));
            }
            ScheduledHookKind::CrossJOrderbookSweep { .. } => {
                return Err(unsupported_hook(hook, "cross_j_orderbook_sweep"));
            }
            ScheduledHookKind::BoardHankoRefresh { .. } => {
                return Err(unsupported_hook(hook, "board_hanko_refresh"));
            }
            ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline { .. } => {
                return Err(unsupported_hook(
                    hook,
                    "counterparty_board_hanko_refresh_deadline",
                ));
            }
        }
    }

    for hook in &due_hooks {
        next.hooks.remove(&hook.id);
    }
    let mut commands = Vec::new();
    if !expired_locks.is_empty() {
        commands.push(SchedulerCommand::ProcessHtlcTimeouts { expired_locks });
    }

    // Periodic tasks execute after hooks, so a due kick above is visible in
    // this same pass. Updating last_run after the handler matches TypeScript.
    for task in next.tasks.values_mut() {
        if !task.enabled || (!hub_rebalance_has_pending_work && !force_hub_rebalance) {
            continue;
        }
        match task.method {
            CrontabTaskMethod::HubRebalance => {
                if task_due_at(task.last_run, task.interval_ms)? <= now {
                    commands.push(SchedulerCommand::HubRebalance);
                    task.last_run = now;
                }
            }
        }
    }
    Ok(SchedulerExecution {
        crontab: next,
        commands,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use xln_rscore_protocol::encode_canonical_consensus_bytes;

    use super::*;
    use crate::scheduler::{CrontabTaskParam, CrontabTaskState};

    fn state() -> CrontabState {
        CrontabState {
            tasks: BTreeMap::from([(
                CrontabTaskMethod::HubRebalance,
                CrontabTaskState {
                    method: CrontabTaskMethod::HubRebalance,
                    interval_ms: 1_000,
                    last_run: 100,
                    enabled: true,
                    params: BTreeMap::<String, CrontabTaskParam>::new(),
                },
            )]),
            hooks: BTreeMap::new(),
        }
    }

    fn wake(jobs: Vec<ScheduledWakeJob>) -> ScheduledWake {
        ScheduledWake {
            version: 1,
            proposer_signer_id: "hub".to_string(),
            due_at: jobs[0].due_at,
            jobs,
        }
    }

    #[test]
    fn recomputes_and_drains_all_due_hooks_not_only_diagnostic_prefix() {
        let mut state = state();
        state.hooks.insert(
            "htlc-timeout:b".to_string(),
            ScheduledHook::htlc_timeout("account-b".to_string(), "b".to_string(), 900),
        );
        state.hooks.insert(
            "htlc-timeout:a".to_string(),
            ScheduledHook::htlc_timeout("account-a".to_string(), "a".to_string(), 800),
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_000, false).expect("due jobs");
        let result = execute_crontab(
            &state,
            &wake(vec![jobs[0].clone()]),
            "HUB",
            1_000,
            false,
            &BTreeSet::from([
                ("account-a".to_string(), "a".to_string()),
                ("account-b".to_string(), "b".to_string()),
            ]),
            &BTreeSet::new(),
        )
        .expect("execution");
        assert!(result.crontab.hooks.is_empty());
        assert_eq!(
            result.commands,
            vec![SchedulerCommand::ProcessHtlcTimeouts {
                expired_locks: vec![
                    ("account-a".to_string(), "a".to_string()),
                    ("account-b".to_string(), "b".to_string()),
                ],
            }]
        );
    }

    #[test]
    fn unsupported_hook_does_not_consume_any_hook() {
        let mut state = state();
        state.hooks.insert(
            "dispute:x".to_string(),
            ScheduledHook {
                id: "dispute:x".to_string(),
                trigger_at: 10,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: "x".to_string(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 10, false).expect("due jobs");
        let error = execute_crontab(
            &state,
            &wake(jobs),
            "hub",
            10,
            false,
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect_err("unsupported dispute");
        assert!(matches!(error, SchedulerError::UnsupportedHook { .. }));
        assert!(state.hooks.contains_key("dispute:x"));
    }

    #[test]
    fn hook_kick_runs_rebalance_in_the_same_pass() {
        let mut state = state();
        state.hooks.insert(
            "kick:x".to_string(),
            ScheduledHook {
                id: "kick:x".to_string(),
                trigger_at: 1_500,
                kind: ScheduledHookKind::HubRebalanceKick {
                    reason: "test".to_string(),
                    counterparty_id: "x".to_string(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_500, true).expect("due jobs");
        let result = execute_crontab(
            &state,
            &wake(jobs),
            "hub",
            1_500,
            true,
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect("execution");
        assert_eq!(result.commands, vec![SchedulerCommand::HubRebalance]);
        assert_eq!(
            result
                .crontab
                .tasks
                .get(&CrontabTaskMethod::HubRebalance)
                .map(|task| task.last_run),
            Some(1_500),
        );
    }

    #[test]
    fn forged_wake_signer_is_rejected_without_consuming_crontab() {
        let mut state = state();
        state.hooks.insert(
            "htlc-timeout:a".to_string(),
            ScheduledHook::htlc_timeout("account-a".to_string(), "a".to_string(), 800),
        );
        let original = state.clone();
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_000, false).expect("due jobs");
        let mut forged = wake(jobs);
        forged.proposer_signer_id = "attacker".to_string();
        let error = execute_crontab(
            &state,
            &forged,
            "hub",
            1_000,
            false,
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect_err("forged signer");
        assert_eq!(error, SchedulerError::ProposerMismatch);
        assert_eq!(state, original);
    }

    #[test]
    fn scheduled_wake_entity_tx_matches_typescript_consensus_bytes() {
        let wake = ScheduledWake {
            version: 1,
            proposer_signer_id: "hub".to_string(),
            due_at: 1_700_000_060_000,
            jobs: vec![
                ScheduledWakeJob {
                    kind: ScheduledWakeJobKind::Hook,
                    id: "htlc-timeout:0xabab".to_string(),
                    due_at: 1_700_000_060_000,
                },
                ScheduledWakeJob {
                    kind: ScheduledWakeJobKind::Task,
                    id: "hubRebalance".to_string(),
                    due_at: 1_700_000_060_000,
                },
            ],
        };
        let tx = scheduled_wake_entity_tx(&wake).expect("scheduled wake tx");
        let value = CanonicalValue::Object(vec![
            (
                "type".to_string(),
                CanonicalValue::String(tx.kind.as_str().to_string()),
            ),
            ("data".to_string(), tx.data),
        ]);
        let mut bytes = vec![3_u8];
        bytes.extend(encode_canonical_consensus_bytes(&value).expect("canonical bytes"));
        assert_eq!(
            hex::encode(bytes),
            "03d4724092a464617461a474797065d4724194a56475654174a46a6f6273b070726f706f7365725369676e65724964a776657273696f6ecb4278bcfe6526000092d4724293a56475654174a26964a46b696e64cb4278bcfe65260000b368746c632d74696d656f75743a307861626162a4686f6f6b42cb4278bcfe65260000ac687562526562616c616e6365a47461736ba368756201ad7363686564756c656457616b65"
        );
    }
}
