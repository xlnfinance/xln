use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::EntityKernelError;

use super::{CrontabState, CrontabTaskParam, ScheduledHook, ScheduledHookKind};

fn number(field: &'static str, value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| EntityKernelError::CommitmentUnsafeNumber { field, value })
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn task_param(value: &CrontabTaskParam) -> CanonicalValue {
    match value {
        CrontabTaskParam::String(value) => CanonicalValue::String(value.clone()),
        CrontabTaskParam::Number(value) => CanonicalValue::Number(value.clone()),
        CrontabTaskParam::Bool(value) => CanonicalValue::Bool(*value),
    }
}

fn hook_data(hook: &ScheduledHookKind) -> Result<CanonicalValue, EntityKernelError> {
    let values = match hook {
        ScheduledHookKind::HtlcTimeout {
            account_id,
            lock_id,
        } => vec![
            ("accountId", CanonicalValue::String(account_id.clone())),
            ("lockId", CanonicalValue::String(lock_id.clone())),
        ],
        ScheduledHookKind::DisputeDeadline { account_id } => {
            vec![("accountId", CanonicalValue::String(account_id.clone()))]
        }
        ScheduledHookKind::HtlcSecretAckTimeout {
            hashlock,
            counterparty_entity_id,
            inbound_lock_id,
        } => vec![
            ("hashlock", CanonicalValue::String(hashlock.clone())),
            (
                "counterpartyEntityId",
                CanonicalValue::String(counterparty_entity_id.clone()),
            ),
            (
                "inboundLockId",
                CanonicalValue::String(inbound_lock_id.clone()),
            ),
        ],
        ScheduledHookKind::SettlementWindow | ScheduledHookKind::Watchdog => Vec::new(),
        ScheduledHookKind::HubRebalanceKick {
            reason,
            counterparty_id,
        } => vec![
            ("reason", CanonicalValue::String(reason.clone())),
            (
                "counterpartyId",
                CanonicalValue::String(counterparty_id.clone()),
            ),
        ],
        ScheduledHookKind::BoardHankoRefresh {
            activation_j_height,
            activation_log_index,
            after_counterparty_id,
        } => vec![
            (
                "activationJHeight",
                number("activationJHeight", *activation_j_height)?,
            ),
            (
                "activationLogIndex",
                number("activationLogIndex", *activation_log_index)?,
            ),
            (
                "afterCounterpartyId",
                CanonicalValue::String(after_counterparty_id.clone()),
            ),
        ],
        ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline {
            account_id,
            activation_j_height,
            activation_log_index,
        } => vec![
            ("accountId", CanonicalValue::String(account_id.clone())),
            (
                "activationJHeight",
                number("activationJHeight", *activation_j_height)?,
            ),
            (
                "activationLogIndex",
                number("activationLogIndex", *activation_log_index)?,
            ),
        ],
        ScheduledHookKind::CrossJOrderbookSweep { reason } => {
            vec![("reason", CanonicalValue::String(reason.clone()))]
        }
    };
    Ok(object(values))
}

fn hook_type(hook: &ScheduledHookKind) -> &'static str {
    match hook {
        ScheduledHookKind::HtlcTimeout { .. } => "htlc_timeout",
        ScheduledHookKind::DisputeDeadline { .. } => "dispute_deadline",
        ScheduledHookKind::HtlcSecretAckTimeout { .. } => "htlc_secret_ack_timeout",
        ScheduledHookKind::SettlementWindow => "settlement_window",
        ScheduledHookKind::Watchdog => "watchdog",
        ScheduledHookKind::HubRebalanceKick { .. } => "hub_rebalance_kick",
        ScheduledHookKind::BoardHankoRefresh { .. } => "board_hanko_refresh",
        ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline { .. } => {
            "counterparty_board_hanko_refresh_deadline"
        }
        ScheduledHookKind::CrossJOrderbookSweep { .. } => "cross_j_orderbook_sweep",
    }
}

pub(crate) fn canonical_hook(hook: &ScheduledHook) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("id", CanonicalValue::String(hook.id.clone())),
        ("triggerAt", number("triggerAt", hook.trigger_at)?),
        (
            "type",
            CanonicalValue::String(hook_type(&hook.kind).to_string()),
        ),
        ("data", hook_data(&hook.kind)?),
    ]))
}

fn canonical_crontab_tasks(state: &CrontabState) -> Result<CanonicalValue, EntityKernelError> {
    let tasks = state
        .tasks
        .iter()
        .map(|(method, task)| {
            let params = task
                .params
                .iter()
                .map(|(key, value)| (key.clone(), task_param(value)))
                .collect();
            Ok((
                CanonicalValue::String(method.as_str().to_string()),
                object(vec![
                    (
                        "method",
                        CanonicalValue::String(task.method.as_str().to_string()),
                    ),
                    ("intervalMs", number("intervalMs", task.interval_ms)?),
                    ("lastRun", number("lastRun", task.last_run)?),
                    ("enabled", CanonicalValue::Bool(task.enabled)),
                    ("params", CanonicalValue::Object(params)),
                ]),
            ))
        })
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    Ok(CanonicalValue::Map(tasks))
}

pub(crate) fn canonical_crontab_storage_state(
    state: &CrontabState,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![("tasks", canonical_crontab_tasks(state)?)]))
}

pub(crate) fn canonical_crontab_state_from_storage(
    storage: CanonicalValue,
    hooks: CanonicalValue,
) -> Result<CanonicalValue, EntityKernelError> {
    let CanonicalValue::Object(mut fields) = storage else {
        return Err(EntityKernelError::CommitmentEncoding {
            detail: "CRONTAB_STORAGE_STATE_INVALID".to_string(),
        });
    };
    fields.push(("hooks".to_string(), hooks));
    Ok(CanonicalValue::Object(fields))
}

pub(crate) fn canonical_crontab_state(
    state: &CrontabState,
    hooks: CanonicalValue,
) -> Result<CanonicalValue, EntityKernelError> {
    canonical_crontab_state_from_storage(canonical_crontab_storage_state(state)?, hooks)
}
