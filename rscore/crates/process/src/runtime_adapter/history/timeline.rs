//! Bounded timeline metadata from genuine native persisted Runtime frames.
use serde_json::{Value, json};
use xln_rscore_runtime::ResidentRuntimeService;
fn number(value: Option<&Value>, default: u64, name: &str) -> Result<i64, String> {
    let Some(value) = value else {
        return Ok(default as i64);
    };
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
        .filter(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.0)
        .ok_or_else(|| format!("E_BAD_QUERY:{name} must be finite"))?;
    Ok(number.floor() as i64)
}
fn timestamp(query: &Value, name: &str) -> Result<Option<u64>, String> {
    if query.get(name).is_none() {
        return Ok(None);
    }
    let value = number(query.get(name), 0, name)?;
    u64::try_from(value)
        .map(Some)
        .map_err(|_| format!("E_BAD_QUERY:{name} must be nonnegative"))
}
pub fn read(service: &mut ResidentRuntimeService, query: &Value) -> Result<Value, String> {
    let head = service
        .adapter_storage_head()
        .map_err(|e| format!("E_INTERNAL:TIMELINE_HEAD:{e}"))?;
    let replica = service
        .processor()
        .replica()
        .map_err(|e| format!("E_INTERNAL:TIMELINE_REPLICA:{e}"))?;
    let latest = replica.state.height.min(
        head["latestHeight"]
            .as_u64()
            .ok_or("E_INTERNAL:TIMELINE_HEAD_HEIGHT")?,
    );
    let runtime_id = replica.durable.runtime_id().to_string();
    if latest == 0 && query.get("beforeHeight").is_none() {
        return Ok(
            json!({"runtimeId":runtime_id,"latestHeight":0,"entries":[],"scannedHeights":0,"nextBeforeHeight":null}),
        );
    }
    let before = number(query.get("beforeHeight"), latest + 1, "beforeHeight")?;
    if before < 2 {
        return Err("E_BAD_QUERY:beforeHeight must be greater than 1".into());
    }
    let limit = number(query.get("limit"), 250, "limit")?.clamp(1, 500) as usize;
    let scan = number(query.get("scanLimit"), (limit * 4) as u64, "scanLimit")?;
    if scan < 1 {
        return Err("E_BAD_QUERY:scanLimit must be positive".into());
    }
    let from = timestamp(query, "fromTimestamp")?;
    let to = timestamp(query, "toTimestamp")?;
    let mut cursor = latest.min((before - 1) as u64);
    let mut scanned = 0;
    let mut entries = Vec::new();
    while cursor >= 1 && scanned < scan.min(2000) && entries.len() < limit {
        // Read/validate canonical WAL and metadata; corruption remains a loud error.
        let frame = crate::runtime_adapter::views::read::read(
            service,
            &format!("frame/{cursor}"),
            &Value::Null,
        )?;
        cursor -= 1;
        scanned += 1;
        let time = frame["timestamp"]
            .as_u64()
            .ok_or("E_INTERNAL:TIMELINE_TIMESTAMP")?;
        if from.is_some_and(|min| time < min) || to.is_some_and(|max| time > max) {
            continue;
        }
        let counts = &frame["touchedCounts"];
        let changed = ["entities", "accounts", "bookEntities"]
            .iter()
            .any(|key| counts[*key].as_u64().is_some_and(|n| n > 0));
        entries.push(json!({"runtimeId":runtime_id,"height":frame["height"],"timestamp":time,"stateHash":frame["stateHash"],"materialized":frame["materializedState"]==true,"graphChanged":changed}));
    }
    entries.sort_by_key(|entry| {
        (
            entry["timestamp"].as_u64().unwrap(),
            entry["height"].as_u64().unwrap(),
        )
    });
    Ok(
        json!({"runtimeId":runtime_id,"latestHeight":latest,"entries":entries,"scannedHeights":scanned,"nextBeforeHeight":if cursor>=1{Some(cursor+1)}else{None}}),
    )
}
