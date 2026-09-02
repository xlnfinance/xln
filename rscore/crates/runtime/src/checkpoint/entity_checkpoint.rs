//! Projection of an offline TypeScript checkpoint into canonical Entity
//! section commitments. This is import code, never a live execution bridge.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    CrontabState, CrontabTaskMethod, CrontabTaskParam, CrontabTaskState, EntityConsensusSection,
    EntityKernelError, ScheduledHook, ScheduledHookKind, ScheduledHookMap,
    collection_commitment as entity_collection_commitment, compute_entity_section_digest,
    is_entity_owned_consensus_field,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::{TaggedJsonError, canonical_value_from_tagged_json};

// Exact mirror of `ENTITY_STATE_ROOT_FIELDS` in
// `core/entity/consensus/state-root.ts`. Optional fields may be absent, but a
// field outside this list is never allowed to become consensus-critical just
// because it appeared in a storage document.
const CONSENSUS_FIELDS: &[&str] = &[
    "entityId",
    "height",
    "timestamp",
    "nonces",
    "entityCommandNonces",
    "proposals",
    "config",
    "leaderState",
    "reserves",
    "accounts",
    "externalWallet",
    "deferredAccountProposals",
    "settlementContinuations",
    "lastFinalizedJHeight",
    "jHistoryFinality",
    "certifiedBoardState",
    "crontabState",
    "jBatchState",
    "entityProviderActionState",
    "entityEncryptionPublicKey",
    "profile",
    "paybook",
    "outDebtsByToken",
    "inDebtsByToken",
    "orderbookExt",
    "swapTradingPairs",
    "crossJurisdictionSwaps",
    "crossJurisdictionAuthorizations",
    "pendingCrossJurisdictionFillAcks",
    "crossJurisdictionBookAdmissions",
    "hubRebalanceConfig",
    "lending",
];

// Exact mirror of `StorageEntityCoreDoc`. `accounts` live in their own tree,
// while `orderbookExt` is split into the three storage-only fields below.
const STORAGE_CORE_FIELDS: &[&str] = &[
    "entityId",
    "height",
    "timestamp",
    "nonces",
    "entityCommandNonces",
    "proposals",
    "config",
    "leaderState",
    "reserves",
    "externalWallet",
    "deferredAccountProposals",
    "settlementContinuations",
    "lastFinalizedJHeight",
    "jHistoryFinality",
    "certifiedBoardState",
    "crontabState",
    "jBatchState",
    "entityProviderActionState",
    "entityEncryptionPublicKey",
    "profile",
    "paybook",
    "outDebtsByToken",
    "inDebtsByToken",
    "swapTradingPairs",
    "crossJurisdictionSwaps",
    "crossJurisdictionAuthorizations",
    "pendingCrossJurisdictionFillAcks",
    "crossJurisdictionBookAdmissions",
    "hubRebalanceConfig",
    "lending",
    "prevFrameHash",
    "orderbookHubProfile",
    "orderbookReferrals",
    "orderbookPairDimensions",
];
const STORAGE_ONLY_FIELDS: &[&str] = &[
    "prevFrameHash",
    "orderbookHubProfile",
    "orderbookPairDimensions",
    "orderbookReferrals",
];
const COLLECTION_FIELDS: &[&str] = &[
    "deferredAccountProposals",
    "settlementContinuations",
    "crossJurisdictionSwaps",
    "crossJurisdictionAuthorizations",
    "pendingCrossJurisdictionFillAcks",
    "crossJurisdictionBookAdmissions",
];

#[derive(Debug, Error)]
pub enum EntityCheckpointError {
    #[error("RUNTIME_ENTITY_CHECKPOINT:{0}")]
    Invalid(String),
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error("RUNTIME_ENTITY_CHECKPOINT_ENCODING:{0}")]
    Encoding(String),
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityCheckpointError> {
    value
        .as_object()
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("OBJECT:{path}")))
}

