//! Historical RPC reads use only the retained canonical checkpoint and accepted WAL.
use serde_json::{Value, json};
use xln_rscore_runtime::{ResidentRuntimeService, restore::ConcreteCheckpointConfiguration};
fn error(value: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:HISTORY:{value}")
}
fn height(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .filter(|h| *h > 0 && *h <= 9_007_199_254_740_991)
        .ok_or("E_BAD_QUERY:heights must be positive safe integers".into())
}
pub(super) fn copy_config(c: &ConcreteCheckpointConfiguration) -> ConcreteCheckpointConfiguration {
    ConcreteCheckpointConfiguration {
        runtime_seed: c.runtime_seed.clone(),
        signer_derivation_labels: c.signer_derivation_labels.clone(),
        custody_import_keys: c.custody_import_keys.clone(),
        worker_count: c.worker_count,
        limits: c.limits,
        swap_market: c.swap_market.clone(),
        expected_protocol_fingerprint: c.expected_protocol_fingerprint,
        board_delays: c.board_delays,
    }
}

pub fn read_with_context(
    service: &mut ResidentRuntimeService,
    path: &str,
    query: &Value,
    config: &ConcreteCheckpointConfiguration,
) -> Result<Value, String> {
    service.sync_committed().map_err(error)?;
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    if let ["entity", entity_id, "account", peer_id] = parts.as_slice() {
        return account(service, query, config, entity_id, peer_id);
    }
    match path.trim_matches('/') {
        "frame-receipts" => super::receipts::read(service, query, config),
        "history-frame-batch" => batch(service, query, config),
        "view-frame" => view(service, query, config),
        _ => crate::runtime_adapter::views::read::read(service, path, query),
    }
}
fn view(
    service: &mut ResidentRuntimeService,
    query: &Value,
    config: &ConcreteCheckpointConfiguration,
) -> Result<Value, String> {
    let latest = service.processor().replica().map_err(error)?.state.height;
    let requested = query
        .get("atHeight")
        .filter(|v| !v.is_null())
        .map(height)
        .transpose()?
        .unwrap_or(latest);
    if requested == latest {
        return crate::runtime_adapter::views::read::read(service, "view-frame", query);
    }
    let head = service.adapter_storage_head().map_err(error)?;
    let sources = service.adapter_restore_sources().map_err(error)?;
    let mut restored = crate::runtime_adapter::history::restore::reconstruct_at_height(
        sources,
        copy_config(config),
        requested,
    )?;
    // Live Gossip never changes a historical financial view. Only actual restored owners appear.
    let (view, accounts) = crate::runtime_adapter::views::read::prepare_frame(
        &restored.replica,
        head,
        Vec::new(),
        query,
    )?;
    let rows = match accounts {
        Some((key, ids)) => restored
            .replica
            .e_replicas
            .get_mut(&key)
            .ok_or("E_INTERNAL:HISTORY_OWNER_MISSING")?
            .accounts
            .read_account_views(
                ids,
                crate::runtime_adapter::views::account_projection::account_view,
            )
            .map_err(error)?,
        None => Vec::new(),
    };
    crate::runtime_adapter::views::read::finish_frame(view, rows)
}
fn requested_heights(query: &Value) -> Result<Vec<u64>, String> {
    let values = match query.get("heights") {
        Some(Value::Array(values)) => values.clone(),
        Some(Value::String(text)) => text
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| Value::String(s.into()))
            .collect(),
        _ => return Err("E_BAD_QUERY:heights must contain at least one height".into()),
    };
    if values.is_empty() || values.len() > 128 {
        return Err("E_BAD_QUERY:heights batch must contain 1..128 entries".into());
    }
    let mut heights = Vec::new();
    for value in values {
        let value = height(&value)?;
        if !heights.contains(&value) {
            heights.push(value);
        }
    }
    Ok(heights)
}
fn batch(
    service: &mut ResidentRuntimeService,
    query: &Value,
    config: &ConcreteCheckpointConfiguration,
) -> Result<Value, String> {
    let requested = requested_heights(query)?;
    let mut base = query
        .as_object()
        .cloned()
        .ok_or("E_BAD_QUERY:query object required")?;
    base.remove("heights");
    let mut frames = Vec::new();
    let mut unavailable = Vec::new();
    for height in &requested {
        base.insert("atHeight".into(), json!(height));
        match view(service, &Value::Object(base.clone()), config) {
            Ok(frame) => frames.push(frame),
            Err(message) if message.starts_with("E_NOT_FOUND:") => {
                unavailable.push(json!({"height":height,"code":"E_NOT_FOUND","message":message}))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(json!({"requestedHeights":requested,"frames":frames,"unavailable":unavailable}))
}

fn account(
    service: &mut ResidentRuntimeService,
    query: &Value,
    config: &ConcreteCheckpointConfiguration,
    entity: &str,
    peer: &str,
) -> Result<Value, String> {
    let latest = service.processor().replica().map_err(error)?.state.height;
    let requested = query
        .get("atHeight")
        .filter(|v| !v.is_null())
        .map(height)
        .transpose()?
        .unwrap_or(latest);
    if requested == latest {
        return crate::runtime_adapter::views::account_read::read(service, entity, peer);
    }
    let sources = service.adapter_restore_sources().map_err(error)?;
    let mut restored = crate::runtime_adapter::history::restore::reconstruct_at_height(
        sources,
        copy_config(config),
        requested,
    )?;
    let (key, id) =
        crate::runtime_adapter::views::account_read::owner(&restored.replica, entity, peer)?;
    let rows = restored
        .replica
        .e_replicas
        .get_mut(&key)
        .ok_or("E_INTERNAL:HISTORY_OWNER_MISSING")?
        .accounts
        .read_account_views(
            vec![id],
            crate::runtime_adapter::views::account_projection::account_view,
        )
        .map_err(error)?;
    crate::runtime_adapter::views::account_read::document(rows, id)
}
