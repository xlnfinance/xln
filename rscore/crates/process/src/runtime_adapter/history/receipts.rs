//! Read actual verified WAL replay effects. No receipt is inferred from input admission.
use serde_json::{Value, json};
use xln_rscore_entity_kernel::{EntityKernelOutput, canonical_entity_kernel_output};
use xln_rscore_runtime::restore::{
    ConcreteCheckpointConfiguration, decode_concrete_runtime_checkpoint,
    decode_concrete_runtime_wal_frame, reconcile_runtime_input_with_resident_queue,
    replay_decoded_runtime_wal_observed, restore_decoded_runtime_checkpoint,
};
use xln_rscore_runtime::{
    ResidentRuntimeService, RuntimeOutputs, tagged_json_from_canonical_value,
};
fn error(e: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:FRAME_RECEIPTS:{e}")
}
fn number(query: &Value, key: &str, default: u64) -> Result<u64, String> {
    let Some(v) = query.get(key).filter(|v| !v.is_null()) else {
        return Ok(default);
    };
    let n = v
        .as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.0)
        .ok_or_else(|| format!("E_BAD_QUERY:{key} must be finite safe integer"))?;
    Ok(n.floor().max(1.0) as u64)
}
fn range(latest: u64, query: &Value) -> Result<(u64, u64, u64), String> {
    let from = number(query, "fromHeight", 1)?;
    let to = number(query, "toHeight", latest)?.max(from).min(latest);
    let limit = number(query, "limit", 200)?.clamp(1, 500);
    let page = if to >= from {
        to.min(from.saturating_add(limit - 1))
    } else {
        0
    };
    Ok((from, to, page))
}
fn filters(query: &Value) -> Result<(String, Vec<String>), String> {
    let entity = query
        .get("entityId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !entity.is_empty()
        && (entity.len() != 66
            || !entity.starts_with("0x")
            || !entity[2..].bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("E_BAD_QUERY:frame receipt entityId must be a bytes32 id".into());
    }
    let names = match &query["eventNames"] {
        Value::Array(rows) => rows
            .iter()
            .map(|v| v.as_str().ok_or("E_BAD_QUERY:eventNames"))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(str::to_owned)
            .collect(),
        Value::String(value) => value.split(',').map(str::to_owned).collect(),
        Value::Null => Vec::new(),
        _ => return Err("E_BAD_QUERY:eventNames".into()),
    };
    Ok((
        entity,
        names
            .into_iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect(),
    ))
}
fn log(event: &EntityKernelOutput, index: usize, timestamp: u64) -> Result<Option<Value>, String> {
    if !event.is_runtime_event() {
        return Ok(None);
    }
    let mut data =
        tagged_json_from_canonical_value(&canonical_entity_kernel_output(event).map_err(error)?)
            .map_err(error)?;
    let kind = data["kind"].as_str().ok_or_else(|| error("EVENT_KIND"))?;
    let message = match kind {
        "htlcInitiated" => "HtlcInitiated",
        "htlcForwardAccepted" => "HtlcForwardAccepted",
        "htlcFailed" => "HtlcFailed",
        "htlcReceived" => "HtlcReceived",
        "htlcFinalized" => "HtlcFinalized",
        "swapMatched" => "SwapMatched",
        "runtimeEvent" => data["eventName"]
            .as_str()
            .ok_or_else(|| error("EVENT_NAME"))?,
        _ => return Err(error(format!("UNMAPPED_EVENT:{kind}"))),
    }
    .to_owned();
    if kind == "runtimeEvent" {
        data = data["data"].clone();
    }
    let entity = data["entityId"]
        .as_str()
        .ok_or_else(|| error("EVENT_ENTITY"))?
        .to_owned();
    data.as_object_mut()
        .ok_or_else(|| error("EVENT_OBJECT"))?
        .remove("kind");
    Ok(Some(
        json!({"id":index,"timestamp":timestamp,"level":"info","category":"runtime","message":message,"entityId":entity,"data":data}),
    ))
}
fn logs(
    outputs: &RuntimeOutputs,
    timestamp: u64,
    entity: &str,
    names: &[String],
) -> Result<Vec<Value>, String> {
    outputs
        .entities
        .iter()
        .flat_map(|o| o.entity_events.iter())
        .enumerate()
        .map(|(i, e)| log(e, i, timestamp))
        .collect::<Result<Vec<_>, _>>()
        .map(|rows| {
            rows.into_iter()
                .flatten()
                .filter(|row| {
                    (entity.is_empty() || row["entityId"] == entity)
                        && (names.is_empty() || names.iter().any(|n| row["message"] == *n))
                })
                .collect()
        })
}
pub fn read(
    service: &mut ResidentRuntimeService,
    query: &Value,
    config: &ConcreteCheckpointConfiguration,
) -> Result<Value, String> {
    let latest = service.processor().replica().map_err(error)?.state.height;
    let (from, to, page) = range(latest, query)?;
    let (entity, names) = filters(query)?;
    let mut receipts = Vec::new();
    if page == 0 {
        return Ok(json!({"fromHeight":from,"toHeight":to,"returned":0,"receipts":receipts}));
    }
    let sources = service.adapter_restore_sources().map_err(error)?;
    let checkpoint = sources.checkpoint.height;
    require_range(from, checkpoint, latest)?;
    let decoded = decode_concrete_runtime_checkpoint(
        sources.checkpoint,
        super::history_read::copy_config(config),
    )
    .map_err(error)?;
    let mut restored = restore_decoded_runtime_checkpoint(decoded).map_err(error)?;
    let mut observed = checkpoint;
    for source in sources.wal.into_iter().take_while(|f| f.height() <= page) {
        let frame =
            decode_concrete_runtime_wal_frame(&source, restored.replica.state.finalized_j_height)
                .map_err(error)?;
        reconcile_runtime_input_with_resident_queue(&frame.input, &mut restored.replica.mempool);
        let mut result = Ok(());
        restored = replay_decoded_runtime_wal_observed(
            restored,
            vec![frame],
            |height, timestamp, outputs| {
                observed = height;
                if height < from {
                    return;
                }
                result = logs(outputs, timestamp, &entity, &names).map(|logs| {
                    if (entity.is_empty() && names.is_empty()) || !logs.is_empty() {
                        receipts.push(json!({"height":height,"timestamp":timestamp,"logs":logs}));
                    }
                });
            },
        )
        .map_err(error)?;
        result?;
    }
    if observed != page {
        return Err(format!(
            "E_NOT_FOUND:frame receipt range ended early:{observed}:{page}"
        ));
    }
    Ok(json!({"fromHeight":from,"toHeight":page,"returned":receipts.len(),"receipts":receipts}))
}
fn require_range(from: u64, checkpoint: u64, latest: u64) -> Result<(), String> {
    if from <= checkpoint {
        return Err(format!(
            "E_NOT_FOUND:frame receipt history unavailable; retained replay range {}..{latest}",
            checkpoint + 1
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_range_and_idle_watermark_match_canonical_ts() {
        assert_eq!(range(1000, &Value::Null).unwrap(), (1, 1000, 200));
        assert_eq!(
            range(1000, &json!({"fromHeight":50,"limit":900})).unwrap(),
            (50, 1000, 549)
        );
        assert_eq!(range(10, &json!({"fromHeight":11})).unwrap(), (11, 10, 0));
        assert!(
            require_range(100, 100, 150)
                .unwrap_err()
                .contains("101..150")
        );
        assert!(require_range(101, 100, 150).is_ok());
    }
    #[test]
    fn terminal_event_is_actual_ordered_effect_not_admitted_payment() {
        let event = EntityKernelOutput::HtlcFailed {
            entity_id: "owner".into(),
            hashlock: "hash".into(),
            lock_id: None,
            reason: "capacity".into(),
            description: None,
        };
        let row = log(&event, 7, 100).unwrap().unwrap();
        assert_eq!(row["id"], 7);
        assert_eq!(row["message"], "HtlcFailed");
        assert_eq!(row["data"]["reason"], "capacity");
        let debug = EntityKernelOutput::Debug {
            payload: xln_rscore_protocol::CanonicalValue::Null,
        };
        assert!(log(&debug, 0, 100).unwrap().is_none());
    }
}
