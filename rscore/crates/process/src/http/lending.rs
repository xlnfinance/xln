//! Read-only product projection of the committed Entity lending collection.
use serde_json::Value;
use xln_rscore_entity_kernel::LendingState;

pub struct LendingStateQuery {
    pub hub_entity_id: [u8; 32],
    pub hub_entity_id_text: String,
    pub user_entity_id: String,
    pub token_id: Option<f64>,
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
        Ok(Self {
            hub_entity_id,
            hub_entity_id_text,
            user_entity_id,
            token_id,
        })
    }
}

pub fn lending_state_response(
    _state: Option<&LendingState>,
    _query: &LendingStateQuery,
) -> Result<Value, String> {
    Err("LENDING_UNSUPPORTED".into())
}

#[cfg(test)]
#[path = "lending_tests.rs"]
mod tests;
