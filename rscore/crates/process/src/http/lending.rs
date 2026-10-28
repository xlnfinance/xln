//! Read-only product projection of the committed Entity lending collection.
use serde_json::Value;
use xln_rscore_entity_kernel::LendingState;

pub struct LendingStateQuery {
    pub hub_entity_id: [u8; 32],
    pub hub_entity_id_text: String,
    pub user_entity_id: String,
    pub token_id: Option<f64>,
    pub request_id: Option<String>,
}

impl LendingStateQuery {
    pub fn parse(target: &str) -> Result<Self, &'static str> {
        let params =
            form_urlencoded::parse(target.split_once('?').map_or("", |(_, q)| q).as_bytes())
                .collect::<Vec<_>>();
        let get = |name: &str| {
            params
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_ref())
        };
        let hub_entity_id_text = get("hubEntityId").unwrap_or("").trim().to_ascii_lowercase();
        let decode = |text: &str| {
            text.strip_prefix("0x")
                .and_then(|hex| hex::decode(hex).ok())
                .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        };
        let hub_entity_id = decode(&hub_entity_id_text).ok_or("Invalid hubEntityId")?;
        let user_entity_id = get("userEntityId")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !user_entity_id.is_empty() && decode(&user_entity_id).is_none() {
            return Err("Invalid userEntityId");
        }
        let token_id = get("tokenId")
            .map(|value| {
                let value = value
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| "Invalid tokenId")?
                    .floor();
                if value.is_finite() && value > 0.0 {
                    Ok(value)
                } else {
                    Err("Invalid tokenId")
                }
            })
            .transpose()?;
        let request_id = get("requestId").map(str::to_owned);
        if request_id.as_ref().is_some_and(|id| {
            user_entity_id.is_empty()
                || !id.strip_prefix("borrow-").is_some_and(|s| {
                    s.len() == 16
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
        }) {
            return Err("Invalid borrower request");
        }
        Ok(Self {
            hub_entity_id,
            hub_entity_id_text,
            user_entity_id,
            token_id,
            request_id,
        })
    }
}

pub fn lending_state_response(
    state: Option<&LendingState>,
    query: &LendingStateQuery,
    timestamp: u64,
    accounts: &std::collections::BTreeMap<String, xln_rscore_engine::lending::LendingAccountView>,
) -> Result<Value, String> {
    let summary = xln_rscore_entity_kernel::summarize_lending_state(
        state,
        timestamp,
        &query.user_entity_id,
        query.token_id,
        query.request_id.as_deref(),
        accounts,
    )
    .map_err(|e| e.to_string())?;
    let mut result = json_value(&summary)?;
    result["success"] = Value::Bool(true);
    result["hubEntityId"] = Value::String(query.hub_entity_id_text.clone());
    result["requestId"] = query.request_id.clone().map_or(Value::Null, Value::String);
    Ok(result)
}
fn json_value(v: &xln_rscore_protocol::CanonicalValue) -> Result<Value, String> {
    use xln_rscore_protocol::CanonicalValue as V;
    Ok(match v {
        V::Null => Value::Null,
        V::Bool(v) => Value::Bool(*v),
        V::String(v) => Value::String(v.clone()),
        V::BigInt(v) => Value::String(v.to_string()),
        V::Number(v) => serde_json::from_str(v.as_str()).map_err(|e| e.to_string())?,
        V::Array(rows) => Value::Array(rows.iter().map(json_value).collect::<Result<_, _>>()?),
        V::Object(rows) => Value::Object(
            rows.iter()
                .map(|(k, v)| Ok((k.clone(), json_value(v)?)))
                .collect::<Result<_, String>>()?,
        ),
        _ => return Err("LENDING_PROJECTION_COLLECTION".into()),
    })
}

#[cfg(test)]
#[path = "lending_tests.rs"]
mod tests;
