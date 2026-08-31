use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::scheduler::{
    CrontabState, CrontabTaskMethod, ScheduledHook, ScheduledHookKind, cancel_hook, schedule_hook,
};
use crate::{CanonicalEntityTx, EntityTxKind, JBatch, JBatchState};

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
    AutoFinalizeDispute {
        counterparty_entity_id: String,
    },
    BroadcastQueuedDisputeFinalization,
    HubRebalance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerExecution {
    pub crontab: CrontabState,
    pub commands: Vec<SchedulerCommand>,
}

pub struct CrontabExecutionContext<'a> {
    pub expected_proposer_signer_id: &'a str,
    pub now: u64,
    pub hub_rebalance_has_pending_work: bool,
    pub active_htlc_locks: &'a BTreeSet<(String, String)>,
    pub secret_acks_requiring_dispute: &'a BTreeSet<String>,
    pub dispute_views: &'a BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    pub j_batch_state: Option<&'a JBatchState>,
    pub dispute_auto_finalize: bool,
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
    #[error("CRONTAB_HOOK_COMMITMENT:{detail}")]
    HookCommitment { detail: String },
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
    let mut jobs = state
        .hooks
        .due(now)
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

fn object_bool(value: &CanonicalValue, field: &str) -> Option<bool> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields.iter().find_map(|(name, value)| {
        (name == field)
            .then_some(value)
            .and_then(|value| match value {
                CanonicalValue::Bool(value) => Some(*value),
                _ => None,
            })
    })
}

fn object_u64(value: &CanonicalValue, field: &str) -> Option<u64> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields.iter().find_map(|(name, value)| {
        (name == field)
            .then_some(value)
            .and_then(|value| match value {
                CanonicalValue::Number(value) => value.as_str().parse().ok(),
                _ => None,
            })
    })
}

fn batch_has_dispute_finalization(batch: &JBatch, counterparty: &str) -> bool {
    let Ok(bytes) = hex::decode(counterparty.strip_prefix("0x").unwrap_or(counterparty)) else {
        return false;
    };
    let Ok(counterparty) = <[u8; 32]>::try_from(bytes.as_slice()) else {
        return false;
    };
    batch
        .dispute_finalizations
        .iter()
        .any(|row| row.counterentity == counterparty)
}