fn field<'a>(value: &'a Value, name: &str, path: &str) -> Result<&'a Value, EntityCheckpointError> {
    object(value, path)?
        .get(name)
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("FIELD:{path}.{name}")))
}

fn tagged_map_rows<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], EntityCheckpointError> {
    let tagged = object(value, path)?;
    if tagged.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(EntityCheckpointError::Invalid(format!("MAP:{path}")));
    }
    tagged
        .get("value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("MAP_ROWS:{path}")))
}

fn collection_commitment(
    value: &Value,
    path: &str,
) -> Result<CanonicalValue, EntityCheckpointError> {
    let rows = tagged_map_rows(value, path)?
        .iter()
        .map(|row| {
            let pair = row
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or_else(|| EntityCheckpointError::Invalid(format!("MAP_ROW:{path}")))?;
            let key = pair[0]
                .as_str()
                .ok_or_else(|| EntityCheckpointError::Invalid(format!("MAP_KEY:{path}")))?;
            let canonical = canonical_value_from_tagged_json(&pair[1])?;
            Ok((key.to_string(), canonical))
        })
        .collect::<Result<Vec<_>, EntityCheckpointError>>()?;
    entity_collection_commitment(rows.into_iter().map(Result::<_, EntityKernelError>::Ok))
        .map_err(|error| EntityCheckpointError::Encoding(error.to_string()))
}

fn string(value: &Value, path: &str) -> Result<String, EntityCheckpointError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("STRING:{path}")))
}

fn unsigned(value: &Value, path: &str) -> Result<u64, EntityCheckpointError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("UNSIGNED:{path}")))
}

fn hook_kind(value: &Value, path: &str) -> Result<ScheduledHookKind, EntityCheckpointError> {
    let hook = object(value, path)?;
    let kind = field(value, "type", path)?
        .as_str()
        .ok_or_else(|| EntityCheckpointError::Invalid(format!("STRING:{path}.type")))?;
    let data = object(field(value, "data", path)?, &format!("{path}.data"))?;
    let text = |name: &str| {
        string(
            data.get(name).ok_or_else(|| {
                EntityCheckpointError::Invalid(format!("FIELD:{path}.data.{name}"))
            })?,
            &format!("{path}.data.{name}"),
        )
    };
    let number = |name: &str| {
        unsigned(
            data.get(name).ok_or_else(|| {
                EntityCheckpointError::Invalid(format!("FIELD:{path}.data.{name}"))
            })?,
            &format!("{path}.data.{name}"),
        )
    };
    let result = match kind {
        "htlc_timeout" => ScheduledHookKind::HtlcTimeout {
            account_id: text("accountId")?,
            lock_id: text("lockId")?,
        },
        "dispute_deadline" => ScheduledHookKind::DisputeDeadline {
            account_id: text("accountId")?,
        },
        "htlc_secret_ack_timeout" => ScheduledHookKind::HtlcSecretAckTimeout {
            hashlock: text("hashlock")?,
            counterparty_entity_id: text("counterpartyEntityId")?,
        },
        "settlement_window" => ScheduledHookKind::SettlementWindow,
        "watchdog" => ScheduledHookKind::Watchdog,
        "hub_rebalance_kick" => ScheduledHookKind::HubRebalanceKick {
            reason: text("reason")?,
            counterparty_id: text("counterpartyId")?,
        },
        "board_hanko_refresh" => ScheduledHookKind::BoardHankoRefresh {
            activation_j_height: number("activationJHeight")?,
            activation_log_index: number("activationLogIndex")?,
            after_counterparty_id: text("afterCounterpartyId")?,
        },
        "counterparty_board_hanko_refresh_deadline" => {
            ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline {
                account_id: text("accountId")?,
                activation_j_height: number("activationJHeight")?,
                activation_log_index: number("activationLogIndex")?,
            }
        }
        "cross_j_orderbook_sweep" => ScheduledHookKind::CrossJOrderbookSweep {
            reason: text("reason")?,
        },
        _ => {
            return Err(EntityCheckpointError::Invalid(format!(
                "HOOK_TYPE:{path}:{kind}"
            )));
        }
    };
    if hook.len() != 4 {
        return Err(EntityCheckpointError::Invalid(format!("HOOK_ARITY:{path}")));
    }
    Ok(result)
}

