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
    /// Entity-owned Account envelope mutations produced by scheduled hooks.
    /// They are applied by the same Account stage as ordinary Entity inputs.
    pub account_envelope_mutations: Vec<(String, crate::AccountEnvelopeMutation)>,
}

pub struct CrontabExecutionContext<'a> {
    pub expected_proposer_signer_id: &'a str,
    pub now: u64,
    /// Committed HTLC locks whose timelock has passed, in (timelock, lockId)
    /// order; derived from Account state by the caller, never from hooks.
    pub expired_htlc_locks: &'a [(String, String)],
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

fn replace_object_bool(
    value: &CanonicalValue,
    field: &'static str,
    next: bool,
) -> Result<CanonicalValue, SchedulerError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(SchedulerError::InvalidWake {
            detail: format!("ACTIVE_DISPUTE_{field}"),
        });
    };
    let mut fields = fields.clone();
    if let Some((_, value)) = fields.iter_mut().find(|(name, _)| name == field) {
        *value = CanonicalValue::Bool(next);
    } else {
        fields.push((field.to_string(), CanonicalValue::Bool(next)));
    }
    Ok(CanonicalValue::Object(fields))
}

fn dispute_finalize_queued_mutation(
    account_id: &str,
    view: &xln_rscore_batch::ResidentAccountDisputeView,
    active_dispute: &CanonicalValue,
    finalize_queued: bool,
) -> Result<(String, crate::AccountEnvelopeMutation), SchedulerError> {
    Ok((
        account_id.to_string(),
        crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: view.status.clone(),
            // TypeScript's replaceDisputeLifecycle omits disputePrepare here,
            // which canonically deletes it rather than preserving stale setup.
            dispute_prepare: None,
            active_dispute: Some(replace_object_bool(
                active_dispute,
                "finalizeQueued",
                finalize_queued,
            )?),
        },
    ))
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
        expired_htlc_locks,
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

    let expired_locks = expired_htlc_locks.to_vec();
    if let Some(hashlock) = secret_acks_requiring_dispute.iter().next() {
        return Err(SchedulerError::SecretAckDisputeUnsupported {
            hashlock: hashlock.clone(),
        });
    }
    let mut dispute_finalize_planned = false;
    let mut dispute_broadcast_planned = false;
    let mut commands = Vec::new();
    let mut account_envelope_mutations = Vec::new();
    for hook in &due_hooks {
        match &hook.kind {
            ScheduledHookKind::HubRebalanceKick { .. } => {
                let task = next.tasks.get_mut(&CrontabTaskMethod::HubRebalance).ok_or(
                    SchedulerError::UnsupportedTask {
                        method: "hubRebalance".to_string(),
                    },
                )?;
                task.last_run = 0;
            }
            // TypeScript intentionally treats these two legacy hooks as no-op.
            ScheduledHookKind::SettlementWindow | ScheduledHookKind::Watchdog => {}
            ScheduledHookKind::DisputeDeadline { account_id } => {
                let Some(view) = dispute_views.get(account_id) else {
                    continue;
                };
                let Some(active) = view.active_dispute.as_ref() else {
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
                if let Some(sent) = sent {
                    let sent_has_finalize = batch_has_dispute_finalization(&sent.batch, account_id);
                    account_envelope_mutations.push(dispute_finalize_queued_mutation(
                        account_id,
                        view,
                        active,
                        sent_has_finalize || object_bool(active, "finalizeQueued") == Some(true),
                    )?);
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
                    account_envelope_mutations.push(dispute_finalize_queued_mutation(
                        account_id, view, active, true,
                    )?);
                    if !dispute_broadcast_planned {
                        dispute_broadcast_planned = true;
                        commands.push(SchedulerCommand::BroadcastQueuedDisputeFinalization);
                    }
                } else {
                    if object_bool(active, "finalizeQueued") == Some(true) {
                        account_envelope_mutations.push(dispute_finalize_queued_mutation(
                            account_id, view, active, false,
                        )?);
                    }
                    if dispute_finalize_planned {
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
                        .map_err(|error| {
                            SchedulerError::HookCommitment {
                                detail: error.to_string(),
                            }
                        })?;
                    } else {
                        dispute_finalize_planned = true;
                        commands.push(SchedulerCommand::AutoFinalizeDispute {
                            counterparty_entity_id: account_id.clone(),
                        });
                    }
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
        // Pending-work membership only decides whether Runtime synthesizes a
        // wake. Once a signed due wake is accepted, TS executes the task and
        // advances `lastRun` even if Stage 1 consumed the last Account item.
        if !task.enabled {
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
        account_envelope_mutations,
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

    fn dispute_view_with_finalize_queued(
        finalize_queued: bool,
    ) -> xln_rscore_batch::ResidentAccountDisputeView {
        let mut view = dispute_view(true, 9);
        let Some(CanonicalValue::Object(fields)) = view.active_dispute.as_mut() else {
            panic!("active dispute fixture");
        };
        fields.push((
            "finalizeQueued".into(),
            CanonicalValue::Bool(finalize_queued),
        ));
        view
    }

    fn final_dispute(counterentity: [u8; 32]) -> crate::j_batch::FinalDisputeProof {
        crate::j_batch::FinalDisputeProof {
            counterentity,
            initial_nonce: ethabi::ethereum_types::U256::zero(),
            final_nonce: ethabi::ethereum_types::U256::from(1),
            proposer_is_left: true,
            initial_proofbody_hash: [0x44; 32],
            final_proofbody: crate::j_batch::ProofBody {
                watch_seed: [0x55; 32],
                left_response_seconds: 1,
                right_response_seconds: 1,
                offdeltas: Vec::new(),
                token_ids: Vec::new(),
                transformers: Vec::new(),
            },
            starter_arguments: Vec::new(),
            other_arguments: Vec::new(),
            sig: vec![0x66; 65],
            started_by_left: true,
            cooperative: false,
            submit_not_before_timestamp: None,
        }
    }

    #[test]
    fn derived_htlc_timeouts_drain_in_caller_order_not_only_diagnostic_prefix() {
        let state = state();
        let expired = [
            ("account-a".to_string(), "a".to_string()),
            ("account-b".to_string(), "b".to_string()),
        ];
        let result = execute_crontab(
            &state,
            &wake(vec![ScheduledWakeJob {
                kind: ScheduledWakeJobKind::Hook,
                id: "htlc-timeout:a".to_string(),
                due_at: 800,
            }]),
            CrontabExecutionContext {
                expected_proposer_signer_id: "HUB",
                now: 1_000,
                expired_htlc_locks: &expired,
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
                expired_locks: expired.to_vec(),
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
                expired_htlc_locks: &[],
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
                expired_htlc_locks: &[],
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
                expired_htlc_locks: &[],
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([("peer".into(), dispute_view(true, 9))]),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("ready deadline");
        assert_eq!(
            ready.commands,
            vec![
                SchedulerCommand::AutoFinalizeDispute {
                    counterparty_entity_id: "peer".into(),
                },
                SchedulerCommand::HubRebalance,
            ]
        );
        assert_eq!(
            ready
                .crontab
                .tasks
                .get(&CrontabTaskMethod::HubRebalance)
                .expect("hub task")
                .last_run,
            10_000,
        );
        assert!(!ready.crontab.hooks.contains_key("dispute-deadline:peer"));
    }

    #[test]
    fn exact_h2002_dispute_deadline_retries_without_envelope_mutation() {
        const NOW: u64 = 1_788_305_492_894;
        const ACCOUNT: &str = "0xaf20cc5f04ae693bc4a558e550aa391753a86d5b8faee49a5040d0c7edd75aff";
        const PROPOSER: &str = "0xc65745c5f0bbec9cb6dd3726daf375c38f488fb6";
        let mut state = state();
        state.tasks.clear();
        add_hook(
            &mut state,
            ScheduledHook {
                id: format!("dispute-deadline:{ACCOUNT}"),
                trigger_at: NOW,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: ACCOUNT.into(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, NOW, false).expect("H2002 jobs");
        let result = execute_crontab(
            &state,
            &ScheduledWake {
                version: 1,
                proposer_signer_id: PROPOSER.into(),
                due_at: NOW,
                jobs,
            },
            CrontabExecutionContext {
                expected_proposer_signer_id: PROPOSER,
                now: NOW,
                expired_htlc_locks: &[],
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([(
                    ACCOUNT.into(),
                    dispute_view(true, 1_788_395_489),
                )]),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("exact H2002 execution");
        assert!(result.commands.is_empty());
        assert!(result.account_envelope_mutations.is_empty());
        assert_eq!(
            result
                .crontab
                .hooks
                .iter()
                .find(|(_, hook)| hook.id == format!("dispute-deadline:{ACCOUNT}"))
                .map(|(_, hook)| hook.trigger_at),
            Some(NOW + 1_000),
        );
    }

    #[test]
    fn dispute_deadline_clears_stale_finalize_latch_before_auto_finalize() {
        let mut state = state();
        state.tasks.clear();
        add_hook(
            &mut state,
            ScheduledHook {
                id: "dispute-deadline:peer".into(),
                trigger_at: 10_000,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: "peer".into(),
                },
            },
        );
        let jobs = collect_due_scheduled_wake_jobs(&state, 10_000, false).expect("due jobs");
        let result = execute_crontab(
            &state,
            &wake(jobs),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 10_000,
                expired_htlc_locks: &[],
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([(
                    "peer".into(),
                    dispute_view_with_finalize_queued(true),
                )]),
                j_batch_state: None,
                dispute_auto_finalize: true,
            },
        )
        .expect("clear stale finalize latch");
        assert_eq!(
            result.commands,
            vec![SchedulerCommand::AutoFinalizeDispute {
                counterparty_entity_id: "peer".into(),
            }]
        );
        let [
            (
                account_id,
                crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                    status,
                    dispute_prepare,
                    active_dispute: Some(active),
                },
            ),
        ] = result.account_envelope_mutations.as_slice()
        else {
            panic!("one lifecycle mutation");
        };
        assert_eq!(account_id, "peer");
        assert_eq!(status, "disputed");
        assert_eq!(dispute_prepare, &None);
        assert_eq!(object_bool(active, "finalizeQueued"), Some(false));
    }

    #[test]
    fn dispute_deadline_sets_latch_for_queued_draft_before_broadcast() {
        let account_word = [0x22; 32];
        let account_id = format!("0x{}", hex::encode(account_word));
        let mut state = state();
        state.tasks.clear();
        add_hook(
            &mut state,
            ScheduledHook {
                id: format!("dispute-deadline:{account_id}"),
                trigger_at: 10_000,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: account_id.clone(),
                },
            },
        );
        let mut j_batch_state = JBatchState::default();
        j_batch_state
            .batch
            .dispute_finalizations
            .push(final_dispute(account_word));
        let result = execute_crontab(
            &state,
            &wake(collect_due_scheduled_wake_jobs(&state, 10_000, false).expect("due jobs")),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 10_000,
                expired_htlc_locks: &[],
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([(
                    account_id.clone(),
                    dispute_view_with_finalize_queued(false),
                )]),
                j_batch_state: Some(&j_batch_state),
                dispute_auto_finalize: true,
            },
        )
        .expect("queued draft deadline");
        assert_eq!(
            result.commands,
            vec![SchedulerCommand::BroadcastQueuedDisputeFinalization]
        );
        let [
            (
                mutated_account,
                crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                    active_dispute: Some(active),
                    ..
                },
            ),
        ] = result.account_envelope_mutations.as_slice()
        else {
            panic!("one queued lifecycle mutation");
        };
        assert_eq!(mutated_account, &account_id);
        assert_eq!(object_bool(active, "finalizeQueued"), Some(true));
    }

    #[test]
    fn dispute_deadline_materializes_latch_while_any_batch_is_sent() {
        let account_id = format!("0x{}", hex::encode([0x22; 32]));
        let mut state = state();
        state.tasks.clear();
        add_hook(
            &mut state,
            ScheduledHook {
                id: format!("dispute-deadline:{account_id}"),
                trigger_at: 10_000,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: account_id.clone(),
                },
            },
        );
        let j_batch_state = JBatchState {
            sent_batch: Some(crate::j_batch::SentJBatch {
                batch: JBatch::default(),
                batch_hash: [0; 32],
                encoded_batch: Vec::new(),
                entity_nonce: 1,
                first_submitted_at: 1,
                last_submitted_at: 1,
                submit_attempts: 1,
                fee_overrides: None,
                transaction_hash: None,
                last_failure: None,
                terminal_failure: None,
            }),
            ..Default::default()
        };
        let result = execute_crontab(
            &state,
            &wake(collect_due_scheduled_wake_jobs(&state, 10_000, false).expect("due jobs")),
            CrontabExecutionContext {
                expected_proposer_signer_id: "hub",
                now: 10_000,
                expired_htlc_locks: &[],
                secret_acks_requiring_dispute: &BTreeSet::new(),
                dispute_views: &BTreeMap::from([(account_id.clone(), dispute_view(true, 9))]),
                j_batch_state: Some(&j_batch_state),
                dispute_auto_finalize: true,
            },
        )
        .expect("sent batch deadline");
        assert!(result.commands.is_empty());
        let [
            (
                mutated_account,
                crate::AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                    active_dispute: Some(active),
                    ..
                },
            ),
        ] = result.account_envelope_mutations.as_slice()
        else {
            panic!("one sent lifecycle mutation");
        };
        assert_eq!(mutated_account, &account_id);
        assert_eq!(object_bool(active, "finalizeQueued"), Some(false));
        assert_eq!(
            result
                .crontab
                .hooks
                .iter()
                .find(|(_, hook)| hook.id == format!("dispute-deadline:{account_id}"))
                .map(|(_, hook)| hook.trigger_at),
            Some(11_000),
        );
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
                expired_htlc_locks: &[],
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
            ScheduledHook {
                id: "dispute-deadline:account-a".to_string(),
                trigger_at: 800,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: "account-a".to_string(),
                },
            },
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
                expired_htlc_locks: &[],
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
