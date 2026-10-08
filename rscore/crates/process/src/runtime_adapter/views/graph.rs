//! Compact graph DTO from the current committed Runtime and its account read heads.
use serde_json::{Value, json};
use xln_rscore_engine::{AccountConsensus, StateError, canonical_tx_value};
use xln_rscore_protocol::CanonicalValue;
use xln_rscore_runtime::{ResidentRuntimeService, tagged_json_from_canonical_value};

fn internal(error: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:{error}")
}
fn select(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|field| value.get(*field).map(|v| ((*field).into(), v.clone())))
            .collect(),
    )
}
fn activities(txs: &[xln_rscore_engine::AccountTx]) -> Result<Value, StateError> {
    let rows = txs
        .iter()
        .skip(txs.len().saturating_sub(2))
        .map(|tx| {
            let wire = canonical_tx_value(tx)?;
            let wire = tagged_json_from_canonical_value(&wire)
                .map_err(|e| StateError::Envelope(e.to_string()))?;
            let mut row = select(
                &wire["data"],
                &["tokenId", "amount", "fromEntityId", "toEntityId"],
            );
            row["type"] = wire["type"].clone();
            Ok(row)
        })
        .collect::<Result<Vec<_>, StateError>>()?;
    Ok(Value::Array(rows))
}
fn account(account: &AccountConsensus) -> Result<CanonicalValue, StateError> {
    let wire = crate::runtime_adapter::views::account_projection::account_view(account)?;
    let wire =
        tagged_json_from_canonical_value(&wire).map_err(|e| StateError::Envelope(e.to_string()))?;
    let mut result = select(
        &wire,
        &[
            "status",
            "currentHeight",
            "rollbackCount",
            "lastRollbackFrameHash",
        ],
    );
    for field in ["leftEntity", "rightEntity"] {
        result[field] = wire["state"][field].clone();
    }
    let deltas = CanonicalValue::Map(
        account
            .replica()
            .state()
            .deltas()
            .map(|d| {
                (
                    crate::runtime_adapter::views::account_projection::token(d.token_id().get()),
                    crate::runtime_adapter::views::account_projection::delta(d),
                )
            })
            .collect(),
    );
    result["deltas"] = tagged_json_from_canonical_value(&deltas)
        .map_err(|e| StateError::Envelope(e.to_string()))?;
    result["mempool"] = activities(account.mempool())?;
    result["mempoolCount"] = json!(account.mempool().len());
    result["currentFrame"] = wire["currentFrame"].clone();
    result["currentFrame"]["accountTxCount"] =
        json!(account.current().map_or(0, |f| f.frame.txs.len()));
    result["currentFrame"]["accountTxs"] = match account.current() {
        Some(f) => activities(&f.frame.txs)?,
        None => json!([]),
    };
    if let Some(pending) = account.pending() {
        result["pendingFrame"] = wire["pendingFrame"].clone();
        result["pendingFrame"]["accountTxCount"] = json!(pending.frame.txs.len());
        result["pendingFrame"]["accountTxs"] = activities(&pending.frame.txs)?;
    }
    if let Some(dispute) = wire.get("activeDispute") {
        result["activeDispute"] = select(
            dispute,
            &["startedByLeft", "disputeTimeout", "initialNonce"],
        );
    }
    xln_rscore_runtime::canonical_value_from_tagged_json(&result)
        .map_err(|e| StateError::Envelope(e.to_string()))
}
fn limit(query: &Value, field: &str) -> Result<usize, String> {
    let Some(value) = query.get(field).filter(|v| !v.is_null()) else {
        return Ok(500);
    };
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
        .ok_or("E_BAD_QUERY:graph limit")?;
    if !number.is_finite() {
        return Err("E_BAD_QUERY:graph limit must be finite".into());
    }
    Ok(number.floor().clamp(1.0, 500.0) as usize)
}
fn empty_page(limit: usize) -> Value {
    json!({"items":[],"nextCursor":null,"totalItems":0,"limit":limit,"pageIndex":0,"pageCount":0})
}
pub fn read(service: &mut ResidentRuntimeService, query: &Value) -> Result<Value, String> {
    let summaries = crate::runtime_adapter::views::read::read(service, "entities", query)?;
    let entity_limit = limit(query, "limit")?;
    let accounts_limit = limit(query, "accountsLimit")?;
    let summaries = summaries.as_array().ok_or("E_INTERNAL:GRAPH_SUMMARIES")?;
    if summaries.len() > entity_limit {
        return Err("E_BAD_QUERY:graph entity limit exceeded".into());
    }
    let (height, timestamp, runtime_id) = {
        let replica = service.processor().replica().map_err(internal)?;
        (
            replica.state.height,
            replica.state.timestamp,
            replica.durable.runtime_id().to_string(),
        )
    };
    let head = service.adapter_storage_head().map_err(internal)?;
    let mut entities = Vec::new();
    let mut observations = 0;
    for summary in summaries {
        let id = summary["entityId"]
            .as_str()
            .ok_or("E_INTERNAL:GRAPH_ENTITY_ID")?;
        let owned = service
            .processor()
            .replica()
            .map_err(internal)?
            .state
            .e_replicas
            .iter()
            .find(|(key, _)| format!("0x{}", hex::encode(key.entity_id)).eq_ignore_ascii_case(id))
            .map(|(key, state)| {
                (
                    key.clone(),
                    state
                        .entity
                        .known_accounts
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            });
        let Some((key, mut peers)) = owned else {
            entities
                .push(json!({"summary":summary,"core":null,"accounts":empty_page(accounts_limit)}));
            continue;
        };
        peers.sort();
        observations += peers.len();
        if observations > accounts_limit {
            return Err("E_BAD_QUERY:graph account observation limit exceeded".into());
        }
        let ids = peers
            .iter()
            .map(|id| {
                let bytes =
                    hex::decode(id.strip_prefix("0x").ok_or("E_INTERNAL:GRAPH_ACCOUNT_ID")?)
                        .map_err(internal)?;
                Ok(xln_rscore_batch::AccountId::from_bytes(
                    bytes
                        .try_into()
                        .map_err(|_| "E_INTERNAL:GRAPH_ACCOUNT_WIDTH")?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let rows = service
            .read_account_views(&key, ids, account)
            .map_err(internal)?;
        let items = rows
            .into_iter()
            .map(|(_, row)| tagged_json_from_canonical_value(&row).map_err(internal))
            .collect::<Result<Vec<_>, _>>()?;
        let source =
            crate::runtime_adapter::views::read::read(service, &format!("entity/{id}"), query)?;
        let mut core = select(
            &source,
            &[
                "entityId",
                "signerId",
                "height",
                "timestamp",
                "prevFrameHash",
                "reserves",
            ],
        );
        core["profile"] = select(&source["profile"], &["name", "isHub"]);
        if let Some(is_hub) = source["profile"].get("isHub") {
            core["isHub"] = is_hub.clone();
        }
        entities.push(json!({"summary":summary,"core":core,"accounts":{"items":items,"nextCursor":null,"totalItems":peers.len(),"limit":accounts_limit,"pageIndex":0,"pageCount":peers.len().div_ceil(accounts_limit)}}));
    }
    append_endpoints(
        &mut entities,
        entity_limit,
        accounts_limit,
        &runtime_id,
        height,
    )?;
    let state_hash = if height > 0 {
        crate::runtime_adapter::views::read::read(
            service,
            &format!("frame/{height}"),
            &Value::Null,
        )?["stateHash"]
            .clone()
    } else {
        json!("")
    };
    Ok(
        json!({"head":head,"runtimeId":runtime_id,"height":height,"timestamp":timestamp,"stateHash":state_hash,"entities":entities}),
    )
}
fn append_endpoints(
    entities: &mut Vec<Value>,
    entity_limit: usize,
    accounts_limit: usize,
    runtime_id: &str,
    height: u64,
) -> Result<(), String> {
    let mut known = entities
        .iter()
        .filter_map(|e| {
            e["summary"]["entityId"]
                .as_str()
                .map(str::to_ascii_lowercase)
        })
        .collect::<std::collections::BTreeSet<_>>();
    let endpoints = entities
        .iter()
        .flat_map(|entity| entity["accounts"]["items"].as_array().into_iter().flatten())
        .flat_map(|account| {
            [
                account["leftEntity"].as_str(),
                account["rightEntity"].as_str(),
            ]
        })
        .flatten()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    for id in endpoints {
        if !known.insert(id.clone()) {
            continue;
        }
        if entities.len() >= entity_limit {
            return Err("E_BAD_QUERY:graph endpoint limit exceeded".into());
        }
        entities.push(json!({"summary":{"entityId":id,"runtimeId":runtime_id,"label":id,"height":height},"core":null,"accounts":empty_page(accounts_limit)}));
    }
    entities.sort_by(|a, b| {
        a["summary"]["entityId"]
            .as_str()
            .cmp(&b["summary"]["entityId"].as_str())
    });
    Ok(())
}
