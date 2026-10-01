//! Read-only product projection of the committed Entity lending collection.
use num_bigint::BigInt;
use serde_json::{Value, json};
use xln_rscore_entity_kernel::{LendingLoanStatus, LendingState, canonical_lending_state};
use xln_rscore_protocol::CanonicalValue;

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

fn product_json(value: CanonicalValue) -> Result<Value, String> {
    match value {
        CanonicalValue::String(text) => Ok(Value::String(text)),
        CanonicalValue::BigInt(amount) => Ok(Value::String(amount.to_string())),
        CanonicalValue::Number(number) => {
            serde_json::from_str(number.as_str()).map_err(|error| error.to_string())
        }
        CanonicalValue::Object(fields) => fields
            .into_iter()
            .map(|(name, value)| Ok((name, product_json(value)?)))
            .collect::<Result<serde_json::Map<_, _>, String>>()
            .map(Value::Object),
        _ => Err("RRS_LENDING_PRODUCT_VALUE_INVALID".into()),
    }
}

pub fn lending_state_response(
    state: Option<&LendingState>,
    query: &LendingStateQuery,
) -> Result<Value, String> {
    let empty = LendingState::empty();
    let state = state.unwrap_or(&empty);
    let matches_token = |token: u16| {
        query
            .token_id
            .is_none_or(|filter| f64::from(token) == filter)
    };
    let pools = state
        .pools()
        .filter(|pool| matches_token(pool.token_id))
        .collect::<Vec<_>>();
    let loans = state
        .loans()
        .filter(|loan| matches_token(loan.token_id))
        .collect::<Vec<_>>();
    // TS totals describe the selected token's entire hub, even for a user-filtered response.
    let available: BigInt = pools.iter().map(|pool| &pool.available_amount).sum();
    let borrowed: BigInt = pools.iter().map(|pool| &pool.borrowed_amount).sum();
    let active: BigInt = loans
        .iter()
        .filter(|loan| {
            matches!(
                loan.status,
                LendingLoanStatus::Opening | LendingLoanStatus::Active | LendingLoanStatus::Closing
            )
        })
        .map(|loan| &loan.principal_amount)
        .sum();
    let CanonicalValue::Object(fields) =
        canonical_lending_state(state).map_err(|error| error.to_string())?
    else {
        return Err("RRS_LENDING_STATE_OBJECT".into());
    };
    let mut response = json!({"success":true,"hubEntityId":query.hub_entity_id_text,"totals":{"availableAmount":available.to_string(),"borrowedAmount":borrowed.to_string(),"activePrincipalAmount":active.to_string()}});
    for (name, collection) in fields {
        let CanonicalValue::Map(entries) = collection else {
            return Err("RRS_LENDING_STATE_MAP".into());
        };
        let mut rows = entries
            .into_iter()
            .map(|(_, value)| product_json(value))
            .collect::<Result<Vec<_>, _>>()?;
        rows.retain(|row| {
            query
                .token_id
                .is_none_or(|token| row["tokenId"].as_f64() == Some(token))
                && (query.user_entity_id.is_empty()
                    || row["lenderEntityId"]
                        .as_str()
                        .is_some_and(|id| id.eq_ignore_ascii_case(&query.user_entity_id))
                    || (name == "loans"
                        && row["borrowerEntityId"]
                            .as_str()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&query.user_entity_id))))
        });
        let id = if name == "pools" {
            "positionId"
        } else {
            "loanId"
        };
        rows.sort_by(|a, b| {
            b["updatedAt"]
                .as_u64()
                .cmp(&a["updatedAt"].as_u64())
                .then_with(|| a[id].as_str().cmp(&b[id].as_str()))
        });
        response[name] = Value::Array(rows);
    }
    Ok(response)
}

#[cfg(test)]
#[path = "lending_tests.rs"]
mod tests;
