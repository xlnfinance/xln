//! Checkpoint-side mirror of `core/rscore/entity/round-wire.ts` pair policy.

use std::collections::BTreeSet;

use serde_json::{Map, Number, Value};
use xln_rscore_engine::{SwapMarketPolicy, SwapToken};
use xln_rscore_entity_kernel::{
    PairDimensions, canonical_pair_orientation, canonical_pair_policy, canonical_token_decimals,
    is_canonical_liquid_token,
};

use super::EntityContextJsonError;

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityContextJsonError> {
    value
        .as_object()
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))
}

fn required<'a>(
    value: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<&'a Value, EntityContextJsonError> {
    value
        .get(field)
        .ok_or_else(|| EntityContextJsonError::MissingField(format!("{path}.{field}")))
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, EntityContextJsonError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| EntityContextJsonError::InvalidValue(path.into()))
}

fn pair_tokens(pair: &str) -> Result<(u32, u32), EntityContextJsonError> {
    let Some((left, right)) = pair.split_once('/') else {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "pairId.{pair}"
        )));
    };
    let left = left
        .parse::<u32>()
        .map_err(|_| EntityContextJsonError::InvalidValue(format!("pairId.{pair}")))?;
    let right = right
        .parse::<u32>()
        .map_err(|_| EntityContextJsonError::InvalidValue(format!("pairId.{pair}")))?;
    if left == 0 || right == 0 || left >= right {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "pairId.{pair}"
        )));
    }
    Ok((left, right))
}

/// The Rust Runtime owns the same protocol registry that TypeScript installs
/// in Account authority Hello. Keep the table in this one module so Entity
/// context projection and Account swap quantization cannot drift apart.
pub fn canonical_swap_market_policy() -> SwapMarketPolicy {
    let tokens = (1..=5)
        .map(|token_id| SwapToken {
            token_id,
            decimals: canonical_token_decimals(token_id).unwrap_or_default(),
            liquid: is_canonical_liquid_token(token_id),
        })
        .collect::<Vec<_>>();
    let mut steps = Vec::new();
    for left in 1..=5 {
        for right in 1..=5 {
            if left != right {
                steps.push(((left, right), 1));
            }
        }
    }
    SwapMarketPolicy::new(tokens, steps)
}

fn pair_policy(
    pair: &str,
    dimensions: &Map<String, Value>,
) -> Result<Value, EntityContextJsonError> {
    let (left, right) = pair_tokens(pair)?;
    let (base, quote) = canonical_pair_orientation(left, right);
    let base_decimals = safe_u64(
        required(dimensions, "baseTokenDecimals", "pairDimensions")?,
        "pairDimensions.baseTokenDecimals",
    )?;
    let quote_decimals = safe_u64(
        required(dimensions, "quoteTokenDecimals", "pairDimensions")?,
        "pairDimensions.quoteTokenDecimals",
    )?;
    let (policy, _) = canonical_pair_policy(
        base,
        quote,
        PairDimensions {
            base_token_decimals: u32::try_from(base_decimals)
                .map_err(|_| EntityContextJsonError::InvalidValue("baseTokenDecimals".into()))?,
            quote_token_decimals: u32::try_from(quote_decimals)
                .map_err(|_| EntityContextJsonError::InvalidValue("quoteTokenDecimals".into()))?,
        },
    );
    Ok(Value::Array(vec![
        Value::String(pair.into()),
        Value::Number(Number::from(policy.price_step_ticks)),
        Value::Number(Number::from(policy.book_bucket_width_ticks)),
        Value::String(policy.mid_price_ticks.to_string()),
    ]))
}

fn pair_policies(core: &Map<String, Value>) -> Result<Vec<Value>, EntityContextJsonError> {
    // TS `entityDeterministicContextWire` emits an empty pair vector until
    // `initOrderbookExt` installs the optional orderbook state.
    let Some(dimensions) = core.get("orderbookPairDimensions") else {
        return Ok(Vec::new());
    };
    let tagged = object(dimensions, "state.core.orderbookPairDimensions")?;
    if required(tagged, "__xlnType", "orderbookPairDimensions")?.as_str() != Some("Map") {
        return Err(EntityContextJsonError::InvalidValue(
            "state.core.orderbookPairDimensions.__xlnType".into(),
        ));
    }
    let rows = required(tagged, "value", "orderbookPairDimensions")?
        .as_array()
        .ok_or_else(|| {
            EntityContextJsonError::InvalidType("orderbookPairDimensions.value".into())
        })?;
    let mut seen = BTreeSet::new();
    let mut policies = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let row = row.as_array().filter(|row| row.len() == 2).ok_or_else(|| {
            EntityContextJsonError::InvalidValue(format!("orderbookPairDimensions.value[{index}]"))
        })?;
        let pair = row[0]
            .as_str()
            .ok_or_else(|| EntityContextJsonError::InvalidType(format!("pairId[{index}]")))?;
        if !seen.insert(pair) {
            return Err(EntityContextJsonError::DuplicatePair(pair.into()));
        }
        policies.push(pair_policy(
            pair,
            object(&row[1], &format!("pairDimensions[{pair}]"))?,
        )?);
    }
    policies.sort_by(|left, right| left[0].as_str().cmp(&right[0].as_str()));
    Ok(policies)
}

