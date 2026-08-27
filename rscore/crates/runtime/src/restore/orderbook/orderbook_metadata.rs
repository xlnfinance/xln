//! Exact inverse of the Entity orderbook metadata fields (tags 35..37).

use std::collections::BTreeMap;

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    EntityReferral, HubProfile, OrderbookConsensusMetadata, PairDimensions, SpreadDistribution,
};

#[derive(Debug, Error)]
pub enum OrderbookMetadataRestoreError {
    #[error("RRS_RESTORE_ORDERBOOK_METADATA:{0}")]
    Invalid(String),
}

fn invalid(detail: impl Into<String>) -> OrderbookMetadataRestoreError {
    OrderbookMetadataRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, OrderbookMetadataRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), OrderbookMetadataRestoreError> {
    let mut actual = value.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn text(value: &Value, path: &str) -> Result<String, OrderbookMetadataRestoreError> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn entity(value: &Value, path: &str) -> Result<String, OrderbookMetadataRestoreError> {
    let value = text(value, path)?;
    if value.len() != 66
        || !value.starts_with("0x")
        || value[2..]
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!("ENTITY:{path}")));
    }
    Ok(value)
}

fn unsigned(value: &Value, path: &str) -> Result<u64, OrderbookMetadataRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn u32_value(value: &Value, path: &str) -> Result<u32, OrderbookMetadataRestoreError> {
    u32::try_from(unsigned(value, path)?).map_err(|_| invalid(format!("U32:{path}")))
}

fn bigint(value: &Value, path: &str) -> Result<BigInt, OrderbookMetadataRestoreError> {
    let value = object(value, path)?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(invalid(format!("BIGINT:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("BIGINT:{path}")))?
        .parse()
        .map_err(|_| invalid(format!("BIGINT:{path}")))
}

fn tagged_map<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a [Value], OrderbookMetadataRestoreError> {
    let value = object(value, path)?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(invalid(format!("MAP:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("MAP_ROWS:{path}")))
}

fn decode_profile(value: &Value) -> Result<HubProfile, OrderbookMetadataRestoreError> {
    let profile = object(value, "orderbookHubProfile")?;
    exact_fields(
        profile,
        &[
            "entityId",
            "name",
            "spreadDistribution",
            "referenceTokenId",
            "usdQuoteAuthorityEntityId",
            "minTradeSize",
            "supportedPairs",
        ],
        "orderbookHubProfile",
    )?;
    let spread = object(&profile["spreadDistribution"], "spreadDistribution")?;
    exact_fields(
        spread,
        &[
            "makerBps",
            "takerBps",
            "hubBps",
            "makerReferrerBps",
            "takerReferrerBps",
        ],
        "spreadDistribution",
    )?;
    let supported_pairs = profile["supportedPairs"]
        .as_array()
        .ok_or_else(|| invalid("SUPPORTED_PAIRS"))?
        .iter()
        .enumerate()
        .map(|(index, value)| text(value, &format!("supportedPairs.{index}")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(HubProfile {
        entity_id: entity(&profile["entityId"], "hubProfile.entityId")?,
        name: text(&profile["name"], "hubProfile.name")?,
        spread_distribution: SpreadDistribution {
            maker_bps: u32_value(&spread["makerBps"], "spread.makerBps")?,
            taker_bps: u32_value(&spread["takerBps"], "spread.takerBps")?,
            hub_bps: u32_value(&spread["hubBps"], "spread.hubBps")?,
            maker_referrer_bps: u32_value(&spread["makerReferrerBps"], "spread.makerReferrerBps")?,
            taker_referrer_bps: u32_value(&spread["takerReferrerBps"], "spread.takerReferrerBps")?,
        },
        reference_token_id: u32_value(&profile["referenceTokenId"], "referenceTokenId")?,
        usd_quote_authority_entity_id: entity(
            &profile["usdQuoteAuthorityEntityId"],
            "usdQuoteAuthorityEntityId",
        )?,
        min_trade_size: bigint(&profile["minTradeSize"], "minTradeSize")?,
        supported_pairs,
    })
}

fn decode_dimensions(
    value: &Value,
) -> Result<BTreeMap<String, PairDimensions>, OrderbookMetadataRestoreError> {
    let mut output = BTreeMap::new();
    for (index, row) in tagged_map(value, "orderbookPairDimensions")?
        .iter()
        .enumerate()
    {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("DIMENSION_ROW:{index}")))?;
        let pair = text(&row[0], "dimension.pair")?;
        let dimensions = object(&row[1], "dimension.value")?;
        exact_fields(
            dimensions,
            &["baseTokenDecimals", "quoteTokenDecimals"],
            "dimension.value",
        )?;
        let value = PairDimensions {
            base_token_decimals: u32_value(&dimensions["baseTokenDecimals"], "baseTokenDecimals")?,
            quote_token_decimals: u32_value(
                &dimensions["quoteTokenDecimals"],
                "quoteTokenDecimals",
            )?,
        };
        if output.insert(pair.clone(), value).is_some() {
            return Err(invalid(format!("DIMENSION_DUPLICATE:{pair}")));
        }
    }
    Ok(output)
}

fn decode_referrals(
    value: Option<&Value>,
) -> Result<BTreeMap<String, EntityReferral>, OrderbookMetadataRestoreError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let mut output = BTreeMap::new();
    for (index, row) in tagged_map(value, "orderbookReferrals")?.iter().enumerate() {
        let row = row
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("REFERRAL_ROW:{index}")))?;
        let key = entity(&row[0], "referral.key")?;
        let referral = object(&row[1], "referral.value")?;
        exact_fields(
            referral,
            &["entityId", "referrerId", "timestamp"],
            "referral.value",
        )?;
        let entity_id = entity(&referral["entityId"], "referral.entityId")?;
        if entity_id != key {
            return Err(invalid(format!("REFERRAL_KEY:{key}:{entity_id}")));
        }
        let referrer_id = match &referral["referrerId"] {
            Value::Null => None,
            value => Some(entity(value, "referral.referrerId")?),
        };
        let value = EntityReferral {
            entity_id,
            referrer_id,
            timestamp: unsigned(&referral["timestamp"], "referral.timestamp")?,
        };
        if output.insert(key.clone(), value).is_some() {
            return Err(invalid(format!("REFERRAL_DUPLICATE:{key}")));
        }
    }
    Ok(output)
}

pub struct HydratedOrderbookMetadata {
    pub metadata: OrderbookConsensusMetadata,
    pub pair_dimensions: BTreeMap<String, PairDimensions>,
}

pub fn hydrate_orderbook_metadata(
    core: &Map<String, Value>,
) -> Result<Option<HydratedOrderbookMetadata>, OrderbookMetadataRestoreError> {
    let has_any = core.contains_key("orderbookHubProfile")
        || core.contains_key("orderbookReferrals")
        || core.contains_key("orderbookPairDimensions");
    if !has_any {
        return Ok(None);
    }
    let profile = core
        .get("orderbookHubProfile")
        .ok_or_else(|| invalid("HUB_PROFILE_MISSING"))?;
    let dimensions = core
        .get("orderbookPairDimensions")
        .ok_or_else(|| invalid("PAIR_DIMENSIONS_MISSING"))?;
    Ok(Some(HydratedOrderbookMetadata {
        metadata: OrderbookConsensusMetadata {
            hub_profile: decode_profile(profile)?,
            referrals: decode_referrals(core.get("orderbookReferrals"))?,
        },
        pair_dimensions: decode_dimensions(dimensions)?,
    }))
}
