//! Native RuntimeAdapter reads. Called only on the Runtime single-writer thread.
use serde_json::{Map, Value, json};
use xln_rscore_runtime::{
    ResidentRuntimeService, decode_storage_payload, tagged_json_from_canonical_value,
};

pub fn read(
    service: &mut ResidentRuntimeService,
    path: &str,
    query: &Value,
) -> Result<Value, String> {
    service
        .sync_committed()
        .map_err(|error| format!("E_INTERNAL:READ_SYNC:{error}"))?;
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    if let ["frame", requested] = parts.as_slice() {
        let latest = service
            .processor()
            .replica()
            .map_err(internal)?
            .state
            .height;
        let height = if *requested == "latest" {
            latest
        } else {
            requested
                .parse::<u64>()
                .map_err(|_| "E_BAD_PATH:frame height must be positive".to_string())?
        };
        if height == 0 || height > latest {
            return Err(format!("E_NOT_FOUND:frame:{height}"));
        }
        return read_frame(service, height);
    }
    if parts == ["solvency-summary"] {
        return crate::runtime_adapter::views::solvency::read(service, query);
    }
    if parts == ["graph-frame"] {
        return crate::runtime_adapter::views::graph::read(service, query);
    }
    if parts == ["timeline-index"] {
        return crate::runtime_adapter::history::timeline::read(service, query);
    }
    if parts == ["activity"] {
        return crate::runtime_adapter::history::activity::read(service, query);
    }
    if parts == ["head"] {
        return service.adapter_storage_head().map_err(internal);
    }
    if parts == ["checkpoints"] {
        let head = service.adapter_storage_head().map_err(internal)?;
        let height = head
            .get("latestSnapshotHeight")
            .and_then(Value::as_u64)
            .ok_or("E_INTERNAL:STORAGE_HEAD_SNAPSHOT_MISSING")?;
        return Ok(if height == 0 {
            json!([])
        } else {
            json!([{"height":height,"timestamp":null}])
        });
    }
    if parts == ["view-frame"] {
        return view_frame(service, query);
    }
    let replica = service.processor().replica().map_err(internal)?;
    if let Some(height) = requested_height(query)?
        && height != replica.state.height
    {
        // Requires real checkpoint + WAL reconstruction. Never label a live view historical.
        return Err(format!(
            "E_NOT_FOUND:historical state not retained by native read source:{height}"
        ));
    }
    if let ["entity", entity_id, "account", peer_id] = parts.as_slice() {
        return crate::runtime_adapter::views::account_read::read(service, entity_id, peer_id);
    }
    match parts.as_slice() {
        ["entity", entity_id] => entity_core(replica, entity_id),
        ["entities"] => entity_summaries(replica, service.processor().authenticated_profiles()),
        _ => Err(format!("E_BAD_PATH:unsupported adapter path:{path}")),
    }
}

fn internal(error: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:{error}")
}

fn requested_height(query: &Value) -> Result<Option<u64>, String> {
    match query.get("atHeight") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            .map(Some)
            .ok_or_else(|| "E_BAD_QUERY:atHeight must be a nonnegative integer".into()),
    }
}

fn read_frame(service: &mut ResidentRuntimeService, height: u64) -> Result<Value, String> {
    let durable = service.read_durable_frame(height).map_err(internal)?;
    let frame = decode_storage_payload(&durable.frame_bytes).map_err(internal)?;
    compact_frame(&frame, height)
}

fn array_count(value: Option<&Value>) -> Result<usize, String> {
    match value {
        None => Ok(0),
        Some(Value::Array(values)) => Ok(values.len()),
        _ => Err("E_INTERNAL:FRAME_COLLECTION_INVALID".into()),
    }
}

