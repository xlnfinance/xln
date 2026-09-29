//! Canonical cross-jurisdiction route and route hash (TS
//! `withCanonicalCrossJurisdictionRouteHash`). One implementation serves the
//! Account layer (pull-lock admission rejects a non-canonical route, like TS)
//! and the Entity kernel.
use ethabi::Token;
use ethabi::ethereum_types::U256;
use num_bigint::{BigInt, BigUint, Sign};
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

fn object(value: &CanonicalValue) -> Option<&[(String, CanonicalValue)]> {
    match value {
        CanonicalValue::Object(fields) => Some(fields),
        _ => None,
    }
}

fn object_mut(value: &mut CanonicalValue) -> Option<&mut Vec<(String, CanonicalValue)>> {
    match value {
        CanonicalValue::Object(fields) => Some(fields),
        _ => None,
    }
}

fn field<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a CanonicalValue> {
    object(value)?
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn text<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a str> {
    match field(value, name)? {
        CanonicalValue::String(value) => Some(value),
        _ => None,
    }
}

fn nested_text<'a>(value: &'a CanonicalValue, parent: &str, name: &str) -> Option<&'a str> {
    text(field(value, parent)?, name)
}

fn unsigned(value: &CanonicalValue, name: &str) -> Option<u64> {
    match field(value, name)? {
        CanonicalValue::Number(value) => value.as_str().parse().ok(),
        _ => None,
    }
}

fn bigint(value: &CanonicalValue, name: &str) -> Option<BigInt> {
    match field(value, name)? {
        CanonicalValue::BigInt(value) => Some(value.clone()),
        CanonicalValue::Number(value) => value.as_str().parse().ok(),
        _ => None,
    }
}

fn required_u32(value: &CanonicalValue, name: &'static str) -> Result<u32, String> {
    unsigned(value, name)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("{name}:U32"))
}

fn required_bigint(value: &CanonicalValue, name: &'static str) -> Result<BigInt, String> {
    bigint(value, name).ok_or_else(|| format!("{name}:BIGINT"))
}

fn set(value: &mut CanonicalValue, key: &str, next: CanonicalValue) -> Result<(), String> {
    let fields = object_mut(value).ok_or_else(|| "CROSS_J_OBJECT_REQUIRED".to_string())?;
    if let Some((_, value)) = fields.iter_mut().find(|(field, _)| field == key) {
        *value = next;
    } else {
        fields.push((key.to_string(), next));
    }
    Ok(())
}

fn string(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(value: u64, name: &'static str) -> Result<CanonicalValue, String> {
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value).map_err(|_| format!("{name}:UNSAFE"))?,
    ))
}

fn normalized(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

/// TS canonical liquid tokens (orderbook policy).
pub fn is_canonical_liquid_token(token_id: u32) -> bool {
    matches!(token_id, 1 | 3)
}

pub fn positive_u256(value: &BigInt, name: &'static str) -> Result<U256, String> {
    if value.sign() == Sign::Minus {
        return Err(format!("{name}:NEGATIVE"));
    }
    let bytes = value.to_biguint().unwrap_or_default().to_bytes_be();
    if bytes.len() > 32 {
        return Err(format!("{name}:UINT256"));
    }
    Ok(U256::from_big_endian(&bytes))
}

pub fn signed_u256(value: &BigInt, name: &'static str) -> Result<U256, String> {
    let limit = BigInt::from(1_u8) << 255_u32;
    if value < &-limit.clone() || value >= &limit {
        return Err(format!("{name}:INT256"));
    }
    let bits: BigUint = if value.sign() == Sign::Minus {
        ((BigInt::from(1_u8) << 256_u32) + value)
            .to_biguint()
            .ok_or_else(|| format!("{name}:INT256"))?
    } else {
        value.to_biguint().unwrap_or_default()
    };
    Ok(U256::from_big_endian(&bits.to_bytes_be()))
}

pub fn parse_stack(value: &str) -> Result<(u64, String), String> {
    let normalized = value.trim().to_ascii_lowercase();
    let mut parts = normalized.split(':').map(str::to_string);
    let prefix = parts.next().unwrap_or_default();
    let chain = parts.next().unwrap_or_default();
    let address = parts.next().unwrap_or_default();
    if prefix != "stack"
        || parts.next().is_some()
        || address.len() != 42
        || !address.starts_with("0x")
        || !address[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("JURISDICTION_INVALID:{value}"));
    }
    let chain = chain
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("JURISDICTION_INVALID:{value}"))?;
    Ok((chain, address))
}

