//! Bounded Activity reads from actual accepted Runtime WAL inputs.
//! Input admission proves a request, not inner financial commitment. No invented
//! finalization logs, Account-history scans, or additional durable representation.
use serde_json::{Value, json};
use xln_rscore_runtime::{ResidentRuntimeService, decode_storage_payload};

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn id(value: &Value) -> String {
    text(value).trim().to_lowercase()
}
fn amount(value: &Value) -> Option<String> {
    if value["__xlnType"] == "BigInt" {
        return value["value"].as_str().map(str::to_owned);
    }
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().into()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}
fn mentions(value: &Value, entity: &str, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match value {
        Value::String(value) => value.to_lowercase() == entity,
        Value::Array(rows) => rows.iter().any(|value| mentions(value, entity, depth + 1)),
        Value::Object(rows) => rows
            .values()
            .any(|value| mentions(value, entity, depth + 1)),
        _ => false,
    }
}
fn classify(raw: &str) -> (&'static str, &'static str) {
    let key = raw.to_lowercase();
    let kind = if ["jevent", "j_event", "jbatch", "settled", "evm"]
        .iter()
        .any(|part| key.contains(part))
    {
        "onchain"
    } else {
        "offchain"
    };
    let ty = [
        (key.contains("cross") && key.contains("swap"), "cross_swap"),
        (key.contains("swap"), "swap"),
        (key.contains("payment"), "payment"),
        (key.contains("htlc"), "htlc"),
        (key.contains("settle"), "settlement"),
        (key.contains("account"), "account"),
        (key.contains("jbatch") || key.contains("j_batch"), "j_batch"),
        (key.contains("jevent") || key.contains("j_event"), "j_event"),
        (key.contains("error") || key.contains("failed"), "error"),
    ]
    .into_iter()
    .find_map(|(matched, kind)| matched.then_some(kind))
    .unwrap_or("system");
    (kind, ty)
}
fn input_event(
    frame: &Value,
    index: usize,
    input_entity: &str,
    tx: &Value,
    viewed: &str,
    account: Option<&Value>,
) -> Option<Value> {
    let raw = text(&tx["type"]);
    if raw == "htlcPayment" {
        return None;
    } // TS projects this only from deterministic completion logs.
    if account.is_none() && !viewed.is_empty() && input_entity != viewed && !mentions(tx, viewed, 0)
    {
        return None;
    }
    if let Some(account) = account
        && !viewed.is_empty()
        && input_entity != viewed
        && id(&account["fromEntityId"]) != viewed
        && id(&account["toEntityId"]) != viewed
    {
        return None;
    }
    let (kind, ty) = classify(raw);
    let mut event = json!({"id":format!("r{}:runtime_input:{index}:{raw}",frame["height"]),
        "height":frame["height"],"timestamp":frame["timestamp"],"kind":kind,"type":ty,
        "source":"runtime_input","direction":"neutral","title":raw,"rawType":raw,
        "subtitle":format!("{} accepted in Runtime frame {}",if account.is_some(){"Account proposal"}else{"Runtime input"},frame["height"]),
        "status":if account.is_some(){"proposed"}else{"queued"},"entityId":if viewed.is_empty(){input_entity}else{viewed}});
    let data = &tx["data"];
    let cp = if let Some(input) = account {
        let from = id(&input["fromEntityId"]);
        let to = id(&input["toEntityId"]);
        if viewed == to { from } else { to }
    } else {
        id(data
            .get("counterpartyEntityId")
            .unwrap_or(&data["targetEntityId"]))
    };
    if !cp.is_empty() {
        event["counterpartyId"] = json!(cp);
    }
    for key in ["tokenId", "giveTokenId", "wantTokenId"] {
        if data[key].is_number() {
            event[match key {
                "giveTokenId" => "tokenId",
                "wantTokenId" => "quoteTokenId",
                _ => key,
            }] = data[key].clone();
        }
    }
    for (source, target) in [
        ("amount", "amount"),
        ("giveAmount", "amount"),
        ("wantAmount", "quoteAmount"),
    ] {
        if let Some(value) = amount(&data[source]) {
            event[target] = json!(value);
        }
    }
    for (source, target) in [("offerId", "orderId"), ("hashlock", "hash")] {
        if data[source].is_string() {
            event[target] = data[source].clone();
        }
    }
    Some(event)
}
fn matches(event: &Value, query: &Value) -> bool {
    let viewed = text(&query["entityId"]);
    if !viewed.is_empty()
        && id(&event["entityId"]) != viewed
        && id(&event["counterpartyId"]) != viewed
    {
        return false;
    }
    let kind = text(&query["kind"]);
    if kind != "all" && kind != text(&event["kind"]) {
        return false;
    }
    if let Some(types) = query["types"].as_array().filter(|rows| !rows.is_empty())
        && !types.iter().any(|ty| {
            ty == &event["type"]
                || ty == &event["rawType"]
                || (text(ty).eq_ignore_ascii_case("htlc")
                    && text(&event["rawType"]).to_lowercase().contains("htlc"))
        })
    {
        return false;
    }
    let timestamp = event["timestamp"].as_f64().unwrap_or(0.0);
    if query["fromTimestamp"]
        .as_f64()
        .is_some_and(|from| timestamp < from)
        || query["toTimestamp"]
            .as_f64()
            .is_some_and(|to| timestamp > to)
    {
        return false;
    }
    let search = text(&query["query"]).to_lowercase();
    search.is_empty()
        || [
            "title",
            "subtitle",
            "status",
            "entityId",
            "counterpartyId",
            "amount",
            "orderId",
            "hash",
            "rawType",
        ]
        .iter()
        .map(|key| text(&event[key]))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .contains(&search)
}
fn project_frame(frame: &Value, query: &Value) -> Result<Vec<Value>, String> {
    let mut events = Vec::new();
    let mut index = 0;
    let viewed = text(&query["entityId"]);
    let inputs = frame["runtimeInput"]["entityInputs"]
        .as_array()
        .ok_or("E_INTERNAL:ACTIVITY_ENTITY_INPUTS")?;
    for input in inputs {
        let entity = id(&input["entityId"]);
        let empty = Vec::new();
        let txs = match input.get("entityTxs") {
            None => &empty,
            Some(value) => value.as_array().ok_or("E_INTERNAL:ACTIVITY_ENTITY_TXS")?,
        };
        for tx in txs {
            if tx["type"] == "accountInput" {
                let rows = tx["data"]["proposal"]["frame"]["accountTxs"].as_array();
                for row in rows.into_iter().flatten() {
                    if let Some(event) =
                        input_event(frame, index, &entity, row, viewed, Some(&tx["data"]))
                        && matches(&event, query)
                    {
                        events.push(event);
                    }
                    index += 1;
                }
                if rows.is_none_or(Vec::is_empty) {
                    index += 1;
                }
            } else {
                if let Some(event) = input_event(frame, index, &entity, tx, viewed, None)
                    && matches(&event, query)
                {
                    events.push(event);
                }
                index += 1;
            }
        }
    }
    events.sort_by(|a, b| {
        text(&b["id"])
            .encode_utf16()
            .cmp(text(&a["id"]).encode_utf16())
    });
    Ok(events)
}
fn normalized_query(query: &Value) -> Result<Value, String> {
    let kind = query["kind"].as_str().unwrap_or("all");
    if !matches!(kind, "all" | "onchain" | "offchain") {
        return Err("E_BAD_QUERY:activity kind".into());
    }
    let entity = id(&query["entityId"]);
    if !entity.is_empty()
        && (entity.len() != 66
            || !entity.starts_with("0x")
            || !entity[2..].bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("E_BAD_QUERY:activity entityId".into());
    }
    let types = match &query["types"] {
        Value::Array(rows) => rows
            .iter()
            .map(|v| text(v).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>(),
        Value::String(s) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let mut out = json!({"kind":kind,"types":types,"query":query["query"].as_str().or(query["q"].as_str()).unwrap_or("").trim()});
    if !entity.is_empty() {
        out["entityId"] = json!(entity);
    }
    for key in [
        "fromTimestamp",
        "toTimestamp",
        "beforeHeight",
        "limit",
        "scanLimit",
    ] {
        let value = &query[key];
        if value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()) {
            continue;
        }
        let n = value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("E_BAD_QUERY:{key} must be finite"))?;
        out[key] = json!(n.floor());
    }
    Ok(out)
}
pub fn read(service: &mut ResidentRuntimeService, query: &Value) -> Result<Value, String> {
    let query = normalized_query(query)?;
    let head = service
        .adapter_storage_head()
        .map_err(|e| format!("E_INTERNAL:{e}"))?;
    let latest = head["latestHeight"]
        .as_u64()
        .ok_or("E_INTERNAL:ACTIVITY_HEAD_HEIGHT")?;
    let runtime = service.runtime_id().to_owned();
    read_page(&runtime, latest, &query, |height| {
        let wal = service
            .read_durable_frame(height)
            .map_err(|e| format!("E_INTERNAL:ACTIVITY_WAL:{height}:{e}"))?;
        decode_storage_payload(&wal.frame_bytes)
            .map_err(|e| format!("E_INTERNAL:ACTIVITY_DECODE:{height}:{e}"))
    })
}
fn read_page(
    runtime: &str,
    latest: u64,
    query: &Value,
    mut frame: impl FnMut(u64) -> Result<Value, String>,
) -> Result<Value, String> {
    let limit = query["limit"].as_f64().unwrap_or(100.0).clamp(1.0, 500.0) as usize;
    let scan = query["scanLimit"]
        .as_f64()
        .unwrap_or(100.0)
        .clamp(1.0, 1000.0) as usize;
    let start = if latest == 0 {
        0
    } else {
        query["beforeHeight"]
            .as_f64()
            .unwrap_or(latest as f64)
            .clamp(1.0, latest as f64) as u64
    };
    let mut height = start;
    let mut last = 0;
    let mut scanned = 0;
    let mut events = Vec::new();
    while height >= 1 && scanned < scan {
        let value = frame(height)?;
        if value["height"].as_u64() != Some(height) || value["timestamp"].as_u64().is_none() {
            return Err(format!("E_INTERNAL:ACTIVITY_FRAME_INVALID:{height}"));
        }
        last = height;
        scanned += 1;
        events.extend(project_frame(&value, query)?);
        if events.len() >= limit {
            break;
        }
        height -= 1;
    }
    events.truncate(limit);
    for event in &mut events {
        event["id"] = json!(format!("{runtime}:{}", text(&event["id"])));
        event["runtimeId"] = json!(runtime);
    }
    Ok(
        json!({"ok":true,"runtimeId":runtime,"latestHeight":latest,"fromHeight":last,"toHeight":start,"scannedFrames":scanned,
        "returned":events.len(),"limit":limit,"scanLimit":scan,"nextBeforeHeight":if last>1{Some(last-1)}else{None},
        "filters":query,"events":events}),
    )
}

#[cfg(test)]
#[path = "activity_tests.rs"]
mod tests;