fn task_param(value: &Value, path: &str) -> Result<CrontabTaskParam, EntityCheckpointError> {
    match value {
        Value::String(value) => Ok(CrontabTaskParam::String(value.clone())),
        Value::Bool(value) => Ok(CrontabTaskParam::Bool(*value)),
        Value::Number(value) => CanonicalNumber::parse_js_canonical(&value.to_string())
            .map(CrontabTaskParam::Number)
            .map_err(|_| EntityCheckpointError::Invalid(format!("TASK_PARAM:{path}"))),
        _ => Err(EntityCheckpointError::Invalid(format!("TASK_PARAM:{path}"))),
    }
}

/// Decode the scheduler state stored beside the imported Entity checkpoint.
/// The live Rust kernel owns this value after import; carrying its old digest
/// would hide hook mutations while Account roots continued to match.
pub fn entity_checkpoint_crontab(
    replica: &Value,
) -> Result<Option<CrontabState>, EntityCheckpointError> {
    let core = object(
        field(field(replica, "state", "replica")?, "core", "replica.state")?,
        "replica.state.core",
    )?;
    let Some(raw) = core.get("crontabState") else {
        return Ok(None);
    };
    let crontab = object(raw, "crontabState")?;
    let mut tasks = BTreeMap::new();
    for row in tagged_map_rows(
        crontab
            .get("tasks")
            .ok_or_else(|| EntityCheckpointError::Invalid("FIELD:crontabState.tasks".into()))?,
        "crontabState.tasks",
    )? {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| EntityCheckpointError::Invalid("MAP_ROW:crontabState.tasks".into()))?;
        let key = pair[0]
            .as_str()
            .ok_or_else(|| EntityCheckpointError::Invalid("MAP_KEY:crontabState.tasks".into()))?;
        if key != "hubRebalance" {
            return Err(EntityCheckpointError::Invalid(format!("TASK_METHOD:{key}")));
        }
        let value = object(&pair[1], "crontabState.tasks.value")?;
        if value.get("method").and_then(Value::as_str) != Some(key) || value.len() != 5 {
            return Err(EntityCheckpointError::Invalid(format!("TASK_VALUE:{key}")));
        }
        let mut params = BTreeMap::new();
        for (name, value) in object(
            value
                .get("params")
                .ok_or_else(|| EntityCheckpointError::Invalid("FIELD:task.params".into()))?,
            "task.params",
        )? {
            params.insert(
                name.clone(),
                task_param(value, &format!("task.params.{name}"))?,
            );
        }
        let task = CrontabTaskState {
            method: CrontabTaskMethod::HubRebalance,
            interval_ms: unsigned(
                value.get("intervalMs").ok_or_else(|| {
                    EntityCheckpointError::Invalid("FIELD:task.intervalMs".into())
                })?,
                "task.intervalMs",
            )?,
            last_run: unsigned(
                value
                    .get("lastRun")
                    .ok_or_else(|| EntityCheckpointError::Invalid("FIELD:task.lastRun".into()))?,
                "task.lastRun",
            )?,
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| EntityCheckpointError::Invalid("BOOL:task.enabled".into()))?,
            params,
        };
        if tasks
            .insert(CrontabTaskMethod::HubRebalance, task)
            .is_some()
        {
            return Err(EntityCheckpointError::Invalid(format!(
                "TASK_DUPLICATE:{key}"
            )));
        }
    }
    let mut hooks = BTreeMap::new();
    for row in tagged_map_rows(
        crontab
            .get("hooks")
            .ok_or_else(|| EntityCheckpointError::Invalid("FIELD:crontabState.hooks".into()))?,
        "crontabState.hooks",
    )? {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| EntityCheckpointError::Invalid("MAP_ROW:crontabState.hooks".into()))?;
        let key = pair[0]
            .as_str()
            .ok_or_else(|| EntityCheckpointError::Invalid("MAP_KEY:crontabState.hooks".into()))?;
        let value = object(&pair[1], "crontabState.hooks.value")?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| EntityCheckpointError::Invalid("HOOK_ID".into()))?;
        if id != key {
            return Err(EntityCheckpointError::Invalid(format!(
                "HOOK_KEY:{key}:{id}"
            )));
        }
        let hook = ScheduledHook {
            id: id.to_string(),
            trigger_at: unsigned(
                value
                    .get("triggerAt")
                    .ok_or_else(|| EntityCheckpointError::Invalid("HOOK_TRIGGER".into()))?,
                "crontabState.hooks.triggerAt",
            )?,
            kind: hook_kind(&pair[1], "crontabState.hooks.value")?,
        };
        if hooks.insert(key.to_string(), hook).is_some() {
            return Err(EntityCheckpointError::Invalid(format!(
                "MAP_DUPLICATE:crontabState.hooks:{key}"
            )));
        }
    }
    let hooks = ScheduledHookMap::restore(hooks)
        .map_err(|error| EntityCheckpointError::Encoding(error.to_string()))?;
    Ok(Some(CrontabState { tasks, hooks }))
}

