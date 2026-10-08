//! Admission against the existing rooted Runtime adapter frontier.
//! Runs only on the Runtime's single-writer thread, before any external effect.
use crate::runtime_adapter::commands::input_hash::input_hash;
use serde_json::{Value, json};
use xln_rscore_runtime::{RuntimeAdapterCommandMarker, RuntimeReplica};

pub enum CommandAdmission {
    Observed(Value),
    Apply(RuntimeAdapterCommandMarker),
}

pub fn frontier<'a>(replica: &'a RuntimeReplica, lane: &str) -> Result<Option<&'a Value>, String> {
    let infrastructure = replica.durable.infrastructure();
    let Some(frontiers) = infrastructure.get("runtimeAdapterCommandFrontiers") else {
        return Ok(None);
    };
    let rows = frontiers
        .get("value")
        .and_then(Value::as_array)
        .ok_or("RADAPTER_FRONTIERS_CORRUPT")?;
    Ok(rows
        .iter()
        .find(|row| row.get(0).and_then(Value::as_str) == Some(lane))
        .and_then(|row| row.get(1)))
}

pub fn next_sequence(replica: &RuntimeReplica, lane: &str) -> Result<u64, String> {
    frontier(replica, lane)?
        .map_or(Ok::<u64, String>(0), |row| {
            row["lastContiguousSequence"]
                .as_u64()
                .ok_or_else(|| "RADAPTER_FRONTIER_SEQUENCE_CORRUPT".into())
        })?
        .checked_add(1)
        .ok_or_else(|| "RADAPTER_FRONTIER_OVERFLOW".into())
}

pub fn admit(
    replica: &RuntimeReplica,
    lane: &str,
    expiry: Option<u64>,
    request: &Value,
) -> Result<CommandAdmission, String> {
    let command_id = request["commandId"]
        .as_str()
        .map(str::trim)
        .filter(|s| {
            (16..=128).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
        .ok_or("E_BAD_QUERY:commandId")?;
    let sequence = request["commandSequence"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or("E_BAD_QUERY:commandSequence")?;
    let input = request
        .get("input")
        .filter(|v| v.is_object())
        .ok_or("E_BAD_QUERY:input")?;
    let input_hash = input_hash(input)?;
    let prior = frontier(replica, lane)?;
    let committed = next_sequence(replica, lane)? - 1;
    if sequence <= committed {
        let row = prior.ok_or("RADAPTER_FRONTIER_MISSING")?;
        if sequence == committed
            && (row["lastCommandId"].as_str() != Some(command_id)
                || row["lastInputHash"].as_str() != Some(&input_hash))
        {
            return Err("E_BAD_QUERY:commandId reused with a different payload".into());
        }
        let height = row["observedHeight"]
            .as_u64()
            .ok_or("RADAPTER_FRONTIER_HEIGHT_CORRUPT")?;
        return Ok(CommandAdmission::Observed(
            json!({"height":height,"status":"observed","commandSequence":sequence}),
        ));
    }
    if sequence != committed + 1 {
        return Err(format!(
            "E_COMMAND_PENDING:expected={}:actual={sequence}",
            committed + 1
        ));
    }
    Ok(CommandAdmission::Apply(RuntimeAdapterCommandMarker {
        lane_id: lane.into(),
        sequence,
        command_id: command_id.into(),
        input_hash,
        expires_at_ms: expiry,
    }))
}