/// Execute one signed scheduled wake atomically.
///
/// A clone is mutated and returned only on success. In particular, a due
/// dispute/cross-j hook cannot be removed from live state before its explicit
/// unsupported error reaches the Runtime.
pub fn execute_crontab(
    state: &CrontabState,
    wake: &ScheduledWake,
    context: CrontabExecutionContext<'_>,
) -> Result<SchedulerExecution, SchedulerError> {
    let CrontabExecutionContext {
        expected_proposer_signer_id,
        now,
        hub_rebalance_has_pending_work,
        active_htlc_locks,
        secret_acks_requiring_dispute,
        dispute_views,
        j_batch_state,
        dispute_auto_finalize,
    } = context;
    validate_scheduled_wake(wake, expected_proposer_signer_id, now)?;
    let mut next = state.clone();
    let mut due_hooks = next.hooks.due(now).cloned().collect::<Vec<_>>();
    due_hooks.sort_by(|left, right| {
        left.trigger_at
            .cmp(&right.trigger_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    for hook in &due_hooks {
        cancel_hook(&mut next, &hook.id).map_err(|error| SchedulerError::HookCommitment {
            detail: error.to_string(),
        })?;
    }

    let mut expired_locks = Vec::new();
    let mut force_hub_rebalance = false;
    let mut dispute_finalize_planned = false;
    let mut commands = Vec::new();
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
            ScheduledHookKind::DisputeDeadline { account_id } => {
                let Some(active) = dispute_views
                    .get(account_id)
                    .and_then(|view| view.active_dispute.as_ref())
                else {
                    continue;
                };
                if !dispute_auto_finalize {
                    continue;
                }
                let retry_after = if object_bool(active, "observedOnChain") != Some(true) {
                    Some(5_000)
                } else {
                    let timeout = object_u64(active, "disputeTimeout").unwrap_or(0);
                    (timeout == 0 || now / 1_000 < timeout).then_some(1_000)
                };
                if let Some(delay) = retry_after {
                    schedule_hook(
                        &mut next,
                        ScheduledHook {
                            id: hook.id.clone(),
                            trigger_at: now.checked_add(delay).ok_or(
                                SchedulerError::TimestampOverflow {
                                    method: "disputeDeadline",
                                },
                            )?,
                            kind: hook.kind.clone(),
                        },
                    )
                    .map_err(|error| SchedulerError::HookCommitment {
                        detail: error.to_string(),
                    })?;
                    continue;
                }
                let sent = j_batch_state.and_then(|state| state.sent_batch.as_ref());
                if sent.is_some() {
                    schedule_hook(
                        &mut next,
                        ScheduledHook {
                            id: hook.id.clone(),
                            trigger_at: now.checked_add(1_000).ok_or(
                                SchedulerError::TimestampOverflow {
                                    method: "disputeDeadline",
                                },
                            )?,
                            kind: hook.kind.clone(),
                        },
                    )
                    .map_err(|error| SchedulerError::HookCommitment {
                        detail: error.to_string(),
                    })?;
                    continue;
                }
                let queued = j_batch_state.is_some_and(|state| {
                    batch_has_dispute_finalization(&state.batch, account_id)
                        || state
                            .recovery_batches
                            .iter()
                            .any(|batch| batch_has_dispute_finalization(batch, account_id))
                });
                if queued {
                    commands.push(SchedulerCommand::BroadcastQueuedDisputeFinalization);
                } else if dispute_finalize_planned {
                    schedule_hook(
                        &mut next,
                        ScheduledHook {
                            id: hook.id.clone(),
                            trigger_at: now.checked_add(1).ok_or(
                                SchedulerError::TimestampOverflow {
                                    method: "disputeDeadline",
                                },
                            )?,
                            kind: hook.kind.clone(),
                        },
                    )
                    .map_err(|error| SchedulerError::HookCommitment {
                        detail: error.to_string(),
                    })?;
                } else {
                    dispute_finalize_planned = true;
                    commands.push(SchedulerCommand::AutoFinalizeDispute {
                        counterparty_entity_id: account_id.clone(),
                    });
                }
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
            hooks: crate::ScheduledHookMap::empty(),
        }
    }

    fn add_hook(state: &mut CrontabState, hook: ScheduledHook) {
        crate::schedule_hook(state, hook).expect("schedule test hook");
    }

    fn wake(jobs: Vec<ScheduledWakeJob>) -> ScheduledWake {
        ScheduledWake {
            version: 1,
            proposer_signer_id: "hub".to_string(),
            due_at: jobs[0].due_at,
            jobs,
        }
    }

    fn dispute_view(
        observed_on_chain: bool,
        dispute_timeout: u64,
    ) -> xln_rscore_batch::ResidentAccountDisputeView {
        xln_rscore_batch::ResidentAccountDisputeView {
            status: "disputed".into(),
            dispute_prepare: None,
            active_dispute: Some(CanonicalValue::Object(vec![
                (
                    "observedOnChain".into(),
                    CanonicalValue::Bool(observed_on_chain),
                ),
                (
                    "disputeTimeout".into(),
                    CanonicalValue::Number(
                        CanonicalNumber::try_from_u64(dispute_timeout).expect("timeout"),
                    ),
                ),
            ])),
            local_dispute: None,
            counterparty_dispute: None,
            proof_body: Ok(xln_rscore_engine::DisputeProofBody {
                watch_seed: [0; 32],
                left_response_seconds: 0,
                right_response_seconds: 0,
                offdeltas: Vec::new(),
                token_ids: Vec::new(),
                transformers: Vec::new(),
            }),
            j_nonce: 0,
            owner_is_left: true,
            delta_transformer: None,
            payment_hashlocks: Vec::new(),
            pull_ids: Vec::new(),
            pull_count: 0,
            swap_offers: Vec::new(),
            pending_swap_fill_ratios: BTreeMap::new(),
        }
    }

    #[test]
    fn recomputes_and_drains_all_due_hooks_not_only_diagnostic_prefix() {
        let mut state = state();
        add_hook(
            &mut state,
            ScheduledHook::htlc_timeout("account-b".to_string(), "b".to_string(), 900),
        );
        add_hook(
            &mut state,
            ScheduledHook::htlc_timeout("account-a".to_string(), "a".to_string(), 800),
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_000, false).expect("due jobs");
        let result = execute_crontab(
            &state,
            &wake(vec![jobs[0].clone()]),
            CrontabExecutionContext {
                expected_proposer_signer_id: "HUB",
                now: 1_000,
                hub_rebalance_has_pending_work: false,
                active_htlc_locks: &BTreeSet::from([
                    ("account-a".to_string(), "a".to_string()),
                    ("account-b".to_string(), "b".to_string()),
                ]),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::new(),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
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
    fn stale_dispute_deadline_is_consumed_without_an_active_dispute() {
        let mut state = state();
        add_hook(
            &mut state,
            ScheduledHook {
                id: "dispute:x".to_string(),
                trigger_at: 10,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: "x".to_string(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 10, false).expect("due jobs");
        let result = execute_crontab(
            &state,
            &wake(jobs),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 10,
                hub_rebalance_has_pending_work: false,
                active_htlc_locks: &BTreeSet::new(),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::new(),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("stale dispute hook");
        assert!(result.commands.is_empty());
        assert!(!result.crontab.hooks.contains_key("dispute:x"));
    }

    #[test]
    fn dispute_deadline_retries_then_queues_canonical_finalize() {
        let mut state = state();
        add_hook(
            &mut state,
            ScheduledHook {
                id: "dispute-deadline:peer".into(),
                trigger_at: 1_000,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: "peer".into(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_000, false).expect("due jobs");
        let waiting = execute_crontab(
            &state,
            &wake(jobs),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 1_000,
                hub_rebalance_has_pending_work: false,
                active_htlc_locks: &BTreeSet::new(),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([("peer".into(), dispute_view(false, 9))]),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("waiting deadline");
        assert!(waiting.commands.is_empty());
        assert_eq!(
            waiting
                .crontab
                .hooks
                .iter()
                .find(|(_, hook)| hook.id == "dispute-deadline:peer")
                .map(|(_, hook)| hook.trigger_at),
            Some(6_000),
        );

        let jobs = collect_due_scheduled_wake_jobs(&state, 10_000, false).expect("due jobs");
        let ready = execute_crontab(
            &state,
            &wake(jobs),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 10_000,
                hub_rebalance_has_pending_work: false,
                active_htlc_locks: &BTreeSet::new(),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([("peer".into(), dispute_view(true, 9))]),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("ready deadline");
        assert_eq!(
            ready.commands,
            vec![SchedulerCommand::AutoFinalizeDispute {
                counterparty_entity_id: "peer".into(),
            }]
        );
        assert!(!ready.crontab.hooks.contains_key("dispute-deadline:peer"));
    }

    #[test]
    fn hook_kick_runs_rebalance_in_the_same_pass() {
        let mut state = state();
        add_hook(
            &mut state,
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
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 1_500,
                hub_rebalance_has_pending_work: true,
                active_htlc_locks: &BTreeSet::new(),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::new(),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
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
        add_hook(
            &mut state,
            ScheduledHook::htlc_timeout("account-a".to_string(), "a".to_string(), 800),
        );
        let original = state.clone();
        let jobs = collect_due_scheduled_wake_jobs(&state, 1_000, false).expect("due jobs");
        let mut forged = wake(jobs);
        forged.proposer_signer_id = "attacker".to_string();
        let error = execute_crontab(
            &state,
            &forged,
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 1_000,
                hub_rebalance_has_pending_work: false,
                active_htlc_locks: &BTreeSet::new(),
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::new(),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
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
            (
                "data".to_string(),
                tx.frame_data().expect("scheduled wake frame data").clone(),
            ),
        ]);
        let mut bytes = vec![3_u8];
        bytes.extend(encode_canonical_consensus_bytes(&value).expect("canonical bytes"));
        assert_eq!(
            hex::encode(bytes),
            "03d4724092a464617461a474797065d4724194a56475654174a46a6f6273b070726f706f7365725369676e65724964a776657273696f6ecb4278bcfe6526000092d4724293a56475654174a26964a46b696e64cb4278bcfe65260000b368746c632d74696d656f75743a307861626162a4686f6f6b42cb4278bcfe65260000ac687562526562616c616e6365a47461736ba368756201ad7363686564756c656457616b65"
        );
    }
}