fn optional_address(value: Option<&str>) -> String {
    value
        .map(normalized)
        .filter(|value| {
            value.len() == 42
                && value.starts_with("0x")
                && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .unwrap_or_default()
}

pub fn canonical_source_is_base(route: &CanonicalValue) -> Result<bool, String> {
    let source = field(route, "source").ok_or_else(|| "SOURCE_MISSING".to_string())?;
    let target = field(route, "target").ok_or_else(|| "TARGET_MISSING".to_string())?;
    let source_j = text(source, "jurisdiction").ok_or_else(|| "SOURCE_JURISDICTION".to_string())?;
    let target_j = text(target, "jurisdiction").ok_or_else(|| "TARGET_JURISDICTION".to_string())?;
    let source_stack = parse_stack(source_j)?;
    let target_stack = parse_stack(target_j)?;
    let source_token = required_u32(source, "tokenId")?;
    let target_token = required_u32(target, "tokenId")?;
    let source_key = format!("stack:{}:{}:{source_token}", source_stack.0, source_stack.1);
    let target_key = format!("stack:{}:{}:{target_token}", target_stack.0, target_stack.1);
    let source_liquid = is_canonical_liquid_token(source_token);
    let target_liquid = is_canonical_liquid_token(target_token);
    Ok(if source_liquid != target_liquid {
        !source_liquid
    } else {
        source_key <= target_key
    })
}

pub fn canonical_book_and_venue(route: &CanonicalValue) -> Result<(String, String), String> {
    let source = field(route, "source").ok_or_else(|| "SOURCE_MISSING".to_string())?;
    let target = field(route, "target").ok_or_else(|| "TARGET_MISSING".to_string())?;
    let source_j = text(source, "jurisdiction").ok_or_else(|| "SOURCE_JURISDICTION".to_string())?;
    let target_j = text(target, "jurisdiction").ok_or_else(|| "TARGET_JURISDICTION".to_string())?;
    let source_stack = parse_stack(source_j)?;
    let target_stack = parse_stack(target_j)?;
    if source_stack == target_stack {
        return Err("DISTINCT_STACKS_REQUIRED".to_string());
    }
    let source_hub = nested_text(route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| "SOURCE_HUB_MISSING".to_string())?;
    let target_hub = nested_text(route, "target", "entityId")
        .map(normalized)
        .ok_or_else(|| "TARGET_HUB_MISSING".to_string())?;
    let book_owner = if source_stack < target_stack {
        source_hub
    } else {
        target_hub
    };
    let source_token = required_u32(source, "tokenId")?;
    let target_token = required_u32(target, "tokenId")?;
    let source_key = format!("stack:{}:{}:{source_token}", source_stack.0, source_stack.1);
    let target_key = format!("stack:{}:{}:{target_token}", target_stack.0, target_stack.1);
    let source_is_base = canonical_source_is_base(route)?;
    let (base, quote) = if source_is_base {
        (source_key, target_key)
    } else {
        (target_key, source_key)
    };
    Ok((book_owner, format!("cross:{base}/{quote}")))
}

pub fn canonical_dispute_config(
    route: &CanonicalValue,
    field_name: &'static str,
) -> Result<(u32, u32), String> {
    let config = field(route, field_name).ok_or_else(|| format!("{field_name}:MISSING"))?;
    let left = required_u32(config, "leftResponseSeconds")?;
    let right = required_u32(config, "rightResponseSeconds")?;
    if u64::from(left) + u64::from(right) > 365 * 24 * 60 * 60 {
        return Err(format!("{field_name}:TOTAL"));
    }
    Ok((left, right))
}

pub fn route_hash(route: &CanonicalValue) -> Result<String, String> {
    let source = field(route, "source").ok_or_else(|| "SOURCE_MISSING".to_string())?;
    let target = field(route, "target").ok_or_else(|| "TARGET_MISSING".to_string())?;
    let domain = field(route, "domain").ok_or_else(|| "DOMAIN_MISSING".to_string())?;
    let time = field(route, "timePolicy").ok_or_else(|| "TIME_POLICY_MISSING".to_string())?;
    let source_dispute = canonical_dispute_config(route, "sourceDisputeConfig")?;
    let target_dispute = canonical_dispute_config(route, "targetDisputeConfig")?;
    let source_amount = required_bigint(source, "amount")?;
    let target_amount = required_bigint(target, "amount")?;
    let source_token = required_u32(source, "tokenId")?;
    let target_token = required_u32(target, "tokenId")?;
    let price_ticks = bigint(route, "priceTicks").unwrap_or_default();
    let expires_at = unsigned(route, "expiresAt").unwrap_or(0);
    let runtime_expires = unsigned(time, "runtimeExpiresAtMs")
        .ok_or_else(|| "RUNTIME_EXPIRES_MISSING".to_string())?;
    let s = |value: Option<&str>| Token::String(value.map(normalized).unwrap_or_default());
    let raw = |value: Option<&str>| Token::String(value.unwrap_or_default().to_string());
    let tokens = vec![
        raw(text(route, "orderId")),
        s(text(route, "bookOwnerEntityId")),
        raw(text(route, "venueId")),
        s(text(route, "makerEntityId")),
        s(text(route, "hubEntityId")),
        s(text(route, "sourceSignerId")),
        s(text(route, "sourceHubSignerId")),
        s(text(route, "targetHubSignerId")),
        s(text(route, "targetSignerId")),
        s(text(route, "bookHubSignerId")),
        s(text(source, "jurisdiction")),
        s(text(source, "entityId")),
        s(text(source, "counterpartyEntityId")),
        Token::Uint(U256::from(source_token)),
        Token::Uint(positive_u256(&source_amount, "SOURCE_AMOUNT")?),
        s(text(target, "jurisdiction")),
        s(text(target, "entityId")),
        s(text(target, "counterpartyEntityId")),
        Token::Uint(U256::from(target_token)),
        Token::Uint(positive_u256(&target_amount, "TARGET_AMOUNT")?),
        Token::Bool(field(route, "priceTicks").is_some()),
        Token::Int(signed_u256(&price_ticks, "PRICE_TICKS")?),
        Token::Uint(U256::from(expires_at)),
        raw(text(route, "riskMode")),
        raw(text(domain, "protocol")),
        raw(text(domain, "hashSchema")),
        raw(text(domain, "sourceStackId")),
        raw(text(domain, "targetStackId")),
        raw(text(domain, "sourceEntityProviderAddress")),
        raw(text(domain, "targetEntityProviderAddress")),
        raw(text(domain, "sourceDeltaTransformerAddress")),
        raw(text(domain, "targetDeltaTransformerAddress")),
        raw(text(domain, "sourceAssetRef")),
        raw(text(domain, "targetAssetRef")),
        raw(text(time, "runtimeClock")),
        raw(text(time, "settlementClock")),
        raw(text(time, "deadlineConversion")),
        Token::Uint(U256::from(runtime_expires)),
        raw(text(time, "finalityPolicy")),
        Token::Uint(U256::from(source_dispute.0)),
        Token::Uint(U256::from(source_dispute.1)),
        Token::Uint(U256::from(target_dispute.0)),
        Token::Uint(U256::from(target_dispute.1)),
    ];
    let encoded = ethabi::encode(&tokens);
    Ok(format!("0x{}", hex(&Keccak256::digest(encoded))))
}

pub fn canonical_route(route: &CanonicalValue) -> Result<CanonicalValue, String> {
    if object(route).is_none() {
        return Err("ROUTE_OBJECT".to_string());
    }
    let mut canonical = route.clone();
    let (default_book_owner, default_venue) = canonical_book_and_venue(&canonical)?;
    let book_owner = text(&canonical, "bookOwnerEntityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_book_owner);
    let venue = text(&canonical, "venueId")
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(default_venue);
    let hub = text(&canonical, "hubEntityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| book_owner.clone());
    set(&mut canonical, "bookOwnerEntityId", string(book_owner))?;
    set(&mut canonical, "venueId", string(venue))?;
    set(&mut canonical, "hubEntityId", string(hub))?;

    let source = field(&canonical, "source").ok_or_else(|| "SOURCE_MISSING".to_string())?;
    let target = field(&canonical, "target").ok_or_else(|| "TARGET_MISSING".to_string())?;
    let source_j = text(source, "jurisdiction")
        .map(normalized)
        .ok_or_else(|| "SOURCE_JURISDICTION".to_string())?;
    let target_j = text(target, "jurisdiction")
        .map(normalized)
        .ok_or_else(|| "TARGET_JURISDICTION".to_string())?;
    let source_token = required_u32(source, "tokenId")?;
    let target_token = required_u32(target, "tokenId")?;
    let source_amount = required_bigint(source, "amount")?;
    let target_amount = required_bigint(target, "amount")?;
    if source_amount <= BigInt::from(0) || target_amount <= BigInt::from(0) {
        return Err("AMOUNT_NON_POSITIVE".to_string());
    }

    let supplied_domain = field(&canonical, "domain");
    let mut domain = vec![
        ("protocol".into(), string("xln-cross-j")),
        ("hashSchema".into(), string("route-domain")),
        // TS preserves supplied domain commitments independently of the leg
        // jurisdictions. Replacing them here invalidates a user's exact
        // route authorization; the hash check below rejects substitutions.
        (
            "sourceStackId".into(),
            string(normalized(
                supplied_domain
                    .and_then(|domain| text(domain, "sourceStackId"))
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&source_j),
            )),
        ),
        (
            "targetStackId".into(),
            string(normalized(
                supplied_domain
                    .and_then(|domain| text(domain, "targetStackId"))
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&target_j),
            )),
        ),
    ];
    for name in [
        "sourceEntityProviderAddress",
        "targetEntityProviderAddress",
        "sourceDeltaTransformerAddress",
        "targetDeltaTransformerAddress",
    ] {
        let address = optional_address(supplied_domain.and_then(|value| text(value, name)));
        if !address.is_empty() {
            domain.push((name.into(), string(address)));
        }
    }
    domain.push((
        "sourceAssetRef".into(),
        string(
            supplied_domain
                .and_then(|value| text(value, "sourceAssetRef"))
                .map(normalized)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("{source_j}:{source_token}")),
        ),
    ));
    domain.push((
        "targetAssetRef".into(),
        string(
            supplied_domain
                .and_then(|value| text(value, "targetAssetRef"))
                .map(normalized)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("{target_j}:{target_token}")),
        ),
    ));
    set(&mut canonical, "domain", CanonicalValue::Object(domain))?;

    let supplied_time = field(&canonical, "timePolicy");
    let runtime_expires = supplied_time
        .and_then(|value| unsigned(value, "runtimeExpiresAtMs"))
        .or_else(|| unsigned(&canonical, "expiresAt"))
        .unwrap_or(0);
    set(
        &mut canonical,
        "timePolicy",
        CanonicalValue::Object(vec![
            ("runtimeClock".into(), string("unix_ms")),
            ("settlementClock".into(), string("unix_seconds")),
            (
                "deadlineConversion".into(),
                string("floor_ms_to_unix_seconds"),
            ),
            (
                "runtimeExpiresAtMs".into(),
                number(runtime_expires, "RUNTIME_EXPIRES")?,
            ),
            (
                "finalityPolicy".into(),
                string("independent_beneficiary_windows_pull_sum_finality"),
            ),
        ]),
    )?;
    let risk = text(&canonical, "riskMode").unwrap_or("fully_collateralized");
    if risk != "fully_collateralized" {
        return Err(format!("RISK_MODE:{risk}"));
    }
    set(&mut canonical, "riskMode", string("fully_collateralized"))?;
    canonical_dispute_config(&canonical, "sourceDisputeConfig")?;
    canonical_dispute_config(&canonical, "targetDisputeConfig")?;
    let expected = route_hash(&canonical)?;
    if let Some(actual) = text(route, "routeHash")
        && normalized(actual) != expected
    {
        return Err(format!("ROUTE_HASH_MISMATCH:{actual}:{expected}"));
    }
    set(&mut canonical, "routeHash", string(expected))?;
    Ok(canonical)
}