fn compact_frame(frame: &Value, height: u64) -> Result<Value, String> {
    if frame.get("height").and_then(Value::as_u64) != Some(height) {
        return Err("E_INTERNAL:FRAME_HEIGHT_MISMATCH".into());
    }
    let timestamp = frame
        .get("timestamp")
        .and_then(Value::as_u64)
        .ok_or("E_INTERNAL:FRAME_TIMESTAMP_MISSING")?;
    let post_state_hash = frame
        .get("postStateHash")
        .and_then(Value::as_str)
        .ok_or("E_INTERNAL:FRAME_ROOT_MISSING")?;
    let input = frame.get("runtimeInput");
    let field = |name| input.and_then(|input| input.get(name));
    let entity_inputs = field("entityInputs");
    let mut entity_txs = 0;
    if let Some(Value::Array(inputs)) = entity_inputs {
        for input in inputs {
            entity_txs += array_count(input.get("entityTxs"))?;
        }
    }
    let mut result = json!({"height":height,"timestamp":timestamp,"postStateHash":post_state_hash,
        "stateHash":frame.get("canonicalStateHash").and_then(Value::as_str).unwrap_or(""),
        "runtimeInputCounts":{"runtimeTxs":array_count(field("runtimeTxs"))?,"jInputs":array_count(field("jInputs"))?,
            "entityInputs":array_count(entity_inputs)?,"entityTxs":entity_txs},
        "touchedCounts":{"entities":array_count(frame.get("touchedEntities"))?,"accounts":array_count(frame.get("touchedAccounts"))?,
            "bookEntities":array_count(frame.get("touchedBookEntities"))?}});
    for field in [
        "prevFrameHash",
        "frameHash",
        "materializedState",
        "canonicalStateHash",
        "canonicalEntityHashes",
    ] {
        if let Some(value) = frame.get(field) {
            result[field] = value.clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "read_tests.rs"]
mod tests;

fn bounded_limit(query: &Value, name: &str) -> Result<usize, String> {
    let value = query.get(name).or_else(|| query.get("limit"));
    let value = match value {
        None => 10,
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
            .ok_or("E_BAD_QUERY:limit")?,
    };
    if value == 0 || value > 100 {
        return Err("E_BAD_QUERY:limit out of range".into());
    }
    Ok(value as usize)
}

fn view_frame(service: &mut ResidentRuntimeService, query: &Value) -> Result<Value, String> {
    let head = service.adapter_storage_head().map_err(internal)?;
    let (view, accounts) = prepare_frame(
        service.processor().replica().map_err(internal)?,
        head,
        service.processor().authenticated_profiles(),
        query,
    )?;
    let rows = match accounts {
        Some((key, ids)) => service
            .read_account_views(
                &key,
                ids,
                crate::runtime_adapter::views::account_projection::account_view,
            )
            .map_err(internal)?,
        None => Vec::new(),
    };
    finish_frame(view, rows)
}
pub(in crate::runtime_adapter) fn finish_frame(
    mut view: Value,
    rows: Vec<(
        xln_rscore_batch::AccountId,
        xln_rscore_protocol::CanonicalValue,
    )>,
) -> Result<Value, String> {
    if !view["activeEntity"].is_null() {
        view["activeEntity"]["accounts"]["items"] = Value::Array(
            rows.into_iter()
                .map(|(_, row)| tagged_json_from_canonical_value(&row).map_err(internal))
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    Ok(view)
}
type FrameAccountSelection = Option<(
    xln_rscore_runtime::RuntimeEntityKey,
    Vec<xln_rscore_batch::AccountId>,
)>;
pub(in crate::runtime_adapter) fn prepare_frame(
    replica: &xln_rscore_runtime::RuntimeReplica,
    head: Value,
    profiles: Vec<Value>,
    query: &Value,
) -> Result<(Value, FrameAccountSelection), String> {
    let entities = entity_summaries(replica, profiles)?;
    let height = replica.state.height;
    let default_owner = default_entity_id(replica)?;
    let selected = query
        .get("entityId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_ascii_lowercase)
        .or(default_owner);
    let Some(entity_id) = selected else {
        return Ok((
            json!({"head":head,"height":height,"entities":entities,"activeEntityId":null,"activeEntity":null}),
            None,
        ));
    };
    let core = entity_core(replica, &entity_id)?;
    let summary = entities
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["entityId"] == entity_id))
        .ok_or("E_NOT_FOUND:active entity")?
        .clone();
    let limit = bounded_limit(query, "accountsLimit")?;
    let books_limit = bounded_limit(query, "booksLimit")?;
    let (key, account_ids, book_rows) = {
        let (key, state) = replica
            .state
            .e_replicas
            .iter()
            .find(|(key, _)| format!("0x{}", hex::encode(key.entity_id)) == entity_id)
            .ok_or("E_NOT_FOUND:entity")?;
        let mut account_ids = state
            .entity
            .known_accounts
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        account_ids.sort();
        let book_rows = state
            .entity
            .orderbook
            .as_ref()
            .map(|book| {
                book.books
                    .iter()
                    .map(|(pair, book)| {
                        Ok((
                            pair.clone(),
                            crate::runtime_adapter::views::projection::book_view(book)?,
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        (key.clone(), account_ids, book_rows)
    };
    let (visible, next_cursor, start) = page_keys(&account_ids, query, "accounts", limit)?;
    let ids = visible
        .iter()
        .map(|id| {
            let bytes = hex::decode(
                id.strip_prefix("0x")
                    .ok_or("E_INTERNAL:ACCOUNT_ID_PREFIX")?,
            )
            .map_err(internal)?;
            let bytes = bytes
                .try_into()
                .map_err(|_| "E_INTERNAL:ACCOUNT_ID_WIDTH")?;
            Ok(xln_rscore_batch::AccountId::from_bytes(bytes))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let items: Vec<Value> = Vec::new();
    let accounts = json!({"items":items,"nextCursor":next_cursor,"totalItems":account_ids.len(),"limit":limit,"pageIndex":start/limit,"pageCount":account_ids.len().div_ceil(limit)});
    let book_keys = book_rows
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    let (visible, next_cursor, start) = page_keys(&book_keys, query, "books", books_limit)?;
    let items = visible
        .iter()
        .map(|key| {
            let (_, book) = book_rows
                .iter()
                .find(|(id, _)| id == key)
                .expect("selected book key");
            json!({"pairId":key,"book":book})
        })
        .collect::<Vec<_>>();
    let books = json!({"items":items,"nextCursor":next_cursor,"totalItems":book_keys.len(),"limit":books_limit,"pageIndex":start/books_limit,"pageCount":book_keys.len().div_ceil(books_limit)});
    Ok((
        json!({"head":head,"height":height,"entities":entities,"activeEntityId":entity_id,"activeEntity":{"summary":summary,"core":core,"accounts":accounts,"books":books}}),
        Some((key, ids)),
    ))
}

fn page_keys(
    keys: &[String],
    query: &Value,
    prefix: &str,
    limit: usize,
) -> Result<(Vec<String>, Option<String>, usize), String> {
    let page = query
        .get(format!("{prefix}Page"))
        .map(|value| value.as_u64().ok_or("E_BAD_QUERY:page"))
        .transpose()?
        .unwrap_or(0) as usize;
    let cursor = query
        .get(format!("{prefix}Cursor"))
        .or_else(|| query.get("cursor"))
        .and_then(Value::as_str);
    let start = cursor.map_or_else(
        || page.saturating_mul(limit),
        |cursor| keys.partition_point(|key| key.as_str() <= cursor),
    );
    let visible = keys
        .iter()
        .skip(start)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let next = (start + visible.len() < keys.len())
        .then(|| visible.last().cloned())
        .flatten();
    Ok((visible, next, start))
}

/// Same UI default as TS scoreDefaultLiveEntity; an explicit requested owner wins above.
fn default_entity_id(
    replica: &xln_rscore_runtime::RuntimeReplica,
) -> Result<Option<String>, String> {
    let scored = replica
        .state
        .e_replicas
        .iter()
        .map(|(key, state)| {
            let live = replica
                .e_replicas
                .get(key)
                .ok_or("E_INTERNAL:ENTITY_OWNER_MISSING")?;
            let books = state
                .entity
                .orderbook
                .as_ref()
                .map_or(0, |book| book.books.len());
            let score = (live.accounts.account_count() as u128) * 1_000_000
                + (books as u128) * 1_000
                + if state.entity.profile.is_hub { 100 } else { 0 }
                + u128::from(state.entity.height.min(99));
            Ok((score, format!("0x{}", hex::encode(key.entity_id))))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(scored
        .into_iter()
        .max_by(|(left_score, left_id), (right_score, right_id)| {
            left_score
                .cmp(right_score)
                .then_with(|| right_id.cmp(left_id))
        })
        .map(|(_, id)| id))
}

fn entity_core(
    replica: &xln_rscore_runtime::RuntimeReplica,
    entity_id: &str,
) -> Result<Value, String> {
    let mut matching = replica.state.e_replicas.iter().filter(|(key, _)| {
        format!("0x{}", hex::encode(key.entity_id)).eq_ignore_ascii_case(entity_id)
    });
    let (key, state) = matching
        .next()
        .ok_or_else(|| format!("E_NOT_FOUND:entity:{entity_id}"))?;
    if matching.next().is_some() {
        return Err("E_INTERNAL:ENTITY_OWNER_AMBIGUOUS".into());
    }
    let live = replica
        .e_replicas
        .get(key)
        .ok_or("E_INTERNAL:ENTITY_OWNER_MISSING")?;
    // Native genesis carries the canonical empty nonce section. The projector
    // proves its commitment; a nonempty imported section requires its retained scalar.
    crate::runtime_adapter::views::projection::entity_core(
        state,
        live,
        &xln_rscore_protocol::CanonicalValue::Map(Vec::new()),
    )
}

fn entity_summaries(
    replica: &xln_rscore_runtime::RuntimeReplica,
    profiles: Vec<Value>,
) -> Result<Value, String> {
    let mut summaries = Vec::new();
    for (key, state) in &replica.state.e_replicas {
        let live = replica
            .e_replicas
            .get(key)
            .ok_or("E_INTERNAL:ENTITY_OWNER_MISSING")?;
        let projection =
            xln_rscore_entity_kernel::project_entity_storage(&state.entity, &live.entity_consensus)
                .map_err(internal)?;
        let profile = tagged_json_from_canonical_value(&projection.profile).map_err(internal)?;
        let config = tagged_json_from_canonical_value(&projection.config).map_err(internal)?;
        let entity_id = format!("0x{}", hex::encode(key.entity_id));
        let label = profile
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&entity_id);
        let mut summary = json!({"entityId":entity_id,"runtimeId":replica.durable.runtime_id(),"signerId":key.signer_id,
                    "label":label,"height":state.entity.height,"isHub":profile.get("isHub").and_then(Value::as_bool).unwrap_or(false)});
        if let Some(jurisdiction) = config.get("jurisdiction").filter(|value| !value.is_null()) {
            let mut fields = Map::new();
            for field in [
                "name",
                "address",
                "chainId",
                "depositoryAddress",
                "entityProviderAddress",
            ] {
                if let Some(value) = jurisdiction.get(field) {
                    fields.insert(field.into(), value.clone());
                }
            }
            if !fields.is_empty() {
                summary["jurisdiction"] = Value::Object(fields);
            }
        }
        summaries.push(summary);
    }
    let mut merged = std::collections::BTreeMap::new();
    for profile in profiles {
        let id = profile["entityId"]
            .as_str()
            .ok_or("E_INTERNAL:VERIFIED_PROFILE_ENTITY_ID")?
            .to_ascii_lowercase();
        let mut summary = json!({"entityId":id,"runtimeId":profile["runtimeId"],
                    "label":profile["name"],"height":profile["lastUpdated"],"isHub":profile["metadata"]["isHub"] == true});
        if let Some(jurisdiction) = profile["metadata"].get("jurisdiction") {
            summary["jurisdiction"] = jurisdiction.clone();
        }
        merged.insert(id, summary);
    }
    for mut summary in summaries {
        let id = summary["entityId"]
            .as_str()
            .expect("local summary id")
            .to_string();
        if let Some(gossip) = merged.get(&id) {
            if summary.get("jurisdiction").is_none()
                && let Some(jurisdiction) = gossip.get("jurisdiction")
            {
                summary["jurisdiction"] = jurisdiction.clone();
            }
            if summary["label"] == id {
                summary["label"] = gossip["label"].clone();
            }
        }
        merged.insert(id, summary);
    }
    Ok(Value::Array(merged.into_values().collect()))
}