fn swap_taker_fee(core: &Map<String, Value>) -> Result<u64, EntityContextJsonError> {
    let Some(value) = core.get("hubRebalanceConfig") else {
        return Ok(0);
    };
    let rebalance = object(value, "state.core.hubRebalanceConfig")?;
    let fee = safe_u64(
        required(rebalance, "swapTakerFeeBps", "hubRebalanceConfig")?,
        "hubRebalanceConfig.swapTakerFeeBps",
    )?;
    if fee <= 10_000 {
        Ok(fee)
    } else {
        Err(EntityContextJsonError::InvalidValue(
            "hubRebalanceConfig.swapTakerFeeBps".into(),
        ))
    }
}

/// Derive the deterministic market policy from the same certified Entity
/// fields consumed by TypeScript's `entityDeterministicContextWire`.
pub(crate) fn entity_context_policy_from_core(
    core: &Value,
    active_jurisdiction: Option<&Value>,
) -> Result<Value, EntityContextJsonError> {
    let core = object(core, "state.core")?;
    // `orderbookExt` is optional in canonical TS state. Before its init tx,
    // the deterministic context is minTradeSize=0 and has no pair policies.
    let minimum_trade_size = match core.get("orderbookHubProfile") {
        Some(value) => required(
            object(value, "state.core.orderbookHubProfile")?,
            "minTradeSize",
            "orderbookHubProfile",
        )?
        .clone(),
        None => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("BigInt".into())),
            ("value".into(), Value::String("0".into())),
        ])),
    };
    let fee = swap_taker_fee(core)?;
    let jurisdiction = match active_jurisdiction {
        Some(Value::String(value)) if !value.is_empty() => Value::String(value.clone()),
        Some(Value::Null) | None => Value::Null,
        Some(_) => {
            return Err(EntityContextJsonError::InvalidType(
                "activeJurisdiction".into(),
            ));
        }
    };
    Ok(Value::Object(Map::from_iter([
        ("minimumTradeSize".into(), minimum_trade_size),
        ("swapTakerFeeBps".into(), Value::Number(Number::from(fee))),
        ("jurisdictionId".into(), jurisdiction),
        ("pairPolicies".into(), Value::Array(pair_policies(core)?)),
    ])))
}

pub fn entity_context_policy_from_checkpoint(
    replica: &Value,
    active_jurisdiction: Option<&Value>,
) -> Result<Value, EntityContextJsonError> {
    let state = object(
        required(object(replica, "replica")?, "state", "replica")?,
        "state",
    )?;
    entity_context_policy_from_core(required(state, "core", "state")?, active_jurisdiction)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{canonical_swap_market_policy, entity_context_policy_from_core};

    #[test]
    fn canonical_swap_market_digest_matches_typescript_registry() {
        assert_eq!(
            hex::encode(canonical_swap_market_policy().digest()),
            "5930755c012ffea403a64757a44e8e8696231ecbb9392213c9409feabb546f94",
        );
    }

    #[test]
    fn authenticated_core_projects_the_typescript_context_policy_golden() {
        let entity = format!("0x{}", "11".repeat(32));
        let core = json!({
            "orderbookHubProfile": {
                "minTradeSize": { "__xlnType": "BigInt", "value": "250" },
            },
            "hubRebalanceConfig": { "swapTakerFeeBps": 37 },
            "orderbookPairDimensions": {
                "__xlnType": "Map",
                "value": [["1/2", {
                    "baseTokenDecimals": 18,
                    "quoteTokenDecimals": 6,
                }]],
            },
        });
        assert_eq!(
            entity_context_policy_from_core(&core, Some(&json!(entity))).expect("policy"),
            json!({
                "minimumTradeSize": { "__xlnType": "BigInt", "value": "250" },
                "swapTakerFeeBps": 37,
                "jurisdictionId": entity,
                "pairPolicies": [["1/2", 1, 10_000, "25000000"]],
            }),
        );
    }

    #[test]
    fn absent_hub_rebalance_config_projects_the_typescript_zero_fee() {
        let core = json!({
            "orderbookHubProfile": {
                "minTradeSize": { "__xlnType": "BigInt", "value": "0" },
            },
            "orderbookPairDimensions": {
                "__xlnType": "Map",
                "value": [],
            },
        });
        assert_eq!(
            entity_context_policy_from_core(&core, None).expect("policy"),
            json!({
                "minimumTradeSize": { "__xlnType": "BigInt", "value": "0" },
                "swapTakerFeeBps": 0,
                "jurisdictionId": null,
                "pairPolicies": [],
            }),
        );
    }

    #[test]
    fn absent_orderbook_projects_the_typescript_pre_init_policy() {
        assert_eq!(
            entity_context_policy_from_core(&json!({}), None).expect("pre-init policy"),
            json!({
                "minimumTradeSize": { "__xlnType": "BigInt", "value": "0" },
                "swapTakerFeeBps": 0,
                "jurisdictionId": null,
                "pairPolicies": [],
            }),
        );
    }
}