/// Build every non-E+A section digest from one imported Entity checkpoint.
/// E+A-owned sections are supplied after the resident Account forest is
/// restored, so the import never keeps a second Account copy alive.
pub fn carried_entity_checkpoint_sections(
    replica: &Value,
) -> Result<Vec<EntityConsensusSection>, EntityCheckpointError> {
    let core = field(field(replica, "state", "replica")?, "core", "replica.state")?;
    let core = object(core, "replica.state.core")?;
    let mut sections = BTreeMap::<String, EntityConsensusSection>::new();
    for (name, raw) in core {
        if !STORAGE_CORE_FIELDS.contains(&name.as_str()) {
            return Err(EntityCheckpointError::Invalid(format!(
                "UNKNOWN_STORAGE_FIELD:{name}"
            )));
        }
        if is_entity_owned_consensus_field(name) || STORAGE_ONLY_FIELDS.contains(&name.as_str()) {
            continue;
        }
        if !CONSENSUS_FIELDS.contains(&name.as_str()) {
            return Err(EntityCheckpointError::Invalid(format!(
                "UNKNOWN_CONSENSUS_FIELD:{name}"
            )));
        }
        let value = if COLLECTION_FIELDS.contains(&name.as_str()) {
            collection_commitment(raw, name)?
        } else {
            canonical_value_from_tagged_json(raw)?
        };
        let digest = compute_entity_section_digest(&value)
            .map_err(|error| EntityCheckpointError::Encoding(error.to_string()))?;
        sections.insert(
            name.clone(),
            EntityConsensusSection {
                field: name.clone(),
                digest,
            },
        );
    }
    Ok(sections.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::{CONSENSUS_FIELDS, EntityCheckpointError, carried_entity_checkpoint_sections};
    use serde_json::json;

    #[test]
    fn import_never_carries_native_authority_sections() {
        let replica = json!({"state":{"core":{
            "config": {},
            "leaderState": {},
            "nonces": {"__xlnType":"Map","value":[]}
        }}});
        let sections = carried_entity_checkpoint_sections(&replica).expect("carried sections");
        assert_eq!(
            sections
                .iter()
                .map(|section| section.field.as_str())
                .collect::<Vec<_>>(),
            vec!["nonces"]
        );
    }

    #[test]
    fn unknown_storage_and_consensus_fields_are_loud() {
        let replica = json!({"state":{"core":{"futureConsensusField":1}}});
        assert!(matches!(
            carried_entity_checkpoint_sections(&replica),
            Err(EntityCheckpointError::Invalid(message))
                if message == "UNKNOWN_STORAGE_FIELD:futureConsensusField"
        ));
    }

    #[test]
    fn consensus_allowlist_matches_typescript_field_count() {
        assert_eq!(CONSENSUS_FIELDS.len(), 32);
    }
}
