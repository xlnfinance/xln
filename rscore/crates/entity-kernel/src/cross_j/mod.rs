//! Canonical cross-j Entity transitions.
//!
//! Values remain the exact TypeScript consensus shape inside persistent radix
//! collections. This module owns transition validation and ordered routed
//! outputs; Runtime only binds transport after WAL fsync.

mod committed;
#[cfg(test)]
mod group_d_parity;
mod opening_proposal;

pub(crate) use committed::apply_committed_account_tx_followup;
pub use opening_proposal::{
    CrossJOpeningProposalSelection, CrossJOpeningSelectionError, CrossJOpeningSiblingAccountView,
    CrossJOpeningSiblingEntityView, select_cross_j_opening_proposal,
};

use std::collections::{BTreeMap, BTreeSet};

use ethabi::ethereum_types::U256;
use ethabi::{ParamType, Token};
use num_bigint::{BigInt, BigUint, Sign};
use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{AccountTx, HashLadderRevealRegisteredEvent};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_canonical_consensus_bytes};

use crate::{
    AccountProposalWork, CanonicalEntityTx, CrossJurisdictionRuntimeOutput,
    EntityCanonicalCollection, EntityFrameAuthority, EntityFrameEvent, EntityKernelError,
    EntityStateSlice, EntityTxKind, LocalEntityOutput, LocalEntityOutputTx, PairDimensions,
    SameJOffer, Side,
};

use crate::local_tx::is_self_runtime_continuation_kind;
use crate::orderbook::SameJOutputDelta;

#[derive(Clone, Debug, Default)]
pub struct CrossJurisdictionApplyResult {
    pub outputs: Vec<LocalEntityOutput>,
    pub proposal_work: Vec<AccountProposalWork>,
    pub(crate) events: Vec<EntityFrameEvent>,
    pub(crate) orderbook_deltas: Vec<SameJOutputDelta>,
    pub(crate) account_envelope_mutations: Vec<(String, crate::AccountEnvelopeMutation)>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HashLadderRevealApplyResult {
    pub outputs: Vec<LocalEntityOutput>,
    pub matching_recovery_pull_ids: Vec<String>,
    pub port_lane_count: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CrossJurisdictionAccountViewRequest {
    pub account_id: String,
    pub pull_ids: Vec<String>,
    pub swap_offer_ids: Vec<String>,
    pub dispute: bool,
}

/// One canonical projection of a cross-j route into the shared orderbook.
/// This is derived on demand from the route; it is never stored as a second
/// book, index or settlement record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CrossJurisdictionMarket {
    pub book_owner: String,
    pub source_asset_key: String,
    pub target_asset_key: String,
    pub pair_id: String,
    pub side: Side,
    pub dimensions: PairDimensions,
    pub base_token_id: u32,
    pub quote_token_id: u32,
    pub base_amount: BigInt,
    pub quote_amount: BigInt,
    pub price_ticks: BigInt,
    pub maker_id: String,
    pub source_total: BigInt,
    pub target_total: BigInt,
    pub filled_source: BigInt,
    pub filled_target: BigInt,
    pub previous_fill_ratio: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CrossJurisdictionBookFill {
    pub account_id: String,
    pub offer_id: String,
    pub route: CanonicalValue,
    pub ack_data: CanonicalValue,
}

/// One dispute-preparation decision for a cross-j Account offer. The route is
/// canonicalized here, where all other cross-j outputs are constructed, so
/// dispute handling cannot grow a second route/hash/signer implementation.
pub(crate) enum DisputeBookRemovalPlan {
    Local { source_entity_id: String },
    Remote { output: LocalEntityOutput },
}

fn invalid(kind: EntityTxKind, detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::InvalidLocalEntityTx {
        kind: kind.as_str(),
        detail: detail.into(),
    }
}

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

fn required_u32(
    value: &CanonicalValue,
    name: &'static str,
    kind: EntityTxKind,
) -> Result<u32, EntityKernelError> {
    unsigned(value, name)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| invalid(kind, format!("{name}:U32")))
}

fn required_bigint(
    value: &CanonicalValue,
    name: &'static str,
    kind: EntityTxKind,
) -> Result<BigInt, EntityKernelError> {
    bigint(value, name).ok_or_else(|| invalid(kind, format!("{name}:BIGINT")))
}

fn set(
    value: &mut CanonicalValue,
    key: &str,
    next: CanonicalValue,
) -> Result<(), EntityKernelError> {
    let fields = object_mut(value).ok_or_else(|| EntityKernelError::CommitmentEncoding {
        detail: "CROSS_J_OBJECT_REQUIRED".into(),
    })?;
    if let Some((_, value)) = fields.iter_mut().find(|(field, _)| field == key) {
        *value = next;
    } else {
        fields.push((key.to_string(), next));
    }
    Ok(())
}

fn remove(value: &mut CanonicalValue, key: &str) -> Result<(), EntityKernelError> {
    let fields = object_mut(value).ok_or_else(|| EntityKernelError::CommitmentEncoding {
        detail: "CROSS_J_OBJECT_REQUIRED".into(),
    })?;
    fields.retain(|(field, _)| field != key);
    Ok(())
}

fn string(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
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

fn number(
    value: u64,
    kind: EntityTxKind,
    name: &'static str,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value)
            .map_err(|_| invalid(kind, format!("{name}:UNSAFE")))?,
    ))
}

fn positive_u256(
    value: &BigInt,
    kind: EntityTxKind,
    name: &'static str,
) -> Result<U256, EntityKernelError> {
    if value.sign() == Sign::Minus {
        return Err(invalid(kind, format!("{name}:NEGATIVE")));
    }
    let bytes = value.to_biguint().unwrap_or_default().to_bytes_be();
    if bytes.len() > 32 {
        return Err(invalid(kind, format!("{name}:UINT256")));
    }
    Ok(U256::from_big_endian(&bytes))
}

fn signed_u256(
    value: &BigInt,
    kind: EntityTxKind,
    name: &'static str,
) -> Result<U256, EntityKernelError> {
    let limit = BigInt::from(1_u8) << 255_u32;
    if value < &-limit.clone() || value >= &limit {
        return Err(invalid(kind, format!("{name}:INT256")));
    }
    let bits: BigUint = if value.sign() == Sign::Minus {
        ((BigInt::from(1_u8) << 256_u32) + value)
            .to_biguint()
            .ok_or_else(|| invalid(kind, format!("{name}:INT256")))?
    } else {
        value.to_biguint().unwrap_or_default()
    };
    Ok(U256::from_big_endian(&bits.to_bytes_be()))
}

fn parse_stack(value: &str, kind: EntityTxKind) -> Result<(u64, String), EntityKernelError> {
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
        return Err(invalid(kind, format!("JURISDICTION_INVALID:{value}")));
    }
    let chain = chain
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(kind, format!("JURISDICTION_INVALID:{value}")))?;
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

fn canonical_book_and_venue(
    route: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<(String, String), EntityKernelError> {
    let source = field(route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_j =
        text(source, "jurisdiction").ok_or_else(|| invalid(kind, "SOURCE_JURISDICTION"))?;
    let target_j =
        text(target, "jurisdiction").ok_or_else(|| invalid(kind, "TARGET_JURISDICTION"))?;
    let source_stack = parse_stack(source_j, kind)?;
    let target_stack = parse_stack(target_j, kind)?;
    if source_stack == target_stack {
        return Err(invalid(kind, "DISTINCT_STACKS_REQUIRED"));
    }
    let source_hub = nested_text(route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "SOURCE_HUB_MISSING"))?;
    let target_hub = nested_text(route, "target", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "TARGET_HUB_MISSING"))?;
    let book_owner = if source_stack < target_stack {
        source_hub
    } else {
        target_hub
    };
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let source_key = format!("stack:{}:{}:{source_token}", source_stack.0, source_stack.1);
    let target_key = format!("stack:{}:{}:{target_token}", target_stack.0, target_stack.1);
    let source_liquid = crate::is_canonical_liquid_token(source_token);
    let target_liquid = crate::is_canonical_liquid_token(target_token);
    let source_is_base = if source_liquid != target_liquid {
        !source_liquid
    } else {
        source_key <= target_key
    };
    let (base, quote) = if source_is_base {
        (source_key, target_key)
    } else {
        (target_key, source_key)
    };
    Ok((book_owner, format!("cross:{base}/{quote}")))
}

fn canonical_dispute_config(
    route: &CanonicalValue,
    field_name: &'static str,
    kind: EntityTxKind,
) -> Result<(u32, u32), EntityKernelError> {
    let config =
        field(route, field_name).ok_or_else(|| invalid(kind, format!("{field_name}:MISSING")))?;
    let left = required_u32(config, "leftResponseSeconds", kind)?;
    let right = required_u32(config, "rightResponseSeconds", kind)?;
    if u64::from(left) + u64::from(right) > 365 * 24 * 60 * 60 {
        return Err(invalid(kind, format!("{field_name}:TOTAL")));
    }
    Ok((left, right))
}

fn route_hash(route: &CanonicalValue, kind: EntityTxKind) -> Result<String, EntityKernelError> {
    let source = field(route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let domain = field(route, "domain").ok_or_else(|| invalid(kind, "DOMAIN_MISSING"))?;
    let settlement = field(route, "settlementPolicy")
        .ok_or_else(|| invalid(kind, "SETTLEMENT_POLICY_MISSING"))?;
    let time = field(route, "timePolicy").ok_or_else(|| invalid(kind, "TIME_POLICY_MISSING"))?;
    let source_dispute = canonical_dispute_config(route, "sourceDisputeConfig", kind)?;
    let target_dispute = canonical_dispute_config(route, "targetDisputeConfig", kind)?;
    let source_amount = required_bigint(source, "amount", kind)?;
    let target_amount = required_bigint(target, "amount", kind)?;
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let price_ticks = bigint(route, "priceTicks").unwrap_or_default();
    let expires_at = unsigned(route, "expiresAt").unwrap_or(0);
    let runtime_expires = unsigned(time, "runtimeExpiresAtMs")
        .ok_or_else(|| invalid(kind, "RUNTIME_EXPIRES_MISSING"))?;
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
        Token::Uint(positive_u256(&source_amount, kind, "SOURCE_AMOUNT")?),
        s(text(target, "jurisdiction")),
        s(text(target, "entityId")),
        s(text(target, "counterpartyEntityId")),
        Token::Uint(U256::from(target_token)),
        Token::Uint(positive_u256(&target_amount, kind, "TARGET_AMOUNT")?),
        Token::Bool(field(route, "priceTicks").is_some()),
        Token::Int(signed_u256(&price_ticks, kind, "PRICE_TICKS")?),
        Token::Uint(U256::from(expires_at)),
        raw(text(route, "riskMode")),
        raw(text(route, "priceImprovementMode")),
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
        raw(text(settlement, "roundingMode")),
        Token::Uint(positive_u256(
            &required_bigint(settlement, "maxSourceDust", kind)?,
            kind,
            "MAX_SOURCE_DUST",
        )?),
        Token::Uint(positive_u256(
            &required_bigint(settlement, "maxTargetDust", kind)?,
            kind,
            "MAX_TARGET_DUST",
        )?),
        Token::Uint(positive_u256(
            &bigint(settlement, "minSourceFillAmount").unwrap_or_default(),
            kind,
            "MIN_SOURCE_FILL",
        )?),
        Token::Uint(positive_u256(
            &bigint(settlement, "minTargetFillAmount").unwrap_or_default(),
            kind,
            "MIN_TARGET_FILL",
        )?),
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

fn canonical_route(
    route: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<CanonicalValue, EntityKernelError> {
    if object(route).is_none() {
        return Err(invalid(kind, "ROUTE_OBJECT"));
    }
    let mut canonical = route.clone();
    let (default_book_owner, default_venue) = canonical_book_and_venue(&canonical, kind)?;
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

    let source = field(&canonical, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(&canonical, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_j = text(source, "jurisdiction")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "SOURCE_JURISDICTION"))?;
    let target_j = text(target, "jurisdiction")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "TARGET_JURISDICTION"))?;
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let source_amount = required_bigint(source, "amount", kind)?;
    let target_amount = required_bigint(target, "amount", kind)?;
    if source_amount <= BigInt::from(0) || target_amount <= BigInt::from(0) {
        return Err(invalid(kind, "AMOUNT_NON_POSITIVE"));
    }

    let supplied_domain = field(&canonical, "domain");
    let mut domain = vec![
        ("protocol".into(), string("xln-cross-j")),
        ("hashSchema".into(), string("route-domain")),
        ("sourceStackId".into(), string(source_j.clone())),
        ("targetStackId".into(), string(target_j.clone())),
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

    let supplied_settlement = field(&canonical, "settlementPolicy");
    let default_dust =
        |amount: &BigInt| (amount + BigInt::from(65_534_u32)) / BigInt::from(65_535_u32);
    let max_source_dust = supplied_settlement
        .and_then(|value| bigint(value, "maxSourceDust"))
        .unwrap_or_else(|| default_dust(&source_amount));
    let max_target_dust = supplied_settlement
        .and_then(|value| bigint(value, "maxTargetDust"))
        .unwrap_or_else(|| default_dust(&target_amount));
    if max_source_dust.sign() == Sign::Minus || max_target_dust.sign() == Sign::Minus {
        return Err(invalid(kind, "SETTLEMENT_DUST_NEGATIVE"));
    }
    let mut settlement = vec![
        ("roundingMode".into(), string("uint16_ceil")),
        (
            "maxSourceDust".into(),
            CanonicalValue::BigInt(max_source_dust),
        ),
        (
            "maxTargetDust".into(),
            CanonicalValue::BigInt(max_target_dust),
        ),
    ];
    for name in ["minSourceFillAmount", "minTargetFillAmount"] {
        if let Some(value) = supplied_settlement.and_then(|value| bigint(value, name)) {
            if value.sign() == Sign::Minus {
                return Err(invalid(kind, format!("{name}:NEGATIVE")));
            }
            settlement.push((name.into(), CanonicalValue::BigInt(value)));
        }
    }
    set(
        &mut canonical,
        "settlementPolicy",
        CanonicalValue::Object(settlement),
    )?;

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
                number(runtime_expires, kind, "RUNTIME_EXPIRES")?,
            ),
            (
                "finalityPolicy".into(),
                string("independent_beneficiary_windows_pull_sum_finality"),
            ),
        ]),
    )?;
    let risk = text(&canonical, "riskMode").unwrap_or("fully_collateralized");
    if risk != "fully_collateralized" {
        return Err(invalid(kind, format!("RISK_MODE:{risk}")));
    }
    set(&mut canonical, "riskMode", string("fully_collateralized"))?;
    if let Some(mode) = text(&canonical, "priceImprovementMode")
        && mode != "source_savings"
    {
        return Err(invalid(kind, format!("PRICE_IMPROVEMENT_MODE:{mode}")));
    }
    canonical_dispute_config(&canonical, "sourceDisputeConfig", kind)?;
    canonical_dispute_config(&canonical, "targetDisputeConfig", kind)?;
    let expected = route_hash(&canonical, kind)?;
    if let Some(actual) = text(route, "routeHash")
        && normalized(actual) != expected
    {
        return Err(invalid(
            kind,
            format!("ROUTE_HASH_MISMATCH:{actual}:{expected}"),
        ));
    }
    set(&mut canonical, "routeHash", string(expected))?;
    Ok(canonical)
}

fn route(tx: &CanonicalEntityTx) -> Result<CanonicalValue, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let route = field(data, "route").ok_or_else(|| invalid(tx.kind, "ROUTE_MISSING"))?;
    if object(route).is_none() {
        return Err(invalid(tx.kind, "ROUTE_OBJECT"));
    }
    canonical_route(route, tx.kind)
}

fn route_order_id(kind: EntityTxKind, route: &CanonicalValue) -> Result<&str, EntityKernelError> {
    text(route, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "ORDER_ID_MISSING"))
}

fn normalized(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn cross_j_event_invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::JEventInvalid {
        detail: detail.into(),
    }
}

fn canonical_event_number(
    value: u64,
    field: &'static str,
) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| cross_j_event_invalid(format!("{field}:SAFE_INTEGER")))
}

fn canonical_hex32(value: &str, field: &'static str) -> Result<[u8; 32], EntityKernelError> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    let bytes = ::hex::decode(value).map_err(|_| cross_j_event_invalid(format!("{field}:HEX")))?;
    bytes
        .try_into()
        .map_err(|_| cross_j_event_invalid(format!("{field}:BYTES32")))
}

fn pull_ladder_hash(pull: &CanonicalValue) -> Result<[u8; 32], EntityKernelError> {
    let full_hash = canonical_hex32(
        text(pull, "fullHash")
            .ok_or_else(|| cross_j_event_invalid("CROSS_J_PULL_FULL_HASH_MISSING"))?,
        "CROSS_J_PULL_FULL_HASH",
    )?;
    let partial_root = canonical_hex32(
        text(pull, "partialRoot")
            .ok_or_else(|| cross_j_event_invalid("CROSS_J_PULL_PARTIAL_ROOT_MISSING"))?,
        "CROSS_J_PULL_PARTIAL_ROOT",
    )?;
    let mut encoded = [0_u8; 64];
    encoded[..32].copy_from_slice(&full_hash);
    encoded[32..].copy_from_slice(&partial_root);
    Ok(Keccak256::digest(encoded).into())
}

fn hash_ladder_binary(event: &HashLadderRevealRegisteredEvent) -> String {
    if event.fill_ratio == u16::MAX {
        return format!("0x{}", hex(&event.full_secret));
    }
    let mut bytes = Vec::with_capacity(130);
    bytes.extend_from_slice(&event.fill_ratio.to_be_bytes());
    for reveal in event.reveals {
        bytes.extend_from_slice(&reveal);
    }
    format!("0x{}", hex(&bytes))
}

fn terminal_route(route: &CanonicalValue) -> bool {
    matches!(
        text(route, "status"),
        Some("settled" | "cancelled" | "expired")
    )
}

fn route_runtime_expired(route: &CanonicalValue, now_ms: u64) -> bool {
    let deadline = unsigned(route, "expiresAt")
        .or_else(|| {
            field(route, "timePolicy").and_then(|policy| unsigned(policy, "runtimeExpiresAtMs"))
        })
        .unwrap_or(0);
    deadline > 0 && deadline <= now_ms
}

fn prefixed_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex(bytes))
}

fn keccak_text(value: &str) -> [u8; 32] {
    Keccak256::digest(value.as_bytes()).into()
}

fn hash_steps(mut value: [u8; 32], steps: u8) -> [u8; 32] {
    for _ in 0..steps {
        value = Keccak256::digest(value).into();
    }
    value
}

struct HashLadderProof {
    full_secret: [u8; 32],
    nibble_bases: [[u8; 32]; 4],
    full_hash: [u8; 32],
    partial_root: [u8; 32],
}

fn hash_ladder_proof(runtime_seed: &str, route_hash: &str) -> HashLadderProof {
    let private_seed = prefixed_hex(&keccak_text(&format!(
        "xln:cross-j:hashladder-private-seed:v1:{runtime_seed}:{route_hash}"
    )));
    let secret = |suffix: &str| keccak_text(&format!("{private_seed}:{suffix}"));
    let full_secret = secret("full");
    let nibble_bases = [secret("n0"), secret("n1"), secret("n2"), secret("n3")];
    let roots = nibble_bases.map(|base| hash_steps(base, 15));
    let mut packed = [0_u8; 128];
    for (index, root) in roots.iter().enumerate() {
        packed[index * 32..(index + 1) * 32].copy_from_slice(root);
    }
    HashLadderProof {
        full_secret,
        nibble_bases,
        full_hash: Keccak256::digest(full_secret).into(),
        partial_root: Keccak256::digest(packed).into(),
    }
}

fn pull_id(route_hash: &str, leg: &str) -> String {
    prefixed_hex(&keccak_text(&format!(
        "xln:cross-j:pull-id:v1:{route_hash}:{leg}"
    )))
}

fn signed_beneficiary_amount(beneficiary: &str, counterparty: &str, amount: &BigInt) -> BigInt {
    if normalized(beneficiary) < normalized(counterparty) {
        amount.clone()
    } else {
        -amount
    }
}

fn prepared_route(
    route: &CanonicalValue,
    runtime_seed: &str,
    now: u64,
) -> Result<CanonicalValue, EntityKernelError> {
    let kind = EntityTxKind::MaterializeCrossJurisdictionSwap;
    let mut route = canonical_route(route, kind)?;
    let expires = field(&route, "timePolicy")
        .and_then(|policy| unsigned(policy, "runtimeExpiresAtMs"))
        .or_else(|| unsigned(&route, "expiresAt"))
        .unwrap_or(0);
    if expires <= now {
        return Err(invalid(kind, format!("EXPIRES_AT_INVALID:{expires}:{now}")));
    }
    let route_hash = text(&route, "routeHash")
        .ok_or_else(|| invalid(kind, "ROUTE_HASH_MISSING"))?
        .to_string();
    let proof = hash_ladder_proof(runtime_seed, &route_hash);
    let source = field(&route, "source")
        .cloned()
        .ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(&route, "target")
        .cloned()
        .ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_amount = required_bigint(&source, "amount", kind)?;
    let target_amount = required_bigint(&target, "amount", kind)?;
    let pull = |leg: &CanonicalValue,
                leg_name: &str,
                amount: &BigInt|
     -> Result<CanonicalValue, EntityKernelError> {
        let beneficiary = text(leg, "counterpartyEntityId")
            .ok_or_else(|| invalid(kind, "PULL_BENEFICIARY_MISSING"))?;
        let counterparty =
            text(leg, "entityId").ok_or_else(|| invalid(kind, "PULL_COUNTERPARTY_MISSING"))?;
        Ok(CanonicalValue::Object(vec![
            ("pullId".into(), string(pull_id(&route_hash, leg_name))),
            (
                "tokenId".into(),
                field(leg, "tokenId")
                    .cloned()
                    .ok_or_else(|| invalid(kind, "PULL_TOKEN_MISSING"))?,
            ),
            ("amount".into(), CanonicalValue::BigInt(amount.clone())),
            (
                "signedAmount".into(),
                CanonicalValue::BigInt(signed_beneficiary_amount(
                    beneficiary,
                    counterparty,
                    amount,
                )),
            ),
            ("fullHash".into(), string(prefixed_hex(&proof.full_hash))),
            (
                "partialRoot".into(),
                string(prefixed_hex(&proof.partial_root)),
            ),
        ]))
    };
    set(
        &mut route,
        "sourcePull",
        pull(&source, "source", &source_amount)?,
    )?;
    set(
        &mut route,
        "targetPull",
        pull(&target, "target", &target_amount)?,
    )?;
    set(&mut route, "status", string("target_prepared"))?;
    set(&mut route, "updatedAt", number(now, kind, "TIMESTAMP")?)?;
    set(
        &mut route,
        "expiresAt",
        number(expires, kind, "EXPIRES_AT")?,
    )?;
    Ok(route)
}

fn reveal_binary(proof: &HashLadderProof, fill_ratio: u16) -> String {
    if fill_ratio == 0 {
        return "0x".into();
    }
    if fill_ratio == u16::MAX {
        return prefixed_hex(&proof.full_secret);
    }
    let digits = [
        ((fill_ratio >> 12) & 0x0f) as u8,
        ((fill_ratio >> 8) & 0x0f) as u8,
        ((fill_ratio >> 4) & 0x0f) as u8,
        (fill_ratio & 0x0f) as u8,
    ];
    let reveals = std::array::from_fn::<_, 4, _>(|index| {
        hash_steps(proof.nibble_bases[index], 15 - digits[index])
    });
    let mut binary = Vec::with_capacity(130);
    binary.extend_from_slice(&fill_ratio.to_be_bytes());
    for reveal in reveals {
        binary.extend_from_slice(&reveal);
    }
    prefixed_hex(&binary)
}

pub fn proposer_materialization_key(tx: &CanonicalEntityTx) -> Option<String> {
    match tx.kind {
        EntityTxKind::MaterializeCrossJurisdictionSwap => tx
            .frame_data()
            .and_then(|data| field(data, "route"))
            .and_then(|route| text(route, "orderId"))
            .map(|order_id| format!("setup:{order_id}")),
        EntityTxKind::MaterializeCrossJurisdictionClear => tx
            .frame_data()
            .and_then(|data| text(data, "orderId"))
            .map(|order_id| format!("clear:{order_id}")),
        _ => None,
    }
}

/// Resolve the local Account that must start its sibling dispute after an
/// authenticated DisputeStarted event on the other route leg. This is the one
/// role resolver used both to request the worker-owned Account view and to
/// execute the Entity transition; duplicating this four-party mapping risks
/// starting the observed Account again instead of its sibling.
pub(crate) fn force_sibling_dispute_counterparty(
    state: &EntityStateSlice,
    route_id: &str,
    observed_counterparty_entity_id: &str,
) -> Result<String, EntityKernelError> {
    let kind = EntityTxKind::CrossJurisdictionForceSiblingDispute;
    let route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(route_id))
        .ok_or_else(|| invalid(kind, format!("ROUTE_MISSING:{route_id}")))?;
    if field(route, "sourcePull").is_none() || field(route, "targetPull").is_none() {
        return Err(invalid(kind, format!("PULLS_MISSING:{route_id}")));
    }
    let self_id = normalized(&state.entity_id);
    let observed = normalized(observed_counterparty_entity_id);
    let source = [
        nested_text(route, "source", "entityId").map(normalized),
        nested_text(route, "source", "counterpartyEntityId").map(normalized),
    ];
    let target = [
        nested_text(route, "target", "entityId").map(normalized),
        nested_text(route, "target", "counterpartyEntityId").map(normalized),
    ];
    if source.iter().any(Option::is_none) || target.iter().any(Option::is_none) {
        return Err(invalid(
            kind,
            format!("ROUTE_PARTICIPANT_MISSING:{route_id}"),
        ));
    }
    let source = source.map(Option::unwrap);
    let target = target.map(Option::unwrap);
    let on_source = source.contains(&self_id);
    let on_target = target.contains(&self_id);
    if on_source == on_target {
        return Err(invalid(
            kind,
            format!("NOT_UNIQUE_PARTICIPANT:{route_id}:{self_id}"),
        ));
    }
    let (local_leg, other_leg) = if on_source {
        (&source, &target)
    } else {
        (&target, &source)
    };
    if observed == self_id || !other_leg.contains(&observed) {
        return Err(invalid(
            kind,
            format!("OBSERVED_LEG_INVALID:{route_id}:{observed}:{self_id}"),
        ));
    }
    local_leg
        .iter()
        .find(|participant| **participant != self_id)
        .cloned()
        .ok_or_else(|| invalid(kind, format!("LOCAL_COUNTERPARTY_MISSING:{route_id}")))
}

pub(crate) fn cross_jurisdiction_account_view_requests(
    state: &EntityStateSlice,
    txs: &[CanonicalEntityTx],
) -> Result<Vec<CrossJurisdictionAccountViewRequest>, EntityKernelError> {
    let mut requests =
        std::collections::BTreeMap::<String, CrossJurisdictionAccountViewRequest>::new();
    for tx in txs {
        let data = tx
            .frame_data()
            .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
        let mut add = |account_id: String,
                       pull_id: Option<String>,
                       offer_id: Option<String>,
                       dispute: bool| {
            let request = requests.entry(account_id.clone()).or_insert_with(|| {
                CrossJurisdictionAccountViewRequest {
                    account_id,
                    ..Default::default()
                }
            });
            if let Some(pull_id) = pull_id
                && !request.pull_ids.contains(&pull_id)
            {
                request.pull_ids.push(pull_id);
            }
            if let Some(offer_id) = offer_id
                && !request.swap_offer_ids.contains(&offer_id)
            {
                request.swap_offer_ids.push(offer_id);
            }
            request.dispute |= dispute;
        };
        match tx.kind {
            EntityTxKind::CrossPullClose => {
                let account = text(data, "counterpartyEntityId")
                    .map(normalized)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| invalid(tx.kind, "COUNTERPARTY_ENTITY_ID_MISSING"))?;
                let pull_id = text(data, "pullId")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| invalid(tx.kind, "PULL_ID_MISSING"))?;
                add(account, Some(pull_id.into()), None, false);
            }
            EntityTxKind::RequestCrossJurisdictionClear
            | EntityTxKind::MaterializeCrossJurisdictionClear => {
                let order_id = semantic_order_id(tx)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| invalid(tx.kind, "ORDER_ID_MISSING"))?;
                let route = state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .and_then(|routes| routes.get(order_id))
                    .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{order_id}")))?;
                let local = normalized(&state.entity_id);
                let source_user = nested_text(route, "source", "entityId")
                    .map(normalized)
                    .ok_or_else(|| invalid(tx.kind, "SOURCE_USER_MISSING"))?;
                let source_hub = nested_text(route, "source", "counterpartyEntityId")
                    .map(normalized)
                    .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
                let account = if local == source_hub {
                    source_user
                } else if local == source_user {
                    source_hub
                } else {
                    return Err(invalid(
                        tx.kind,
                        format!("SOURCE_PARTICIPANT_REQUIRED:{order_id}:{local}"),
                    ));
                };
                let pull_id = field(route, "sourcePull")
                    .and_then(|pull| text(pull, "pullId"))
                    .map(str::to_string);
                add(account, pull_id, Some(order_id.into()), false);
            }
            EntityTxKind::CrossJurisdictionSalvage => {
                let route_id = text(data, "routeId")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| invalid(tx.kind, "ROUTE_ID_MISSING"))?;
                let Some(route) = state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .and_then(|routes| routes.get(route_id))
                else {
                    continue;
                };
                let local = normalized(&state.entity_id);
                if nested_text(route, "target", "counterpartyEntityId")
                    .is_some_and(|value| normalized(value) == local)
                    && let Some(target_hub) =
                        nested_text(route, "target", "entityId").map(normalized)
                {
                    add(target_hub, None, None, true);
                }
            }
            EntityTxKind::OrderbookSweepCrossJurisdiction => {
                let local = normalized(&state.entity_id);
                let routes = state
                    .cross_jurisdiction_swaps
                    .as_ref()
                    .map(EntityCanonicalCollection::text_entries)
                    .transpose()?
                    .unwrap_or_default();
                for (order_id, route) in routes {
                    if terminal_route(&route)
                        || !route_runtime_expired(&route, state.timestamp)
                        || nested_text(&route, "source", "counterpartyEntityId")
                            .is_none_or(|value| normalized(value) != local)
                    {
                        continue;
                    }
                    let source_user = nested_text(&route, "source", "entityId")
                        .map(normalized)
                        .ok_or_else(|| invalid(tx.kind, "SOURCE_USER_MISSING"))?;
                    let pull_id = field(&route, "sourcePull")
                        .and_then(|pull| text(pull, "pullId"))
                        .map(str::to_string);
                    add(source_user, pull_id, Some(order_id), false);
                }
            }
            _ => {}
        }
    }
    Ok(requests.into_values().collect())
}

pub fn proposer_materialization_account_view_requests(
    state: &EntityStateSlice,
) -> Result<Vec<CrossJurisdictionAccountViewRequest>, EntityKernelError> {
    let local = normalized(&state.entity_id);
    let mut requests = Vec::new();
    for (order_id, route) in state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default()
    {
        if text(&route, "status") != Some("clear_requested")
            || nested_text(&route, "source", "counterpartyEntityId")
                .is_none_or(|value| normalized(value) != local)
        {
            continue;
        }
        let source_user = nested_text(&route, "source", "entityId")
            .map(normalized)
            .ok_or_else(|| {
                invalid(
                    EntityTxKind::MaterializeCrossJurisdictionClear,
                    "SOURCE_USER_MISSING",
                )
            })?;
        let source_pull = field(&route, "sourcePull")
            .and_then(|pull| text(pull, "pullId"))
            .map(str::to_string)
            .ok_or_else(|| {
                invalid(
                    EntityTxKind::MaterializeCrossJurisdictionClear,
                    "SOURCE_PULL_MISSING",
                )
            })?;
        requests.push(CrossJurisdictionAccountViewRequest {
            account_id: source_user,
            pull_ids: vec![source_pull],
            swap_offer_ids: vec![order_id],
            dispute: false,
        });
    }
    Ok(requests)
}

pub fn build_proposer_materializations(
    state: &EntityStateSlice,
    runtime_seed: &str,
    proposer_signer_id: &str,
    authority: &EntityFrameAuthority,
    account_views: &std::collections::BTreeMap<
        String,
        xln_rscore_batch::ResidentCrossJMaterializationView,
    >,
    pending_keys: &std::collections::BTreeSet<String>,
    commit_phase: bool,
) -> Result<Vec<CanonicalEntityTx>, EntityKernelError> {
    let proposer = authority
        .config
        .validators
        .first()
        .map(|value| normalized(value))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid(
                EntityTxKind::MaterializeCrossJurisdictionSwap,
                "DEFAULT_PROPOSER_MISSING",
            )
        })?;
    if normalized(proposer_signer_id) != proposer || commit_phase {
        return Ok(Vec::new());
    }
    if runtime_seed.trim().is_empty() {
        return Err(invalid(
            EntityTxKind::MaterializeCrossJurisdictionSwap,
            "RUNTIME_SEED_MISSING",
        ));
    }
    let local = normalized(&state.entity_id);
    let routes = state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default();
    let mut additions = Vec::new();
    for (order_id, route) in &routes {
        if text(route, "status") != Some("intent")
            || field(route, "sourcePull").is_some()
            || field(route, "targetPull").is_some()
            || pending_keys.contains(&format!("setup:{order_id}"))
            || nested_text(route, "source", "counterpartyEntityId")
                .is_none_or(|value| normalized(value) != local)
        {
            continue;
        }
        additions.push(projected(
            EntityTxKind::MaterializeCrossJurisdictionSwap,
            CanonicalValue::Object(vec![
                ("proposerSignerId".into(), string(&proposer)),
                (
                    "route".into(),
                    prepared_route(route, runtime_seed, state.timestamp)?,
                ),
            ]),
        )?);
    }
    for (order_id, route) in &routes {
        if text(route, "status") != Some("clear_requested")
            || field(route, "sourcePull").is_none()
            || field(route, "targetPull").is_none()
            || pending_keys.contains(&format!("clear:{order_id}"))
            || nested_text(route, "source", "counterpartyEntityId")
                .is_none_or(|value| normalized(value) != local)
        {
            continue;
        }
        let (ratio, _, _) = committed_fill(route, EntityTxKind::MaterializeCrossJurisdictionClear)?;
        if ratio == 0 {
            continue;
        }
        let source_user = nested_text(route, "source", "entityId")
            .map(normalized)
            .ok_or_else(|| {
                invalid(
                    EntityTxKind::MaterializeCrossJurisdictionClear,
                    "SOURCE_USER_MISSING",
                )
            })?;
        let source_pull_id = field(route, "sourcePull")
            .and_then(|pull| text(pull, "pullId"))
            .ok_or_else(|| {
                invalid(
                    EntityTxKind::MaterializeCrossJurisdictionClear,
                    "SOURCE_PULL_MISSING",
                )
            })?;
        let Some(view) = account_views.get(&source_user) else {
            continue;
        };
        if view.swap_offer_ids.contains(order_id)
            || !view.pull_ids.contains(source_pull_id)
            || view.pending_cross_pull_close_ids.contains(source_pull_id)
        {
            continue;
        }
        let route_hash = text(route, "routeHash").ok_or_else(|| {
            invalid(
                EntityTxKind::MaterializeCrossJurisdictionClear,
                "ROUTE_HASH_MISSING",
            )
        })?;
        let ratio = u16::try_from(ratio).map_err(|_| {
            invalid(
                EntityTxKind::MaterializeCrossJurisdictionClear,
                "FILL_RATIO_U16",
            )
        })?;
        let binary = reveal_binary(&hash_ladder_proof(runtime_seed, route_hash), ratio);
        additions.push(projected(
            EntityTxKind::MaterializeCrossJurisdictionClear,
            CanonicalValue::Object(vec![
                ("proposerSignerId".into(), string(&proposer)),
                ("orderId".into(), string(order_id)),
                ("binary".into(), string(&binary)),
                (
                    "proof".into(),
                    build_close_proof(
                        route,
                        &binary,
                        EntityTxKind::MaterializeCrossJurisdictionClear,
                    )?,
                ),
            ]),
        )?);
    }
    Ok(additions)
}

pub(crate) fn validate_cross_jurisdiction_dispute_route(
    state: &EntityStateSlice,
    counterparty_entity_id: &str,
    route_id: &str,
) -> Result<(), EntityKernelError> {
    let kind = EntityTxKind::DisputeStart;
    let route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(route_id))
        .filter(|route| text(route, "orderId") == Some(route_id))
        .ok_or_else(|| {
            invalid(
                kind,
                format!("DISPUTE_START_CROSS_J_ROUTE_MISSING:{route_id}"),
            )
        })?;
    let local = normalized(&state.entity_id);
    let counterparty = normalized(counterparty_entity_id);
    let pair_matches = |leg: &str| {
        let left = nested_text(route, leg, "entityId").map(normalized);
        let right = nested_text(route, leg, "counterpartyEntityId").map(normalized);
        matches!((left, right), (Some(left), Some(right)) if
            (left == local && right == counterparty)
                || (right == local && left == counterparty))
    };
    if pair_matches("source") == pair_matches("target") {
        return Err(invalid(
            kind,
            format!("DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:{route_id}"),
        ));
    }
    if terminal_route(route) {
        return Err(invalid(
            kind,
            format!(
                "DISPUTE_START_CROSS_J_ROUTE_INACTIVE:{route_id}:{}",
                text(route, "status").unwrap_or_default()
            ),
        ));
    }
    if field(route, "sourcePull").is_none() || field(route, "targetPull").is_none() {
        return Err(invalid(
            kind,
            format!("DISPUTE_START_CROSS_J_PULLS_MISSING:{route_id}"),
        ));
    }
    Ok(())
}

pub(crate) fn target_recovery_route_ids(
    state: &EntityStateSlice,
    counterparty_entity_id: &str,
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
) -> Result<Vec<String>, EntityKernelError> {
    let self_id = normalized(&state.entity_id);
    let counterparty = normalized(counterparty_entity_id);
    let frozen = dispute
        .pull_ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    let mut routes = Vec::new();
    for (route_id, route) in state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default()
    {
        let target_pull_id = field(&route, "targetPull").and_then(|pull| text(pull, "pullId"));
        if !terminal_route(&route)
            && nested_text(&route, "target", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == self_id)
            && nested_text(&route, "target", "entityId")
                .is_some_and(|value| normalized(value) == counterparty)
            && target_pull_id.is_some_and(|pull_id| frozen.contains(&pull_id.to_string()))
        {
            routes.push(route_id);
        }
    }
    routes.sort();
    Ok(routes)
}

pub(crate) fn target_recovery_value(
    state: &EntityStateSlice,
    counterparty_entity_id: &str,
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
    current: Option<&CanonicalValue>,
) -> Result<Option<CanonicalValue>, EntityKernelError> {
    let route_ids = target_recovery_route_ids(state, counterparty_entity_id, dispute)?;
    if route_ids.is_empty() {
        return Ok(None);
    }
    let route_set = route_ids.iter().collect::<std::collections::BTreeSet<_>>();
    let required = dispute
        .pull_ids
        .iter()
        .filter(|pull_id| {
            state
                .cross_jurisdiction_swaps
                .as_ref()
                .is_some_and(|routes| {
                    route_set.iter().any(|route_id| {
                        routes
                            .get(route_id)
                            .and_then(|route| field(route, "targetPull"))
                            .and_then(|pull| text(pull, "pullId"))
                            == Some(pull_id.as_str())
                    })
                })
        })
        .cloned()
        .collect::<Vec<_>>();
    let required_set = required.iter().collect::<std::collections::BTreeSet<_>>();
    let retained_results = current
        .and_then(|recovery| field(recovery, "resultsByPullId"))
        .and_then(object)
        .map(|fields| {
            fields
                .iter()
                .filter(|(pull_id, _)| required_set.contains(pull_id))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Some(CanonicalValue::Object(vec![
        (
            "requiredPullIds".into(),
            CanonicalValue::Array(required.into_iter().map(string).collect()),
        ),
        (
            "resultsByPullId".into(),
            CanonicalValue::Object(retained_results),
        ),
    ])))
}

pub(crate) fn queue_sibling_dispute_fanout(
    state: &mut EntityStateSlice,
    counterparty_entity_id: &str,
    observed_at: u64,
) -> Result<Vec<LocalEntityOutput>, EntityKernelError> {
    let kind = EntityTxKind::CrossJurisdictionForceSiblingDispute;
    let local = normalized(&state.entity_id);
    let counterparty = normalized(counterparty_entity_id);
    let routes = state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default();
    let mut batches = std::collections::BTreeMap::<(String, String), Vec<CanonicalEntityTx>>::new();
    for (route_id, mut route) in routes {
        if terminal_route(&route) {
            continue;
        }
        let source_user = nested_text(&route, "source", "entityId")
            .map(normalized)
            .ok_or_else(|| invalid(kind, "SOURCE_USER_MISSING"))?;
        let source_hub = nested_text(&route, "source", "counterpartyEntityId")
            .map(normalized)
            .ok_or_else(|| invalid(kind, "SOURCE_HUB_MISSING"))?;
        let target_hub = nested_text(&route, "target", "entityId")
            .map(normalized)
            .ok_or_else(|| invalid(kind, "TARGET_HUB_MISSING"))?;
        let target_user = nested_text(&route, "target", "counterpartyEntityId")
            .map(normalized)
            .ok_or_else(|| invalid(kind, "TARGET_USER_MISSING"))?;
        let touches = ((local == source_user && counterparty == source_hub)
            || (local == source_hub && counterparty == source_user))
            || ((local == target_user && counterparty == target_hub)
                || (local == target_hub && counterparty == target_user));
        if !touches {
            continue;
        }
        if field(&route, "sourcePull").is_none() || field(&route, "targetPull").is_none() {
            if text(&route, "status") == Some("intent")
                && field(&route, "sourcePull").is_none()
                && field(&route, "targetPull").is_none()
            {
                set(&mut route, "status", string("cancelled"))?;
                set(
                    &mut route,
                    "updatedAt",
                    number(state.timestamp, kind, "TIMESTAMP")?,
                )?;
                collection(&mut state.cross_jurisdiction_swaps).insert(route_id, route)?;
                continue;
            }
            return Err(invalid(
                kind,
                format!("SIBLING_DISPUTE_PULLS_MISSING:{route_id}"),
            ));
        }
        let (target, signer_field) = if local == source_user {
            (target_user, "targetSignerId")
        } else if local == target_user {
            (source_user, "sourceSignerId")
        } else if local == source_hub {
            (target_hub, "targetHubSignerId")
        } else if local == target_hub {
            (source_hub, "sourceHubSignerId")
        } else {
            return Err(invalid(
                kind,
                format!("SIBLING_DISPUTE_ROLE:{route_id}:{local}"),
            ));
        };
        let target_signer = text(&route, signer_field)
            .map(normalized)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                invalid(
                    kind,
                    format!("SIBLING_DISPUTE_SIGNER_MISSING:{route_id}:{signer_field}"),
                )
            })?;
        batches
            .entry((target, target_signer))
            .or_default()
            .push(projected(
                kind,
                CanonicalValue::Object(vec![
                    ("routeId".into(), string(route_id)),
                    (
                        "observedCounterpartyEntityId".into(),
                        string(counterparty.clone()),
                    ),
                    (
                        "observedAt".into(),
                        number(observed_at, kind, "OBSERVED_AT")?,
                    ),
                ]),
            )?);
    }
    Ok(batches
        .into_iter()
        .map(|((entity_id, signer_id), txs)| routed(&entity_id, Some(signer_id), txs))
        .collect())
}

fn registry_record(
    route: &CanonicalValue,
    event: &HashLadderRevealRegisteredEvent,
    target_role: bool,
    order_id: &str,
) -> Result<CanonicalValue, EntityKernelError> {
    if event.revealed_at == 0 {
        return Err(cross_j_event_invalid(format!(
            "CROSS_J_REGISTRY_REVEALED_AT_INVALID:{order_id}:{}",
            event.revealed_at
        )));
    }
    let field_name = if target_role {
        "targetRegistryRecord"
    } else {
        "sourceRegistryRecord"
    };
    if let Some(existing) = field(route, field_name) {
        let old_ratio = unsigned(existing, "fillRatio").ok_or_else(|| {
            cross_j_event_invalid(format!("CROSS_J_REGISTRY_RECORD_INVALID:{order_id}"))
        })?;
        let old_time = unsigned(existing, "revealedAt").ok_or_else(|| {
            cross_j_event_invalid(format!("CROSS_J_REGISTRY_RECORD_INVALID:{order_id}"))
        })?;
        let next_ratio = u64::from(event.fill_ratio);
        if old_ratio == next_ratio {
            if !target_role && old_time != event.revealed_at {
                return Err(cross_j_event_invalid(format!(
                    "CROSS_J_REGISTRY_RETRY_TIME_CONFLICT:{order_id}"
                )));
            }
            if event.revealed_at < old_time {
                return Err(cross_j_event_invalid(format!(
                    "CROSS_J_REGISTRY_RECORD_TIME_REGRESSION:{order_id}"
                )));
            }
        } else if !target_role || next_ratio < old_ratio || event.revealed_at < old_time {
            return Err(cross_j_event_invalid(format!(
                "CROSS_J_REGISTRY_RECORD_CONFLICT:{order_id}:{old_ratio}:{next_ratio}"
            )));
        }
    }
    Ok(CanonicalValue::Object(vec![
        (
            "fillRatio".into(),
            canonical_event_number(u64::from(event.fill_ratio), "CROSS_J_REGISTRY_FILL_RATIO")?,
        ),
        (
            "revealedAt".into(),
            canonical_event_number(event.revealed_at, "CROSS_J_REGISTRY_REVEALED_AT")?,
        ),
    ]))
}

/// Apply the Entity-owned part of one authenticated registry event. The one
/// Patricia collection remains the only route authority; the scan is required
/// because the on-chain event intentionally identifies a ladder, not an order.
pub(crate) fn apply_hash_ladder_reveal_registered(
    state: &mut EntityStateSlice,
    event: &HashLadderRevealRegisteredEvent,
) -> Result<HashLadderRevealApplyResult, EntityKernelError> {
    let self_id = normalized(&state.entity_id);
    let writer = normalized(&event.entity);
    let counterparty = normalized(&event.counterparty_entity);
    let writer_is_self = writer == self_id;
    let Some(routes) = state.cross_jurisdiction_swaps.as_ref() else {
        return Ok(HashLadderRevealApplyResult::default());
    };

    let binary = (event.fill_ratio > 0 && !event.target_role).then(|| hash_ladder_binary(event));
    let mut updates = Vec::<(String, CanonicalValue)>::new();
    let mut recovery_pull_ids = Vec::new();
    let mut port_batches =
        std::collections::BTreeMap::<(String, String), Vec<CanonicalEntityTx>>::new();

    for (order_id, found) in routes.text_entries()? {
        let role_pull_name = if event.target_role {
            "targetPull"
        } else {
            "sourcePull"
        };
        if writer_is_self
            && let Some(pull) = field(&found, role_pull_name)
            && pull_ladder_hash(pull)? == event.ladder_hash
            && let Some(pull_id) = text(pull, "pullId")
        {
            recovery_pull_ids.push(pull_id.to_string());
        }

        if terminal_route(&found) {
            continue;
        }

        if let Some(binary) = binary.as_ref()
            && nested_text(&found, "source", "entityId")
                .is_some_and(|value| normalized(value) == self_id)
            && nested_text(&found, "source", "counterpartyEntityId")
                .is_some_and(|value| normalized(value) == writer)
            && counterparty == self_id
            && field(&found, "sourcePull").is_some()
            && field(&found, "targetPull").is_some()
            && pull_ladder_hash(field(&found, "sourcePull").expect("checked source pull"))?
                == event.ladder_hash
        {
            let target_pull = field(&found, "targetPull").expect("checked target pull");
            let full_hash = text(target_pull, "fullHash")
                .ok_or_else(|| cross_j_event_invalid("CROSS_J_TARGET_PULL_FULL_HASH_MISSING"))?;
            let partial_root = text(target_pull, "partialRoot")
                .ok_or_else(|| cross_j_event_invalid("CROSS_J_TARGET_PULL_PARTIAL_ROOT_MISSING"))?;
            let verified =
                xln_rscore_engine::verify_hash_ladder_binary(full_hash, partial_root, binary)
                    .map_err(cross_j_event_invalid)?;
            if verified != u64::from(event.fill_ratio) {
                return Err(cross_j_event_invalid(format!(
                    "CROSS_J_REVEAL_PORT_RATIO_MISMATCH:{order_id}:event={}:verified={verified}",
                    event.fill_ratio
                )));
            }
            let target = nested_text(&found, "target", "counterpartyEntityId")
                .map(normalized)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    cross_j_event_invalid(format!("CROSS_J_REVEAL_PORT_LANE_MISSING:{order_id}"))
                })?;
            let data = CanonicalValue::Object(vec![
                ("routeId".into(), string(order_id.clone())),
                ("binary".into(), string(binary.clone())),
                (
                    "fillRatio".into(),
                    canonical_event_number(u64::from(event.fill_ratio), "CROSS_J_PORT_FILL_RATIO")?,
                ),
                (
                    "sourceEntityId".into(),
                    string(
                        nested_text(&found, "source", "entityId").ok_or_else(|| {
                            cross_j_event_invalid("CROSS_J_SOURCE_ENTITY_MISSING")
                        })?,
                    ),
                ),
                (
                    "sourceCounterpartyEntityId".into(),
                    string(
                        nested_text(&found, "source", "counterpartyEntityId").ok_or_else(|| {
                            cross_j_event_invalid("CROSS_J_SOURCE_COUNTERPARTY_MISSING")
                        })?,
                    ),
                ),
                (
                    "observedAt".into(),
                    canonical_event_number(
                        event.metadata.block_number.unwrap_or_default(),
                        "CROSS_J_PORT_OBSERVED_AT",
                    )?,
                ),
            ]);
            let target_signer = route_signer(&found, &target).ok_or_else(|| {
                cross_j_event_invalid(format!("CROSS_J_REVEAL_PORT_SIGNER_MISSING:{order_id}"))
            })?;
            port_batches
                .entry((target, target_signer))
                .or_default()
                .push(projected(EntityTxKind::CrossJurisdictionSalvage, data)?);
        }

        let Some(role_pull) = field(&found, role_pull_name) else {
            continue;
        };
        let role_leg_name = if event.target_role {
            "target"
        } else {
            "source"
        };
        let role_leg = field(&found, role_leg_name).ok_or_else(|| {
            cross_j_event_invalid(format!("CROSS_J_ROUTE_LEG_MISSING:{order_id}"))
        })?;
        if pull_ladder_hash(role_pull)? != event.ladder_hash
            || text(role_leg, "counterpartyEntityId")
                .is_none_or(|value| normalized(value) != writer)
            || text(role_leg, "entityId").is_none_or(|value| normalized(value) != counterparty)
        {
            continue;
        }

        let mut route = found;
        if writer_is_self {
            let latch = if event.target_role {
                "targetRegistryFillRatio"
            } else {
                "sourceRegistryFillRatio"
            };
            if !event.target_role
                && let Some(prior) = unsigned(&route, latch)
                && prior != u64::from(event.fill_ratio)
            {
                return Err(cross_j_event_invalid(format!(
                    "CROSS_J_SOURCE_REGISTRY_CONFLICT:{order_id}:{prior}:{}",
                    event.fill_ratio
                )));
            }
            set(
                &mut route,
                latch,
                canonical_event_number(u64::from(event.fill_ratio), "CROSS_J_REGISTRY_LATCH")?,
            )?;
        }
        let record_name = if event.target_role {
            "targetRegistryRecord"
        } else {
            "sourceRegistryRecord"
        };
        let record = registry_record(&route, event, event.target_role, &order_id)?;
        set(&mut route, record_name, record)?;
        updates.push((order_id, route));
    }

    let routes = collection(&mut state.cross_jurisdiction_swaps);
    for (order_id, route) in updates {
        routes.insert(order_id, route)?;
    }
    let outputs = port_batches
        .into_iter()
        .map(|((entity_id, signer_id), txs)| routed(&entity_id, Some(signer_id), txs))
        .collect::<Vec<_>>();
    recovery_pull_ids.sort();
    recovery_pull_ids.dedup();
    Ok(HashLadderRevealApplyResult {
        port_lane_count: outputs.len(),
        outputs,
        matching_recovery_pull_ids: recovery_pull_ids,
    })
}

fn runtime_invalid(detail: impl Into<String>) -> EntityKernelError {
    invalid(EntityTxKind::RuntimeOutput, detail)
}

fn route_book_owner(route: &CanonicalValue) -> String {
    [
        text(route, "bookOwnerEntityId"),
        nested_text(route, "source", "counterpartyEntityId"),
        text(route, "hubEntityId"),
    ]
    .into_iter()
    .flatten()
    .map(normalized)
    .find(|value| !value.is_empty())
    .unwrap_or_default()
}

fn route_participants(route: &CanonicalValue) -> [String; 6] {
    [
        nested_text(route, "source", "entityId"),
        nested_text(route, "source", "counterpartyEntityId"),
        nested_text(route, "target", "entityId"),
        nested_text(route, "target", "counterpartyEntityId"),
        text(route, "bookOwnerEntityId"),
        text(route, "hubEntityId"),
    ]
    .map(|value| value.map(normalized).unwrap_or_default())
}

fn route_signer(route: &CanonicalValue, entity_id: &str) -> Option<String> {
    let entity_id = normalized(entity_id);
    let roles = [
        (nested_text(route, "source", "entityId"), "sourceSignerId"),
        (
            nested_text(route, "source", "counterpartyEntityId"),
            "sourceHubSignerId",
        ),
        (
            nested_text(route, "target", "entityId"),
            "targetHubSignerId",
        ),
        (
            nested_text(route, "target", "counterpartyEntityId"),
            "targetSignerId",
        ),
    ];
    for (participant, signer) in roles {
        if participant.is_some_and(|participant| normalized(participant) == entity_id) {
            return text(route, signer)
                .map(normalized)
                .filter(|value| !value.is_empty());
        }
    }
    let book_owner = route_book_owner(route);
    if book_owner != entity_id {
        return None;
    }
    if nested_text(route, "source", "counterpartyEntityId")
        .is_some_and(|value| normalized(value) == book_owner)
    {
        return text(route, "sourceHubSignerId")
            .map(normalized)
            .filter(|value| !value.is_empty());
    }
    if nested_text(route, "target", "entityId").is_some_and(|value| normalized(value) == book_owner)
    {
        return text(route, "targetHubSignerId")
            .map(normalized)
            .filter(|value| !value.is_empty());
    }
    None
}

fn authority_jurisdiction_ref(
    authority: &EntityFrameAuthority,
    kind: EntityTxKind,
) -> Result<String, EntityKernelError> {
    let jurisdiction = authority
        .config
        .jurisdiction
        .as_ref()
        .ok_or_else(|| invalid(kind, "LOCAL_JURISDICTION_UNKNOWN"))?;
    let chain_id = unsigned(jurisdiction, "chainId")
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(kind, "LOCAL_JURISDICTION_CHAIN_ID"))?;
    let depository = text(jurisdiction, "depositoryAddress")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "LOCAL_JURISDICTION_DEPOSITORY"))?;
    parse_stack(&format!("stack:{chain_id}:{depository}"), kind)?;
    Ok(format!("stack:{chain_id}:{depository}"))
}

/// Bind a route to the exact committed authority of the Entity applying it.
/// Route signer hints are not authority: they are accepted only when the
/// committed validator set proves them, and the local stack identity comes
/// from the committed jurisdiction config rather than Runtime routing data.
fn validate_local_route_binding(
    state: &EntityStateSlice,
    route: &CanonicalValue,
    authority: &EntityFrameAuthority,
    kind: EntityTxKind,
) -> Result<(), EntityKernelError> {
    let local = normalized(&state.entity_id);
    let source_participant = [
        nested_text(route, "source", "entityId"),
        nested_text(route, "source", "counterpartyEntityId"),
    ]
    .into_iter()
    .flatten()
    .any(|participant| normalized(participant) == local);
    let target_participant = [
        nested_text(route, "target", "entityId"),
        nested_text(route, "target", "counterpartyEntityId"),
    ]
    .into_iter()
    .flatten()
    .any(|participant| normalized(participant) == local);
    if !source_participant && !target_participant {
        return Ok(());
    }

    let leg = if source_participant {
        "source"
    } else {
        "target"
    };
    let route_jurisdiction = nested_text(route, leg, "jurisdiction")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "ROUTE_JURISDICTION_MISSING"))?;
    let local_jurisdiction = authority_jurisdiction_ref(authority, kind)?;
    if route_jurisdiction != local_jurisdiction {
        return Err(invalid(
            kind,
            format!("LOCAL_JURISDICTION_MISMATCH:{route_jurisdiction}:{local_jurisdiction}"),
        ));
    }

    if let Some(route_signer) = route_signer(route, &local) {
        let committed = authority
            .config
            .validators
            .iter()
            .any(|validator| normalized(validator) == route_signer);
        if !committed {
            return Err(invalid(
                kind,
                format!("LOCAL_ROUTE_SIGNER_NOT_VALIDATOR:{local}:{route_signer}"),
            ));
        }
    }
    Ok(())
}

fn validate_materialize_proposer(
    tx: &CanonicalEntityTx,
    admitted_signer_id: Option<&str>,
    authority: &EntityFrameAuthority,
) -> Result<(), EntityKernelError> {
    if !matches!(
        tx.kind,
        EntityTxKind::MaterializeCrossJurisdictionSwap
            | EntityTxKind::MaterializeCrossJurisdictionClear
    ) {
        return Ok(());
    }
    let expected = authority
        .config
        .validators
        .first()
        .map(|value| normalized(value))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "MATERIALIZE_PROPOSER_MISSING"))?;
    let claimed = tx
        .frame_data()
        .and_then(|data| text(data, "proposerSignerId"))
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "MATERIALIZE_PROPOSER_CLAIM_MISSING"))?;
    let admitted = admitted_signer_id
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "MATERIALIZE_ADMITTED_SIGNER_MISSING"))?;
    if claimed != expected || admitted != claimed {
        return Err(invalid(
            tx.kind,
            format!("MATERIALIZE_PROPOSER_INVALID:{admitted}:{claimed}:{expected}"),
        ));
    }
    Ok(())
}

fn apply_materialize_clear(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let order_id = text(data, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ORDER_ID_MISSING"))?
        .to_string();
    let binary = text(data, "binary").ok_or_else(|| invalid(tx.kind, "BINARY_MISSING"))?;
    let proof = field(data, "proof").ok_or_else(|| invalid(tx.kind, "PROOF_MISSING"))?;
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{order_id}")))?;
    if text(&route, "status") != Some("clear_requested") {
        return Err(invalid(tx.kind, format!("CLEAR_INTENT_MISSING:{order_id}")));
    }
    let local = normalized(&state.entity_id);
    let source_user = nested_text(&route, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_USER_MISSING"))?;
    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    if local != source_hub {
        return Err(invalid(
            tx.kind,
            format!("SOURCE_HUB_MISMATCH:{order_id}:{local}"),
        ));
    }
    let source_pull =
        field(&route, "sourcePull").ok_or_else(|| invalid(tx.kind, "SOURCE_PULL_MISSING"))?;
    if field(&route, "targetPull").is_none() {
        return Err(invalid(tx.kind, "TARGET_PULL_MISSING"));
    }
    let source_pull_id = text(source_pull, "pullId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "SOURCE_PULL_ID_MISSING"))?
        .to_string();
    let (ratio, _, _) = committed_fill(&route, tx.kind)?;
    if ratio == 0 {
        return Err(invalid(tx.kind, format!("FILL_MISSING:{order_id}")));
    }
    let verified = xln_rscore_engine::verify_hash_ladder_binary(
        text(source_pull, "fullHash").unwrap_or(""),
        text(source_pull, "partialRoot").unwrap_or(""),
        binary,
    )
    .map_err(|detail| invalid(tx.kind, detail))?;
    if verified != ratio {
        return Err(invalid(
            tx.kind,
            format!("BINARY_RATIO_MISMATCH:{order_id}:{verified}:{ratio}"),
        ));
    }
    let expected_proof = build_close_proof(&route, binary, tx.kind)?;
    if !close_proofs_match(&expected_proof, proof) {
        return Err(invalid(tx.kind, format!("PROOF_MISMATCH:{order_id}")));
    }
    let view = account_views
        .get(&source_user)
        .ok_or_else(|| invalid(tx.kind, format!("ACCOUNT_VIEW_MISSING:{source_user}")))?;
    if !view.pulls.contains_key(&source_pull_id) {
        return Err(invalid(
            tx.kind,
            format!("SOURCE_PULL_ACCOUNT_MISSING:{order_id}"),
        ));
    }
    if view.swap_offers.contains_key(&order_id) {
        return Err(invalid(
            tx.kind,
            format!("SOURCE_OFFER_STILL_OPEN:{order_id}"),
        ));
    }
    if view.pending_cross_pull_close_ids.contains(&source_pull_id) {
        return Err(invalid(
            tx.kind,
            format!("SOURCE_CLOSE_ALREADY_QUEUED:{order_id}"),
        ));
    }
    set(&mut route, "sourceCloseProof", expected_proof.clone())?;
    set(&mut route, "status", string("clearing"))?;
    set(
        &mut route,
        "updatedAt",
        number(state.timestamp, tx.kind, "TIMESTAMP")?,
    )?;
    let target = queue_target_close(
        &route,
        binary,
        &expected_proof,
        format!("Cross-j {order_id} paired target close {ratio}/65535"),
        tx.kind,
    )?;
    let mut account_txs = vec![AccountTx::CrossPullClose {
        data: CanonicalValue::Object(vec![
            ("pullId".into(), string(&source_pull_id)),
            ("binary".into(), string(binary)),
            ("proof".into(), expected_proof),
        ]),
    }];
    let source_savings = bigint(&route, "priceImprovementSourceAmount").unwrap_or_default();
    if source_savings > BigInt::from(0) {
        let source = field(&route, "source").ok_or_else(|| invalid(tx.kind, "SOURCE_MISSING"))?;
        let token_id = xln_rscore_engine::TokenId::new(required_u32(source, "tokenId", tx.kind)?)
            .map_err(|error| invalid(tx.kind, error.to_string()))?;
        account_txs.push(AccountTx::DirectPayment {
            token_id,
            amount: source_savings,
            route: vec![source_user.clone()],
            description: Some(format!("cross-j-source-savings:{order_id}")),
            from_entity_id: source_hub,
            to_entity_id: source_user.clone(),
            delivery_mode: xln_rscore_engine::DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        });
    }
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route)?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![target, LocalEntityOutput::non_mutating_wake(local)],
        proposal_work: vec![AccountProposalWork {
            account_id: source_user,
            txs: account_txs,
        }],
        events: vec![EntityFrameEvent::Status {
            message: format!(
                "🌉 Cross-j clear {order_id} queued atomic Hub source+target close ratio={ratio}/65535"
            ),
        }],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn semantic_order_id(tx: &CanonicalEntityTx) -> Option<&str> {
    let data = tx.frame_data()?;
    match tx.kind {
        EntityTxKind::CrossPullClose => {
            field(data, "proof").and_then(|proof| text(proof, "orderId"))
        }
        EntityTxKind::CrossJurisdictionFillNotice
        | EntityTxKind::ApplyCrossJurisdictionBookProgress
        | EntityTxKind::RemoveCrossJurisdictionBookOrder
        | EntityTxKind::CrossJurisdictionBookOrderRemoved
        | EntityTxKind::RequestCrossJurisdictionClear
        | EntityTxKind::MaterializeCrossJurisdictionClear => text(data, "orderId"),
        EntityTxKind::CrossJurisdictionSalvage
        | EntityTxKind::CrossJurisdictionForceSiblingDispute => text(data, "routeId"),
        EntityTxKind::ResolveHtlcLock | EntityTxKind::DisputeStart => {
            text(data, "crossJurisdictionRouteId")
        }
        _ => field(data, "route").and_then(|route| text(route, "orderId")),
    }
}

fn semantic_route<'a>(
    state: &'a EntityStateSlice,
    tx: &'a CanonicalEntityTx,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    let order_id = semantic_order_id(tx)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| runtime_invalid("RUNTIME_OUTPUT_ROUTE_MISSING:missing"))?;
    let supplied = tx.frame_data().and_then(|data| field(data, "route"));
    let stored = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(order_id));
    let route = stored
        .or(supplied)
        .ok_or_else(|| runtime_invalid(format!("RUNTIME_OUTPUT_ROUTE_MISSING:{order_id}")))?;
    if text(route, "orderId") != Some(order_id) {
        return Err(runtime_invalid(format!(
            "RUNTIME_OUTPUT_ROUTE_MISSING:{order_id}"
        )));
    }
    if let (Some(stored), Some(supplied)) = (stored, supplied) {
        let stored_hash = text(stored, "routeHash")
            .map(normalized)
            .unwrap_or_default();
        let supplied_hash = text(supplied, "routeHash")
            .map(normalized)
            .unwrap_or_default();
        if stored_hash.is_empty() || supplied_hash.is_empty() || stored_hash != supplied_hash {
            return Err(runtime_invalid(format!(
                "RUNTIME_OUTPUT_ROUTE_HASH_MISMATCH:{order_id}:{supplied_hash}:{stored_hash}"
            )));
        }
    }
    Ok(route)
}

fn assert_source(
    kind: EntityTxKind,
    source: &str,
    expected: impl IntoIterator<Item = String>,
) -> Result<(), EntityKernelError> {
    let expected = expected
        .into_iter()
        .map(|value| normalized(&value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if expected.iter().any(|value| value == source) {
        return Ok(());
    }
    Err(runtime_invalid(format!(
        "RUNTIME_OUTPUT_SEMANTIC_SOURCE_MISMATCH:{}:{source}:{}",
        kind.as_str(),
        expected.join(",")
    )))
}

fn assert_target(
    kind: EntityTxKind,
    target: &str,
    expected: &str,
) -> Result<(), EntityKernelError> {
    let expected = normalized(expected);
    if !expected.is_empty() && target == expected {
        return Ok(());
    }
    Err(runtime_invalid(format!(
        "RUNTIME_OUTPUT_SEMANTIC_TARGET_MISMATCH:{}:{target}:{expected}",
        kind.as_str()
    )))
}

fn required_text(
    value: &CanonicalValue,
    name: &'static str,
    tx: &CanonicalEntityTx,
) -> Result<String, EntityKernelError> {
    text(value, name)
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| runtime_invalid(format!("{}:{name}:MISSING", tx.kind.as_str())))
}

fn authorize_semantic_role(
    state: &EntityStateSlice,
    source: &str,
    target: &str,
    tx: &CanonicalEntityTx,
    route: &CanonicalValue,
) -> Result<(), EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| runtime_invalid("RUNTIME_OUTPUT_TX_DATA_MISSING"))?;
    let source_user = nested_text(route, "source", "entityId")
        .map(normalized)
        .unwrap_or_default();
    let source_hub = nested_text(route, "source", "counterpartyEntityId")
        .map(normalized)
        .unwrap_or_default();
    let target_hub = nested_text(route, "target", "entityId")
        .map(normalized)
        .unwrap_or_default();
    let target_user = nested_text(route, "target", "counterpartyEntityId")
        .map(normalized)
        .unwrap_or_default();
    let book_owner = route_book_owner(route);
    match tx.kind {
        EntityTxKind::AdmitCrossJurisdictionBookOrder => {
            assert_source(tx.kind, source, [source_hub])?;
            assert_target(tx.kind, target, &book_owner)
        }
        EntityTxKind::ApplyCrossJurisdictionBookProgress => {
            let order_id = required_text(data, "orderId", tx)?;
            let claimed_source = required_text(data, "sourceEntityId", tx)?;
            let admission_key = format!("{claimed_source}:{order_id}");
            let admission = state
                .cross_jurisdiction_book_admissions
                .as_ref()
                .and_then(|values| values.get(&admission_key))
                .ok_or_else(|| {
                    runtime_invalid(format!(
                        "RUNTIME_OUTPUT_BOOK_ADMISSION_MISSING:{claimed_source}:{order_id}"
                    ))
                })?;
            if text(admission, "routeHash").map(normalized)
                != text(route, "routeHash").map(normalized)
                || text(admission, "bookOwnerEntityId").map(normalized) != Some(book_owner.clone())
            {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_BOOK_ADMISSION_ROUTE_MISMATCH:{claimed_source}:{order_id}"
                )));
            }
            assert_source(tx.kind, source, [source_hub])?;
            assert_target(tx.kind, target, &book_owner)
        }
        EntityTxKind::CrossJurisdictionFillNotice => {
            if target == source_hub {
                assert_source(tx.kind, source, [book_owner])
            } else if target == target_hub {
                assert_source(tx.kind, source, [source_hub])
            } else {
                Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_CROSS_J_PROGRESS_TARGET_INVALID:{target}"
                )))
            }
        }
        EntityTxKind::CrossPullClose => {
            let counterparty = required_text(data, "counterpartyEntityId", tx)?;
            if counterparty != target_user {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_CROSS_PULL_COUNTERPARTY_MISMATCH:{counterparty}:{target_user}"
                )));
            }
            assert_source(tx.kind, source, [source_hub])?;
            assert_target(tx.kind, target, &target_hub)
        }
        EntityTxKind::RemoveCrossJurisdictionBookOrder => {
            let claimed_source = required_text(data, "sourceEntityId", tx)?;
            if claimed_source != source_user {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_BOOK_SOURCE_ENTITY_MISMATCH:{claimed_source}:{source_user}"
                )));
            }
            assert_source(tx.kind, source, [source_hub])?;
            assert_target(tx.kind, target, &book_owner)
        }
        EntityTxKind::CrossJurisdictionBookOrderRemoved => {
            let claimed_source = required_text(data, "sourceEntityId", tx)?;
            let claimed_account = required_text(data, "sourceAccountId", tx)?;
            if claimed_source != source_user || claimed_account != source_user {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_BOOK_REMOVAL_SOURCE_MISMATCH:{claimed_source}:{claimed_account}:{source_user}"
                )));
            }
            assert_source(tx.kind, source, [book_owner])?;
            assert_target(tx.kind, target, &source_hub)
        }
        EntityTxKind::RequestCrossJurisdictionClear => {
            assert_source(
                tx.kind,
                source,
                [source_hub.clone(), target_hub, book_owner],
            )?;
            assert_target(tx.kind, target, &source_hub)
        }
        EntityTxKind::CrossJurisdictionSalvage => {
            let claimed_source = required_text(data, "sourceEntityId", tx)?;
            let claimed_hub = required_text(data, "sourceCounterpartyEntityId", tx)?;
            if claimed_source != source_user || claimed_hub != source_hub {
                return Err(runtime_invalid("RUNTIME_OUTPUT_SALVAGE_ROUTE_MISMATCH"));
            }
            if target == target_user {
                assert_source(tx.kind, source, [source_user])
            } else if target == source_user {
                assert_source(tx.kind, source, [target_user])
            } else {
                Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_SALVAGE_TARGET_INVALID:{target}"
                )))
            }
        }
        EntityTxKind::ResolveHtlcLock => {
            let counterparty = required_text(data, "counterpartyEntityId", tx)?;
            if counterparty != target_hub {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_CROSS_J_HTLC_COUNTERPARTY_MISMATCH:{}",
                    semantic_order_id(tx).unwrap_or_default()
                )));
            }
            assert_source(tx.kind, source, [source_user])?;
            assert_target(tx.kind, target, &target_user)
        }
        EntityTxKind::DisputeStart => {
            let counterparty = required_text(data, "counterpartyEntityId", tx)?;
            if counterparty != source_hub {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_CROSS_J_DISPUTE_COUNTERPARTY_MISMATCH:{counterparty}:{source_hub}"
                )));
            }
            assert_source(tx.kind, source, [target_user])?;
            assert_target(tx.kind, target, &source_user)
        }
        EntityTxKind::PrepareCrossJurisdictionSwap => {
            assert_source(tx.kind, source, [source_user])?;
            assert_target(tx.kind, target, &source_hub)
        }
        EntityTxKind::RegisterCrossJurisdictionSwap => {
            assert_source(tx.kind, source, [source_hub.clone()])?;
            if target == source_hub || target == target_hub {
                Ok(())
            } else {
                Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_SEMANTIC_TARGET_MISMATCH:{}:{target}:{source_hub},{target_hub}",
                    tx.kind.as_str()
                )))
            }
        }
        _ => Err(runtime_invalid(format!(
            "RUNTIME_OUTPUT_SEMANTIC_VARIANT_FORBIDDEN:{}",
            tx.kind.as_str()
        ))),
    }
}

/// Validate the exact TS Runtime-output boundary before any nested transition
/// touches state. Source signer authority comes from the route, never from the
/// target EntityInput envelope or from transport routing metadata.
pub fn authorize_runtime_output(
    state: &EntityStateSlice,
    output: &CrossJurisdictionRuntimeOutput,
    authority: &EntityFrameAuthority,
) -> Result<(), EntityKernelError> {
    let source = normalized(&output.source_entity_id);
    let source_signer = normalized(&output.source_signer_id);
    let target = normalized(&output.target_entity_id);
    if source.is_empty()
        || source_signer.is_empty()
        || target.is_empty()
        || target != normalized(&state.entity_id)
    {
        return Err(runtime_invalid(format!(
            "RUNTIME_OUTPUT_TARGET_MISMATCH:{target}:{}",
            state.entity_id
        )));
    }
    if source == target
        && output
            .entity_txs
            .iter()
            .all(|tx| is_self_runtime_continuation_kind(tx.kind))
    {
        let normalized_authority = authority.validate_and_normalize().map_err(|error| {
            runtime_invalid(format!("RUNTIME_OUTPUT_AUTHORITY_INVALID:{error}"))
        })?;
        if !normalized_authority
            .config
            .validators
            .iter()
            .any(|validator| validator == &source_signer)
        {
            return Err(runtime_invalid(format!(
                "RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:{source}:{source_signer}:current-board"
            )));
        }
        for tx in &output.entity_txs {
            if tx.kind != EntityTxKind::RequestCrossJurisdictionClear {
                continue;
            }
            let route = semantic_route(state, tx)?;
            let participants = route_participants(route);
            if !participants.iter().any(|value| value == &source) {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN:{}:{source}:{target}",
                    tx.kind.as_str()
                )));
            }
            let expected = route_signer(route, &source).unwrap_or_default();
            if expected.is_empty() || expected != source_signer {
                return Err(runtime_invalid(format!(
                    "RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:{source}:{source_signer}:{expected}"
                )));
            }
            authorize_semantic_role(state, &source, &target, tx, route)?;
        }
        return Ok(());
    }
    if source == target
        && !output.entity_txs.iter().all(|tx| {
            tx.kind == EntityTxKind::RegisterCrossJurisdictionSwap
                && tx
                    .frame_data()
                    .and_then(|data| field(data, "route"))
                    .and_then(|route| nested_text(route, "source", "counterpartyEntityId"))
                    .is_some_and(|value| normalized(value) == source)
        })
    {
        return Err(runtime_invalid(format!(
            "RUNTIME_OUTPUT_SELF_FORBIDDEN:{source}"
        )));
    }
    for tx in &output.entity_txs {
        let route = semantic_route(state, tx)?;
        let participants = route_participants(route);
        if !participants.iter().any(|value| value == &source)
            || !participants.iter().any(|value| value == &target)
        {
            return Err(runtime_invalid(format!(
                "RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN:{}:{source}:{target}",
                tx.kind.as_str()
            )));
        }
        let expected = route_signer(route, &source).unwrap_or_default();
        if expected.is_empty() || expected != source_signer {
            return Err(runtime_invalid(format!(
                "RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH:{source}:{source_signer}:{expected}"
            )));
        }
        authorize_semantic_role(state, &source, &target, tx, route)?;
    }
    Ok(())
}

fn collection(value: &mut Option<EntityCanonicalCollection>) -> &mut EntityCanonicalCollection {
    value.get_or_insert_with(EntityCanonicalCollection::empty)
}

fn insert_exact(
    target: &mut Option<EntityCanonicalCollection>,
    key: &str,
    value: CanonicalValue,
    kind: EntityTxKind,
) -> Result<(), EntityKernelError> {
    let target = collection(target);
    if let Some(existing) = target.get(key) {
        if existing == &value {
            return Ok(());
        }
        return Err(invalid(kind, format!("CONFLICT:{key}")));
    }
    target.insert(key.to_string(), value)?;
    Ok(())
}

fn projected(
    kind: EntityTxKind,
    data: CanonicalValue,
) -> Result<CanonicalEntityTx, EntityKernelError> {
    CanonicalEntityTx::from_frame_projection(kind, data)
        .map_err(|error| invalid(kind, error.to_string()))
}

fn routed(
    entity_id: &str,
    target_signer_id: Option<String>,
    txs: Vec<CanonicalEntityTx>,
) -> LocalEntityOutput {
    LocalEntityOutput {
        entity_id: normalized(entity_id),
        target_signer_id,
        entity_txs: txs
            .into_iter()
            .map(LocalEntityOutputTx::Projected)
            .collect(),
    }
}

fn routed_for_route(
    route: &CanonicalValue,
    entity_id: &str,
    txs: Vec<CanonicalEntityTx>,
    kind: EntityTxKind,
) -> Result<LocalEntityOutput, EntityKernelError> {
    let signer = route_signer(route, entity_id).ok_or_else(|| {
        invalid(
            kind,
            format!("CROSS_J_TARGET_SIGNER_MISSING:{}", normalized(entity_id)),
        )
    })?;
    Ok(routed(entity_id, Some(signer), txs))
}

pub(crate) fn plan_dispute_book_removal(
    local_entity_id: &str,
    counterparty_entity_id: &str,
    offer_id: &str,
    route_value: &CanonicalValue,
) -> Result<DisputeBookRemovalPlan, EntityKernelError> {
    let kind = EntityTxKind::RemoveCrossJurisdictionBookOrder;
    let route = canonical_route(route_value, kind)?;
    let book_owner = route_book_owner(&route);
    if book_owner.is_empty() {
        return Err(invalid(kind, "BOOK_OWNER_MISSING"));
    }
    let source_entity_id = nested_text(&route, "source", "entityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "SOURCE_ENTITY_ID_MISSING"))?;
    if book_owner == normalized(local_entity_id) {
        return Ok(DisputeBookRemovalPlan::Local { source_entity_id });
    }
    if route_signer(&route, &book_owner).is_none() {
        return Err(invalid(
            kind,
            format!(
                "DISPUTE_CROSS_J_BOOK_OWNER_SIGNER_MISSING:order={offer_id}:owner={book_owner}:source={source_entity_id}"
            ),
        ));
    }
    let data = CanonicalValue::Object(vec![
        (
            "orderId".into(),
            CanonicalValue::String(offer_id.to_string()),
        ),
        (
            "sourceEntityId".into(),
            CanonicalValue::String(source_entity_id),
        ),
        (
            "sourceAccountId".into(),
            CanonicalValue::String(normalized(counterparty_entity_id)),
        ),
        ("route".into(), route.clone()),
        (
            "reason".into(),
            CanonicalValue::String("account_dispute_prepare".into()),
        ),
    ]);
    Ok(DisputeBookRemovalPlan::Remote {
        output: routed_for_route(&route, &book_owner, vec![projected(kind, data)?], kind)?,
    })
}

fn route_tx(
    kind: EntityTxKind,
    route: &CanonicalValue,
) -> Result<CanonicalEntityTx, EntityKernelError> {
    projected(
        kind,
        CanonicalValue::Object(vec![("route".into(), route.clone())]),
    )
}

pub(crate) fn commit_cross_jurisdiction_book_fill(
    state: &mut EntityStateSlice,
    fill: CrossJurisdictionBookFill,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let kind = EntityTxKind::CrossJurisdictionFillNotice;
    let source_entity = nested_text(&fill.route, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "SOURCE_ENTITY_MISSING"))?;
    let source_hub = nested_text(&fill.route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "SOURCE_HUB_MISSING"))?;
    let admission_key = format!("{source_entity}:{}", fill.offer_id);
    if let Some(mut admission) = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
    {
        let fill_seq = unsigned(&fill.ack_data, "fillSeq").unwrap_or(0);
        let ratio = unsigned(&fill.ack_data, "cumulativeFillRatio").unwrap_or(0);
        let cumulative_source = required_bigint(&fill.ack_data, "cumulativeSourceAmount", kind)?;
        let cumulative_target = required_bigint(&fill.ack_data, "cumulativeTargetAmount", kind)?;
        let route_hash = text(&fill.ack_data, "routeHash").unwrap_or_default();
        let fill_id_preimage = format!(
            "{route_hash}|{}|{fill_seq}|{ratio}|{cumulative_source}|{cumulative_target}",
            fill.offer_id,
        );
        let fill_id = format!("0x{}", hex(&Keccak256::digest(fill_id_preimage.as_bytes())));
        let now = CanonicalValue::Number(
            CanonicalNumber::try_from_u64(state.timestamp)
                .map_err(|_| invalid(kind, "TIMESTAMP_UNSAFE"))?,
        );
        let mut pending_fields = vec![
            ("fillId".into(), string(&fill_id)),
            ("ackKind".into(), string("fill")),
            (
                "fillSeq".into(),
                field(&fill.ack_data, "fillSeq")
                    .expect("validated fillSeq")
                    .clone(),
            ),
            (
                "cumulativeFillRatio".into(),
                field(&fill.ack_data, "cumulativeFillRatio")
                    .expect("validated ratio")
                    .clone(),
            ),
            (
                "cumulativeSourceAmount".into(),
                CanonicalValue::BigInt(cumulative_source),
            ),
            (
                "cumulativeTargetAmount".into(),
                CanonicalValue::BigInt(cumulative_target),
            ),
            (
                "fillNumerator".into(),
                field(&fill.ack_data, "fillNumerator")
                    .ok_or_else(|| invalid(kind, "FILL_NUMERATOR_MISSING"))?
                    .clone(),
            ),
            (
                "fillDenominator".into(),
                field(&fill.ack_data, "fillDenominator")
                    .ok_or_else(|| invalid(kind, "FILL_DENOMINATOR_MISSING"))?
                    .clone(),
            ),
            ("routeHash".into(), string(route_hash)),
            ("updatedAt".into(), now.clone()),
            ("firstSeenAt".into(), now.clone()),
        ];
        if let Some(previous) = field(&fill.ack_data, "previousFillSeq") {
            pending_fields.push(("previousFillSeq".into(), previous.clone()));
        }
        set(
            &mut admission,
            "pendingFill",
            CanonicalValue::Object(pending_fields),
        )?;
        set(&mut admission, "updatedAt", now)?;
        collection(&mut state.cross_jurisdiction_book_admissions)
            .insert(admission_key, admission)?;
    }

    if normalized(&state.entity_id) == source_hub {
        return Ok(CrossJurisdictionApplyResult {
            outputs: Vec::new(),
            proposal_work: vec![AccountProposalWork {
                account_id: fill.account_id,
                txs: vec![AccountTx::CrossSwapFillAck {
                    data: fill.ack_data,
                }],
            }],
            events: Vec::new(),
            orderbook_deltas: Vec::new(),
            account_envelope_mutations: Vec::new(),
        });
    }
    let mut notice_fields = vec![("orderId".into(), string(&fill.offer_id))];
    for name in [
        "routeHash",
        "previousFillSeq",
        "fillSeq",
        "incrementalSourceAmount",
        "incrementalTargetAmount",
        "cumulativeSourceAmount",
        "cumulativeTargetAmount",
        "cumulativeFillRatio",
        "fillNumerator",
        "fillDenominator",
        "priceImprovementMode",
        "priceImprovementAmount",
        "priceImprovementTokenId",
        "cancelRemainder",
        "priceTicks",
        "pairId",
    ] {
        if let Some(value) = field(&fill.ack_data, name) {
            notice_fields.push((name.into(), value.clone()));
        }
    }
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed_for_route(
            &fill.route,
            &source_hub,
            vec![projected(
                EntityTxKind::CrossJurisdictionFillNotice,
                CanonicalValue::Object(notice_fields),
            )?],
            kind,
        )?],
        proposal_work: Vec::new(),
        events: Vec::new(),
        orderbook_deltas: Vec::new(),
        account_envelope_mutations: Vec::new(),
    })
}

fn validate_route_identity(
    kind: EntityTxKind,
    route: &CanonicalValue,
) -> Result<(), EntityKernelError> {
    let order_id = route_order_id(kind, route)?;
    let status = text(route, "status").ok_or_else(|| invalid(kind, "STATUS_MISSING"))?;
    if !matches!(
        status,
        "intent"
            | "target_prepared"
            | "resting"
            | "partially_filled"
            | "clear_requested"
            | "clearing"
            | "settled"
            | "cancelled"
            | "expired"
    ) {
        return Err(invalid(kind, format!("STATUS:{order_id}:{status}")));
    }
    for field in ["makerEntityId", "hubEntityId"] {
        if text(route, field)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(invalid(kind, format!("{field}:MISSING")));
        }
    }
    for (leg, fields) in [
        (
            "source",
            ["jurisdiction", "entityId", "counterpartyEntityId"],
        ),
        (
            "target",
            ["jurisdiction", "entityId", "counterpartyEntityId"],
        ),
    ] {
        let value = field(route, leg).ok_or_else(|| invalid(kind, format!("{leg}:MISSING")))?;
        for name in fields {
            if text(value, name)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(invalid(kind, format!("{leg}.{name}:MISSING")));
            }
        }
    }
    Ok(())
}

fn apply_prepare(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let route = route(tx)?.clone();
    validate_route_identity(tx.kind, &route)?;
    let order_id = route_order_id(tx.kind, &route)?.to_string();
    let local = normalized(&state.entity_id);
    let source_user = normalized(nested_text(&route, "source", "entityId").unwrap_or_default());
    let target_user =
        normalized(nested_text(&route, "target", "counterpartyEntityId").unwrap_or_default());
    let source_hub =
        normalized(nested_text(&route, "source", "counterpartyEntityId").unwrap_or_default());
    if local == source_user || local == target_user {
        insert_exact(
            &mut state.cross_jurisdiction_authorizations,
            &order_id,
            route.clone(),
            tx.kind,
        )?;
        if local != source_user {
            return Ok(CrossJurisdictionApplyResult::default());
        }
        return Ok(CrossJurisdictionApplyResult {
            outputs: vec![routed_for_route(
                &route,
                &source_hub,
                vec![route_tx(
                    EntityTxKind::PrepareCrossJurisdictionSwap,
                    &route,
                )?],
                tx.kind,
            )?],
            events: vec![EntityFrameEvent::Status {
                message: format!("🌉 Cross-j swap {order_id} authorized by source user"),
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }
    if local != source_hub {
        return Err(invalid(tx.kind, format!("WRONG_ENTITY:{order_id}:{local}")));
    }
    insert_exact(
        &mut state.cross_jurisdiction_swaps,
        &order_id,
        route,
        tx.kind,
    )?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![LocalEntityOutput::non_mutating_wake(local)],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn apply_materialize_swap(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let route = route(tx)?.clone();
    validate_route_identity(tx.kind, &route)?;
    let order_id = route_order_id(tx.kind, &route)?.to_string();
    let prior = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|values| values.get(&order_id))
        .ok_or_else(|| invalid(tx.kind, format!("INTENT_MISSING:{order_id}")))?;
    if text(prior, "status") != Some("intent") {
        return Err(invalid(tx.kind, format!("INTENT_STATUS:{order_id}")));
    }
    if field(prior, "sourcePull").is_some() || field(prior, "targetPull").is_some() {
        return Err(invalid(
            tx.kind,
            format!("INTENT_ALREADY_MATERIALIZED:{order_id}"),
        ));
    }
    if field(&route, "sourcePull").is_none() || field(&route, "targetPull").is_none() {
        return Err(invalid(tx.kind, format!("PULLS_MISSING:{order_id}")));
    }
    // Pull commitments are derived by the default proposer, but every public
    // intent byte was already authorized and committed. Strip only the two new
    // pulls and compare the canonical bytes; routeHash alone intentionally
    // omits materialization fields and cannot authorize a rewritten intent.
    let mut materialized_intent = route.clone();
    remove(&mut materialized_intent, "sourcePull")?;
    remove(&mut materialized_intent, "targetPull")?;
    if let Some(status) = field(prior, "status") {
        set(&mut materialized_intent, "status", status.clone())?;
    }
    if let Some(updated_at) = field(prior, "updatedAt") {
        set(&mut materialized_intent, "updatedAt", updated_at.clone())?;
    }
    let prior_bytes = encode_canonical_consensus_bytes(prior)
        .map_err(|error| invalid(tx.kind, format!("INTENT_ENCODE:{error}")))?;
    let materialized_bytes = encode_canonical_consensus_bytes(&materialized_intent)
        .map_err(|error| invalid(tx.kind, format!("MATERIALIZED_INTENT_ENCODE:{error}")))?;
    if materialized_bytes != prior_bytes {
        return Err(invalid(tx.kind, format!("INTENT_MISMATCH:{order_id}")));
    }
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route.clone())?;
    let mut ready = route;
    set(
        &mut ready,
        "status",
        CanonicalValue::String("resting".into()),
    )?;
    let source_hub = nested_text(&ready, "source", "counterpartyEntityId")
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    let target_hub = nested_text(&ready, "target", "entityId")
        .ok_or_else(|| invalid(tx.kind, "TARGET_HUB_MISSING"))?;
    let register = route_tx(EntityTxKind::RegisterCrossJurisdictionSwap, &ready)?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![
            routed_for_route(&ready, source_hub, vec![register.clone()], tx.kind)?,
            routed_for_route(&ready, target_hub, vec![register], tx.kind)?,
        ],
        events: vec![EntityFrameEvent::Status {
            message: format!(
                "🌉 Cross-j swap {order_id} paired source and target proposals requested by hub"
            ),
        }],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn pull_binding(
    route: &CanonicalValue,
    leg: &'static str,
    kind: EntityTxKind,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut fields = vec![
        (
            "orderId".into(),
            CanonicalValue::String(route_order_id(kind, route)?.to_string()),
        ),
        (
            "routeHash".into(),
            CanonicalValue::String(
                text(route, "routeHash")
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| invalid(kind, "ROUTE_HASH_MISSING"))?
                    .to_string(),
            ),
        ),
        ("leg".into(), CanonicalValue::String(leg.into())),
    ];
    for field_name in [
        "sourceCloseProof",
        "status",
        "cumulativeFillRatio",
        "fillSeq",
        "fillNumerator",
        "fillDenominator",
        "claimedRatio",
        "filledSourceAmount",
        "filledTargetAmount",
        "sourceClaimed",
        "targetClaimed",
        "clearingPolicy",
    ] {
        if let Some(value) = field(route, field_name) {
            fields.push((field_name.into(), value.clone()));
        }
    }
    Ok(CanonicalValue::Object(fields))
}

fn cross_pull_lock(
    route: &CanonicalValue,
    leg_name: &'static str,
    kind: EntityTxKind,
) -> Result<AccountTx, EntityKernelError> {
    let pull = field(
        route,
        if leg_name == "source" {
            "sourcePull"
        } else {
            "targetPull"
        },
    )
    .ok_or_else(|| invalid(kind, format!("{leg_name}:PULL_MISSING")))?;
    let mut data = Vec::new();
    for name in ["pullId", "tokenId", "fullHash", "partialRoot"] {
        let value =
            field(pull, name).ok_or_else(|| invalid(kind, format!("{leg_name}.{name}:MISSING")))?;
        data.push((name.into(), value.clone()));
    }
    let signed_amount = field(pull, "signedAmount")
        .ok_or_else(|| invalid(kind, format!("{leg_name}.signedAmount:MISSING")))?;
    // The committed route calls the signed leg amount `signedAmount`, while
    // the canonical Account `cross_pull_lock` wire calls the same value
    // `amount`. Preserve the value exactly and change only its schema key.
    data.push(("amount".into(), signed_amount.clone()));
    data.push((
        "crossJurisdiction".into(),
        pull_binding(route, leg_name, kind)?,
    ));
    data.push(("crossJurisdictionRoute".into(), route.clone()));
    Ok(AccountTx::CrossPullLock {
        data: CanonicalValue::Object(data),
    })
}

fn registration_work(
    state: &EntityStateSlice,
    route: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<Vec<AccountProposalWork>, EntityKernelError> {
    let local = normalized(&state.entity_id);
    let source_hub = normalized(
        nested_text(route, "source", "counterpartyEntityId")
            .ok_or_else(|| invalid(kind, "SOURCE_HUB_MISSING"))?,
    );
    let target_hub = normalized(
        nested_text(route, "target", "entityId")
            .ok_or_else(|| invalid(kind, "TARGET_HUB_MISSING"))?,
    );
    if local == source_hub {
        let source = field(route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
        let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
        let account_id = text(source, "entityId")
            .filter(|value| state.known_accounts.contains(value))
            .ok_or_else(|| invalid(kind, "SOURCE_ACCOUNT_MISSING"))?
            .to_string();
        let give_token_id = required_u32(source, "tokenId", kind)?;
        let want_token_id = required_u32(target, "tokenId", kind)?;
        let give_amount = required_bigint(source, "amount", kind)?;
        let want_amount = required_bigint(target, "amount", kind)?;
        return Ok(vec![AccountProposalWork {
            account_id,
            txs: vec![
                cross_pull_lock(route, "source", kind)?,
                AccountTx::SwapOffer {
                    offer_id: route_order_id(kind, route)?.to_string(),
                    give_token_id,
                    give_token_decimals: crate::canonical_token_decimals(give_token_id)
                        .ok_or_else(|| invalid(kind, "GIVE_TOKEN_METADATA_MISSING"))?,
                    give_amount,
                    want_token_id,
                    want_token_decimals: crate::canonical_token_decimals(want_token_id)
                        .ok_or_else(|| invalid(kind, "WANT_TOKEN_METADATA_MISSING"))?,
                    want_amount: want_amount.clone(),
                    max_fee: BigInt::from(0),
                    min_net_receive: want_amount,
                    time_in_force: Some(0),
                    price_ticks: bigint(route, "priceTicks"),
                    cross_jurisdiction: Some(route.clone()),
                },
            ],
        }]);
    }
    if local == target_hub {
        let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
        let account_id = text(target, "counterpartyEntityId")
            .filter(|value| state.known_accounts.contains(value))
            .ok_or_else(|| invalid(kind, "TARGET_ACCOUNT_MISSING"))?
            .to_string();
        return Ok(vec![AccountProposalWork {
            account_id,
            txs: vec![cross_pull_lock(route, "target", kind)?],
        }]);
    }
    Ok(Vec::new())
}

/// Exact Account ids whose committed cross-J routes may hold an opening
/// mempool or pending cohort. This transient projection never scans unrelated
/// Accounts or reads future Entity-mempool work.
pub fn cross_j_opening_account_ids(
    state: &EntityStateSlice,
) -> Result<Vec<String>, EntityKernelError> {
    let mut account_ids = BTreeSet::new();
    for (_, route) in state
        .cross_jurisdiction_swaps
        .iter()
        .flat_map(|routes| routes.keyed_values())
    {
        // TS selects an opening cohort from Account mempool legs. A committed
        // intent without its two materialized pulls has no such legs yet and
        // must not be interpreted as registration work while the materialize
        // Entity frame is still being prepared.
        if field(route, "sourcePull").is_none() || field(route, "targetPull").is_none() {
            continue;
        }
        account_ids.extend(
            registration_work(state, route, EntityTxKind::RegisterCrossJurisdictionSwap)?
                .into_iter()
                .map(|work| work.account_id),
        );
    }
    Ok(account_ids.into_iter().collect())
}

fn apply_register(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let route = route(tx)?.clone();
    validate_route_identity(tx.kind, &route)?;
    let order_id = route_order_id(tx.kind, &route)?.to_string();
    let local = normalized(&state.entity_id);
    let participants = [
        nested_text(&route, "source", "entityId"),
        nested_text(&route, "source", "counterpartyEntityId"),
        nested_text(&route, "target", "entityId"),
        nested_text(&route, "target", "counterpartyEntityId"),
    ];
    if !participants
        .into_iter()
        .flatten()
        .any(|entity| normalized(entity) == local)
    {
        return Err(invalid(tx.kind, format!("NON_PARTICIPANT:{order_id}")));
    }
    let registered_event = EntityFrameEvent::Status {
        message: format!("🌉 Cross-j swap {order_id} registered"),
    };
    let proposal_work = registration_work(state, &route, tx.kind)?;
    let collection = collection(&mut state.cross_jurisdiction_swaps);
    match collection.get(&order_id) {
        Some(existing) if existing == &route => {}
        Some(existing)
            if text(existing, "routeHash").is_some()
                && text(existing, "routeHash") == text(&route, "routeHash") =>
        {
            collection.insert(order_id, route.clone())?;
        }
        Some(_) => return Err(invalid(tx.kind, "ROUTE_CONFLICT")),
        None => {
            collection.insert(order_id, route.clone())?;
        }
    }
    Ok(CrossJurisdictionApplyResult {
        outputs: Vec::new(),
        proposal_work,
        events: vec![registered_event],
        orderbook_deltas: Vec::new(),
        account_envelope_mutations: Vec::new(),
    })
}

fn status_rank(status: Option<&str>) -> u8 {
    match status {
        Some("intent") => 0,
        Some("target_prepared") => 1,
        Some("resting") => 2,
        Some("partially_filled") => 3,
        Some("clear_requested") => 4,
        Some("clearing") => 5,
        Some("settled") | Some("cancelled") | Some("expired") => 6,
        _ => 0,
    }
}

fn apply_admit(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let supplied = route(tx)?;
    let canonical = canonical_route(&supplied, tx.kind)?;
    validate_route_identity(tx.kind, &canonical)?;
    let order_id = route_order_id(tx.kind, &canonical)?.to_string();
    let source_entity = nested_text(&canonical, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_ENTITY_MISSING"))?;
    let book_owner = route_book_owner(&canonical);
    let local = normalized(&state.entity_id);
    if book_owner != local {
        return Err(invalid(
            tx.kind,
            format!("CROSS_J_BOOK_ADMIT_WRONG_OWNER:{order_id}:{book_owner}:{local}"),
        ));
    }
    let route_hash = text(&canonical, "routeHash")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ROUTE_HASH_MISSING"))?;
    let admission_key = format!("{source_entity}:{order_id}");
    if let Some(existing) = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
    {
        let existing_hash = text(&existing, "routeHash")
            .map(normalized)
            .unwrap_or_default();
        if existing_hash != route_hash {
            return Err(invalid(tx.kind, "CROSS_J_BOOK_ADMIT_ROUTE_INVALID"));
        }
        if matches!(text(&existing, "status"), Some("closed" | "resolving")) {
            return Ok(CrossJurisdictionApplyResult::default());
        }
    }

    let selected_route = match state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
    {
        Some(existing) => {
            let existing_hash = text(existing, "routeHash")
                .map(normalized)
                .unwrap_or_default();
            if existing_hash != route_hash {
                return Err(invalid(tx.kind, "CROSS_J_BOOK_ADMIT_ROUTE_INVALID"));
            }
            if status_rank(text(existing, "status")) > status_rank(text(&canonical, "status")) {
                existing.clone()
            } else {
                canonical.clone()
            }
        }
        None => canonical.clone(),
    };
    collection(&mut state.cross_jurisdiction_swaps)
        .insert(order_id.clone(), selected_route.clone())?;
    let now = CanonicalValue::Number(
        CanonicalNumber::try_from_u64(state.timestamp)
            .map_err(|_| invalid(tx.kind, "TIMESTAMP_UNSAFE"))?,
    );
    let mut admission = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
        .unwrap_or_else(|| CanonicalValue::Object(Vec::new()));
    for (name, value) in [
        ("orderId", string(&order_id)),
        ("routeHash", string(&route_hash)),
        ("sourceEntityId", string(&source_entity)),
        ("bookOwnerEntityId", string(&book_owner)),
        ("status", string("admitted")),
        ("route", selected_route.clone()),
        ("updatedAt", now.clone()),
    ] {
        set(&mut admission, name, value)?;
    }
    if field(&admission, "admittedAt").is_none() {
        set(&mut admission, "admittedAt", now)?;
    }
    collection(&mut state.cross_jurisdiction_book_admissions).insert(admission_key, admission)?;
    let (account_id, offer) = cross_jurisdiction_working_offer(&selected_route)?;
    let reason = tx
        .frame_data()
        .and_then(|data| text(data, "reason"))
        .filter(|reason| !reason.is_empty());
    let suffix = reason.map_or_else(String::new, |reason| format!(": {reason}"));
    Ok(CrossJurisdictionApplyResult {
        outputs: Vec::new(),
        proposal_work: Vec::new(),
        events: vec![EntityFrameEvent::Status {
            message: format!("🌉 Cross-j book admit {order_id}{suffix}"),
        }],
        // TS accepts the admission without materializing an orderbook when
        // this Entity has no orderbook extension. The admission and route are
        // still committed; there is simply no local matcher projection.
        orderbook_deltas: state
            .orderbook
            .is_some()
            .then(|| SameJOutputDelta::Upsert {
                account_id,
                offer: Box::new(offer),
            })
            .into_iter()
            .collect(),
        account_envelope_mutations: Vec::new(),
    })
}

fn apply_remove_book_order(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let supplied_route = field(data, "route").ok_or_else(|| invalid(tx.kind, "ROUTE_MISSING"))?;
    let route = canonical_route(supplied_route, tx.kind)?;
    let order_id = required_text(data, "orderId", tx)?;
    let source_entity = required_text(data, "sourceEntityId", tx)?;
    let source_account = required_text(data, "sourceAccountId", tx)?;
    let reason = text(data, "reason").unwrap_or("cancel_request");
    let removal_message = format!(
        "🌉 Cross-j book remove {order_id}{} {}",
        if reason.is_empty() {
            String::new()
        } else {
            format!(": {reason}")
        },
        if state.orderbook.is_some() {
            "removed"
        } else {
            "not-present"
        },
    );
    if route_order_id(tx.kind, &route)? != order_id
        || nested_text(&route, "source", "entityId").map(normalized) != Some(source_entity.clone())
        || route_book_owner(&route) != normalized(&state.entity_id)
    {
        return Err(invalid(tx.kind, "CROSS_J_BOOK_REMOVAL_ROUTE_MISMATCH"));
    }
    let route_hash = text(&route, "routeHash")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "ROUTE_HASH_MISSING"))?;
    let admission_key = format!("{source_entity}:{order_id}");
    let mut admission = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
        .ok_or_else(|| {
            invalid(
                tx.kind,
                format!("CROSS_J_CANCEL_ADMISSION_MISSING:{order_id}:{source_entity}"),
            )
        })?;
    if text(&admission, "routeHash").map(normalized) != Some(route_hash) {
        return Err(invalid(tx.kind, "CROSS_J_CANCEL_ADMISSION_ROUTE_MISMATCH"));
    }
    if let Some(pending) = field(&admission, "pendingCancel")
        && text(pending, "sourceAccountId").map(normalized) != Some(source_account.clone())
    {
        return Err(invalid(tx.kind, "CROSS_J_CANCEL_SOURCE_ACCOUNT_MISMATCH"));
    }
    let now = CanonicalValue::Number(
        CanonicalNumber::try_from_u64(state.timestamp)
            .map_err(|_| invalid(tx.kind, "TIMESTAMP_UNSAFE"))?,
    );
    if field(&admission, "pendingCancel").is_none() {
        set(
            &mut admission,
            "pendingCancel",
            CanonicalValue::Object(vec![
                ("sourceAccountId".into(), string(&source_account)),
                ("requestedAt".into(), now.clone()),
                ("reason".into(), string(reason)),
            ]),
        )?;
    }
    if text(&admission, "status") != Some("closed") {
        set(&mut admission, "status", string("resolving"))?;
        if field(&admission, "resolvingAt").is_none() {
            set(&mut admission, "resolvingAt", now.clone())?;
        }
    }
    set(&mut admission, "updatedAt", now.clone())?;

    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    if source_hub.is_empty() || source_hub == normalized(&state.entity_id) {
        return Err(invalid(tx.kind, "CROSS_J_BOOK_REMOVAL_ACK_TARGET_INVALID"));
    }
    if route_signer(&route, &source_hub).is_none() {
        return Err(invalid(tx.kind, "CROSS_J_BOOK_REMOVAL_ACK_SIGNER_MISSING"));
    }
    let ack = projected(
        EntityTxKind::CrossJurisdictionBookOrderRemoved,
        CanonicalValue::Object(vec![
            ("orderId".into(), string(&order_id)),
            ("sourceEntityId".into(), string(&source_entity)),
            ("sourceAccountId".into(), string(&source_account)),
            ("route".into(), route.clone()),
            ("removedAt".into(), now.clone()),
            ("reason".into(), string(reason)),
        ]),
    )?;
    if field(&admission, "pendingFill").is_none() {
        set(&mut admission, "status", string("closed"))?;
        set(&mut admission, "closedAt", now.clone())?;
        set(&mut admission, "closeReason", string(reason))?;
        remove(&mut admission, "pendingFill")?;
        remove(&mut admission, "pendingCancel")?;
        set(&mut admission, "updatedAt", now)?;
    }
    collection(&mut state.cross_jurisdiction_book_admissions).insert(admission_key, admission)?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed_for_route(&route, &source_hub, vec![ack], tx.kind)?],
        proposal_work: Vec::new(),
        events: vec![EntityFrameEvent::Status {
            message: removal_message,
        }],
        orderbook_deltas: vec![SameJOutputDelta::Remove {
            account_id: source_entity,
            offer_id: order_id,
        }],
        account_envelope_mutations: Vec::new(),
    })
}

fn apply_book_order_removed(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let supplied_route = field(data, "route").ok_or_else(|| invalid(tx.kind, "ROUTE_MISSING"))?;
    let route = canonical_route(supplied_route, tx.kind)?;
    let order_id = required_text(data, "orderId", tx)?;
    let source_entity = required_text(data, "sourceEntityId", tx)?;
    let source_account = required_text(data, "sourceAccountId", tx)?;
    let removed_at =
        unsigned(data, "removedAt").ok_or_else(|| invalid(tx.kind, "REMOVED_AT_MISSING"))?;
    let reason = text(data, "reason").unwrap_or("cancel_request");
    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    if source_hub != normalized(&state.entity_id)
        || route_order_id(tx.kind, &route)? != order_id
        || nested_text(&route, "source", "entityId").map(normalized) != Some(source_entity.clone())
    {
        return Err(invalid(tx.kind, "CROSS_J_BOOK_REMOVAL_ACK_ROUTE_MISMATCH"));
    }
    let current = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|values| values.get(&order_id))
        .ok_or_else(|| invalid(tx.kind, "CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING"))?;
    if text(current, "routeHash").map(normalized) != text(&route, "routeHash").map(normalized) {
        return Err(invalid(
            tx.kind,
            "CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH",
        ));
    }
    let admission_key = format!("{source_entity}:{order_id}");
    if let Some(mut admission) = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
    {
        let now = CanonicalValue::Number(
            CanonicalNumber::try_from_u64(removed_at)
                .map_err(|_| invalid(tx.kind, "REMOVED_AT_UNSAFE"))?,
        );
        let mut pending = field(&admission, "pendingCancel")
            .cloned()
            .unwrap_or_else(|| CanonicalValue::Object(Vec::new()));
        set(&mut pending, "sourceAccountId", string(&source_account))?;
        if field(&pending, "requestedAt").is_none() {
            set(&mut pending, "requestedAt", now.clone())?;
        }
        if field(&pending, "reason").is_none() {
            set(&mut pending, "reason", string(reason))?;
        }
        if field(&pending, "bookRemovalCommittedAt").is_none() {
            set(&mut pending, "bookRemovalCommittedAt", now.clone())?;
        }
        set(&mut admission, "pendingCancel", pending)?;
        if text(&admission, "status") != Some("closed") {
            set(&mut admission, "status", string("resolving"))?;
            if field(&admission, "resolvingAt").is_none() {
                set(&mut admission, "resolvingAt", now.clone())?;
            }
        }
        set(&mut admission, "updatedAt", now)?;
        collection(&mut state.cross_jurisdiction_book_admissions)
            .insert(admission_key, admission)?;
    }
    let pending_dispute_removal = account_views
        .get(&source_account)
        .and_then(|view| view.dispute.as_ref())
        .filter(|dispute| dispute.status == "dispute_preparing")
        .and_then(|dispute| dispute.dispute_prepare.as_ref())
        .and_then(|prepare| field(prepare, "pendingOrderbookRemovalIds"))
        .is_some_and(|ids| {
            matches!(ids, CanonicalValue::Array(values) if values.iter().any(|value| value == &string(&order_id)))
        });
    Ok(CrossJurisdictionApplyResult {
        outputs: Vec::new(),
        proposal_work: Vec::new(),
        events: vec![EntityFrameEvent::Status {
            message: format!(
                "🌉 Cross-j {} {order_id}",
                if pending_dispute_removal {
                    "dispute book removal confirmed"
                } else {
                    "book removal committed"
                }
            ),
        }],
        orderbook_deltas: Vec::new(),
        account_envelope_mutations: pending_dispute_removal
            .then_some((
                source_account,
                crate::AccountEnvelopeMutation::ConfirmDisputeBookRemoval { order_id },
            ))
            .into_iter()
            .collect(),
    })
}

fn close_binary_hash(binary: &str, kind: EntityTxKind) -> Result<String, EntityKernelError> {
    let payload = binary
        .strip_prefix("0x")
        .filter(|value| value.len() % 2 == 0)
        .ok_or_else(|| invalid(kind, "CLOSE_BINARY_HEX"))?;
    let bytes = ::hex::decode(payload).map_err(|_| invalid(kind, "CLOSE_BINARY_HEX"))?;
    Ok(format!("0x{}", hex(&Keccak256::digest(bytes))))
}

fn close_proofs_match(left: &CanonicalValue, right: &CanonicalValue) -> bool {
    for name in [
        "orderId",
        "sourcePullId",
        "targetPullId",
        "fillRatio",
        "cumulativeSourceAmount",
        "cumulativeTargetAmount",
        "closeMode",
    ] {
        if field(left, name) != field(right, name) {
            return false;
        }
    }
    ["routeHash", "binaryHash"]
        .into_iter()
        .all(|name| text(left, name).map(normalized) == text(right, name).map(normalized))
}

fn build_close_proof(
    route: &CanonicalValue,
    binary: &str,
    kind: EntityTxKind,
) -> Result<CanonicalValue, EntityKernelError> {
    let order_id = route_order_id(kind, route)?;
    let route_hash = text(route, "routeHash")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "ROUTE_HASH_MISSING"))?;
    let source_pull =
        field(route, "sourcePull").ok_or_else(|| invalid(kind, "SOURCE_PULL_MISSING"))?;
    let target_pull =
        field(route, "targetPull").ok_or_else(|| invalid(kind, "TARGET_PULL_MISSING"))?;
    let source_pull_id = text(source_pull, "pullId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "SOURCE_PULL_ID_MISSING"))?;
    let target_pull_id = text(target_pull, "pullId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "TARGET_PULL_ID_MISSING"))?;
    let (fill_ratio, source_amount, target_amount) = committed_fill(route, kind)?;
    let close_mode = if fill_ratio >= 65_535 {
        "full"
    } else if fill_ratio == 0 {
        "pure_cancel"
    } else {
        "partial_cancel_remainder"
    };
    Ok(CanonicalValue::Object(vec![
        ("orderId".into(), string(order_id)),
        ("routeHash".into(), string(route_hash)),
        ("sourcePullId".into(), string(source_pull_id)),
        ("targetPullId".into(), string(target_pull_id)),
        ("fillRatio".into(), number(fill_ratio, kind, "FILL_RATIO")?),
        (
            "cumulativeSourceAmount".into(),
            CanonicalValue::BigInt(source_amount),
        ),
        (
            "cumulativeTargetAmount".into(),
            CanonicalValue::BigInt(target_amount),
        ),
        (
            "binaryHash".into(),
            string(close_binary_hash(binary, kind)?),
        ),
        ("closeMode".into(), string(close_mode)),
    ]))
}

fn apply_cross_pull_close(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let counterparty = text(data, "counterpartyEntityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "COUNTERPARTY_ENTITY_ID_MISSING"))?;
    let pull_id = text(data, "pullId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "PULL_ID_MISSING"))?;
    let binary = text(data, "binary").ok_or_else(|| invalid(tx.kind, "BINARY_MISSING"))?;
    let proof = field(data, "proof").ok_or_else(|| invalid(tx.kind, "PROOF_MISSING"))?;
    let order_id = text(proof, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "PROOF_ORDER_ID_MISSING"))?
        .to_string();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&order_id))
        .cloned()
        .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{order_id}")))?;
    if terminal_route(&route) {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    let local = normalized(&state.entity_id);
    let source_pull =
        field(&route, "sourcePull").ok_or_else(|| invalid(tx.kind, "SOURCE_PULL_MISSING"))?;
    let target_pull =
        field(&route, "targetPull").ok_or_else(|| invalid(tx.kind, "TARGET_PULL_MISSING"))?;
    let source_role = nested_text(&route, "source", "counterpartyEntityId")
        .is_some_and(|value| normalized(value) == local)
        && nested_text(&route, "source", "entityId")
            .is_some_and(|value| normalized(value) == counterparty)
        && text(source_pull, "pullId") == Some(pull_id);
    let target_role = nested_text(&route, "target", "entityId")
        .is_some_and(|value| normalized(value) == local)
        && nested_text(&route, "target", "counterpartyEntityId")
            .is_some_and(|value| normalized(value) == counterparty)
        && text(target_pull, "pullId") == Some(pull_id);
    if source_role == target_role {
        return Err(invalid(
            tx.kind,
            format!("PULL_ROLE_INVALID:{order_id}:{pull_id}"),
        ));
    }
    if !state.known_accounts.contains(&counterparty) {
        return Err(invalid(tx.kind, format!("ACCOUNT_MISSING:{counterparty}")));
    }
    if source_role && !matches!(text(&route, "status"), Some("clearing" | "clear_requested")) {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    if text(proof, "routeHash").map(normalized) != text(&route, "routeHash").map(normalized)
        || text(proof, "orderId") != Some(order_id.as_str())
        || text(proof, "sourcePullId") != text(source_pull, "pullId")
        || text(proof, "targetPullId") != text(target_pull, "pullId")
        || text(proof, "binaryHash").map(normalized)
            != Some(normalized(&close_binary_hash(binary, tx.kind)?))
    {
        return Err(invalid(tx.kind, format!("CLOSE_PROOF_BINDING:{order_id}")));
    }
    if let Some(command_route) = field(data, "route")
        && (text(command_route, "orderId") != Some(order_id.as_str())
            || text(command_route, "routeHash").map(normalized)
                != text(proof, "routeHash").map(normalized)
            || field(command_route, "sourcePull").and_then(|pull| text(pull, "pullId"))
                != text(proof, "sourcePullId")
            || field(command_route, "targetPull").and_then(|pull| text(pull, "pullId"))
                != text(proof, "targetPullId"))
    {
        return Err(invalid(
            tx.kind,
            format!("COMMAND_ROUTE_MISMATCH:{order_id}"),
        ));
    }
    let commitment = if source_role {
        source_pull
    } else {
        target_pull
    };
    let verified = xln_rscore_engine::verify_hash_ladder_binary(
        text(commitment, "fullHash").unwrap_or(""),
        text(commitment, "partialRoot").unwrap_or(""),
        binary,
    )
    .map_err(|detail| invalid(tx.kind, detail))?;
    if unsigned(proof, "fillRatio") != Some(verified) {
        return Err(invalid(tx.kind, format!("PROOF_RATIO:{order_id}")));
    }
    if target_role {
        let source_proof = field(&route, "sourceCloseProof")
            .or_else(|| field(data, "route").and_then(|value| field(value, "sourceCloseProof")))
            .ok_or_else(|| invalid(tx.kind, format!("SOURCE_CLOSE_PROOF_MISSING:{order_id}")))?;
        if !close_proofs_match(source_proof, proof) {
            return Err(invalid(
                tx.kind,
                format!("SOURCE_CLOSE_PROOF_MISMATCH:{order_id}"),
            ));
        }
    }
    let (route_ratio, _, _) = committed_fill(&route, tx.kind)?;
    if source_role || route_ratio > 0 {
        let expected = build_close_proof(&route, binary, tx.kind)?;
        if !close_proofs_match(&expected, proof) {
            return Err(invalid(
                tx.kind,
                format!("CLOSE_PROOF_ECONOMICS:{order_id}"),
            ));
        }
    }
    set(&mut route, "sourceCloseProof", proof.clone())?;
    if target_role {
        for (target, source) in [
            ("cumulativeFillRatio", "fillRatio"),
            ("claimedRatio", "fillRatio"),
            ("filledSourceAmount", "cumulativeSourceAmount"),
            ("filledTargetAmount", "cumulativeTargetAmount"),
            ("sourceClaimed", "cumulativeSourceAmount"),
            ("targetClaimed", "cumulativeTargetAmount"),
        ] {
            set(
                &mut route,
                target,
                field(proof, source)
                    .cloned()
                    .ok_or_else(|| invalid(tx.kind, format!("PROOF_FIELD_MISSING:{source}")))?,
            )?;
        }
        set(&mut route, "clearingPolicy", string("cancel_and_clear"))?;
        if field(&route, "pendingClearRequestedAt").is_none() {
            set(
                &mut route,
                "pendingClearRequestedAt",
                number(state.timestamp, tx.kind, "TIMESTAMP")?,
            )?;
        }
        set(&mut route, "status", string("clearing"))?;
        set(
            &mut route,
            "updatedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
    }
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id, route)?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![LocalEntityOutput::non_mutating_wake(local)],
        proposal_work: vec![AccountProposalWork {
            account_id: counterparty,
            txs: vec![AccountTx::CrossPullClose {
                data: CanonicalValue::Object(vec![
                    ("pullId".into(), string(pull_id)),
                    ("binary".into(), string(binary)),
                    ("proof".into(), proof.clone()),
                ]),
            }],
        }],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn word(
    value: &str,
    kind: EntityTxKind,
    field: &'static str,
) -> Result<[u8; 32], EntityKernelError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid(kind, format!("{field}:BYTES32")))?;
    let bytes = ::hex::decode(payload).map_err(|_| invalid(kind, format!("{field}:HEX")))?;
    bytes
        .try_into()
        .map_err(|_| invalid(kind, format!("{field}:BYTES32")))
}

fn salvage_witness(
    binary: &str,
    verified_ratio: u64,
    kind: EntityTxKind,
) -> Result<crate::j_batch::HashLadderWitness, EntityKernelError> {
    let bytes = ::hex::decode(
        binary
            .strip_prefix("0x")
            .filter(|value| value.len() % 2 == 0)
            .ok_or_else(|| invalid(kind, "BINARY_HEX"))?,
    )
    .map_err(|_| invalid(kind, "BINARY_HEX"))?;
    let fill_ratio = u16::try_from(verified_ratio).map_err(|_| invalid(kind, "FILL_RATIO_U16"))?;
    let mut full_secret = [0_u8; 32];
    let mut reveals = [[0_u8; 32]; 4];
    if bytes.len() == 32 {
        full_secret.copy_from_slice(&bytes);
    } else if bytes.len() == 130 {
        for (index, reveal) in reveals.iter_mut().enumerate() {
            reveal.copy_from_slice(&bytes[2 + index * 32..2 + (index + 1) * 32]);
        }
    } else {
        return Err(invalid(kind, format!("BINARY_LENGTH:{}", bytes.len())));
    }
    Ok(crate::j_batch::HashLadderWitness {
        fill_ratio,
        full_secret,
        reveals,
    })
}

fn pending_witness_value(
    witness: &crate::j_batch::HashLadderWitness,
    kind: EntityTxKind,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Object(vec![
        (
            "fillRatio".into(),
            number(u64::from(witness.fill_ratio), kind, "FILL_RATIO")?,
        ),
        (
            "fullSecret".into(),
            string(format!("0x{}", hex(&witness.full_secret))),
        ),
        (
            "reveals".into(),
            CanonicalValue::Array(
                witness
                    .reveals
                    .iter()
                    .map(|value| string(format!("0x{}", hex(value))))
                    .collect(),
            ),
        ),
    ]))
}

fn pending_witness(
    value: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<crate::j_batch::HashLadderWitness, EntityKernelError> {
    let fill_ratio = unsigned(value, "fillRatio")
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(kind, "PENDING_REVEAL_FILL_RATIO"))?;
    let full_secret = word(
        text(value, "fullSecret").ok_or_else(|| invalid(kind, "PENDING_REVEAL_SECRET"))?,
        kind,
        "PENDING_REVEAL_SECRET",
    )?;
    let CanonicalValue::Array(values) =
        field(value, "reveals").ok_or_else(|| invalid(kind, "PENDING_REVEAL_REVEALS"))?
    else {
        return Err(invalid(kind, "PENDING_REVEAL_REVEALS"));
    };
    if values.len() != 4 {
        return Err(invalid(kind, "PENDING_REVEAL_REVEALS_LENGTH"));
    }
    let mut reveals = [[0_u8; 32]; 4];
    for (index, value) in values.iter().enumerate() {
        let CanonicalValue::String(value) = value else {
            return Err(invalid(kind, "PENDING_REVEAL_REVEAL"));
        };
        reveals[index] = word(value, kind, "PENDING_REVEAL_REVEAL")?;
    }
    Ok(crate::j_batch::HashLadderWitness {
        fill_ratio,
        full_secret,
        reveals,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistrationQueueResult {
    AlreadyQueued,
    Queued { broadcast_now: bool },
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SignedProofPull {
    amount: BigInt,
    claimed_ratio: u16,
    full_hash: [u8; 32],
    partial_root: [u8; 32],
    target_role: bool,
}

fn signed_int(value: U256) -> BigInt {
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    let unsigned = BigInt::from(BigUint::from_bytes_be(&bytes));
    if bytes[0] & 0x80 == 0 {
        unsigned
    } else {
        unsigned - (BigInt::from(1_u8) << 256_u32)
    }
}

fn delta_batch_param() -> ParamType {
    ParamType::Tuple(vec![
        ParamType::Array(Box::new(ParamType::Tuple(vec![
            ParamType::Uint(256),
            ParamType::Int(256),
            ParamType::Uint(256),
            ParamType::FixedBytes(32),
        ]))),
        ParamType::Array(Box::new(ParamType::Tuple(vec![
            ParamType::Bool,
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Uint(256),
        ]))),
        ParamType::Array(Box::new(ParamType::Tuple(vec![
            ParamType::Uint(256),
            ParamType::Int(256),
            ParamType::Uint(16),
            ParamType::FixedBytes(32),
            ParamType::FixedBytes(32),
            ParamType::Bool,
        ]))),
    ])
}

fn decode_signed_proof_pulls(
    body: &crate::j_batch::ProofBody,
    delta_transformer: [u8; 20],
    kind: EntityTxKind,
) -> Result<Vec<SignedProofPull>, EntityKernelError> {
    let mut pulls = Vec::new();
    for (clause_index, clause) in body.transformers.iter().enumerate() {
        if clause.transformer_address != delta_transformer {
            continue;
        }
        let mut decoded =
            ethabi::decode(&[delta_batch_param()], &clause.encoded_batch).map_err(|error| {
                invalid(
                    kind,
                    format!("CANONICAL_DELTA_BATCH_INVALID:{clause_index}:{error}"),
                )
            })?;
        let Token::Tuple(mut batch) = decoded
            .pop()
            .ok_or_else(|| invalid(kind, "CANONICAL_DELTA_BATCH_MISSING"))?
        else {
            return Err(invalid(kind, "CANONICAL_DELTA_BATCH_TUPLE"));
        };
        if batch.len() != 3 {
            return Err(invalid(kind, "CANONICAL_DELTA_BATCH_FIELDS"));
        }
        let Token::Array(rows) = batch.remove(2) else {
            return Err(invalid(kind, "CANONICAL_DELTA_PULL_ARRAY"));
        };
        for (pull_index, row) in rows.into_iter().enumerate() {
            let Token::Tuple(mut fields) = row else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_TUPLE"));
            };
            if fields.len() != 6 {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_FIELDS"));
            }
            let Token::Bool(target_role) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_ROLE"));
            };
            let Token::FixedBytes(partial_root) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_PARTIAL_ROOT"));
            };
            let Token::FixedBytes(full_hash) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_FULL_HASH"));
            };
            let Token::Uint(claimed_ratio) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_RATIO"));
            };
            let Token::Int(amount) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_AMOUNT"));
            };
            let Token::Uint(_) = fields.pop().expect("six fields") else {
                return Err(invalid(kind, "CANONICAL_DELTA_PULL_INDEX"));
            };
            if claimed_ratio > U256::from(u16::MAX) {
                return Err(invalid(
                    kind,
                    format!("CANONICAL_DELTA_PULL_RATIO_RANGE:{clause_index}:{pull_index}"),
                ));
            }
            pulls.push(SignedProofPull {
                amount: signed_int(amount),
                claimed_ratio: claimed_ratio.as_u32() as u16,
                full_hash: full_hash
                    .try_into()
                    .map_err(|_| invalid(kind, "CANONICAL_DELTA_PULL_FULL_HASH_LENGTH"))?,
                partial_root: partial_root
                    .try_into()
                    .map_err(|_| invalid(kind, "CANONICAL_DELTA_PULL_PARTIAL_ROOT_LENGTH"))?,
                target_role,
            });
        }
    }
    Ok(pulls)
}

pub(crate) fn proof_body_has_signed_pulls(
    body: &crate::j_batch::ProofBody,
    delta_transformer: [u8; 20],
) -> Result<bool, EntityKernelError> {
    Ok(!decode_signed_proof_pulls(body, delta_transformer, EntityTxKind::DisputeStart)?.is_empty())
}

fn exact_signed_pull(
    pulls: &[SignedProofPull],
    expected: &CanonicalValue,
    target_role: bool,
    kind: EntityTxKind,
) -> Result<Option<SignedProofPull>, EntityKernelError> {
    let amount = required_bigint(expected, "signedAmount", kind)?;
    let full_hash = word(
        text(expected, "fullHash").ok_or_else(|| invalid(kind, "PULL_FULL_HASH_MISSING"))?,
        kind,
        "PULL_FULL_HASH",
    )?;
    let partial_root = word(
        text(expected, "partialRoot").ok_or_else(|| invalid(kind, "PULL_PARTIAL_ROOT_MISSING"))?,
        kind,
        "PULL_PARTIAL_ROOT",
    )?;
    let matching = pulls
        .iter()
        .filter(|pull| {
            pull.target_role == target_role
                && pull.amount == amount
                && pull.full_hash == full_hash
                && pull.partial_root == partial_root
        })
        .cloned()
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(invalid(kind, "SIGNED_PULL_AMBIGUOUS"));
    }
    Ok(matching.into_iter().next())
}

fn queue_hash_ladder_registration(
    state: &mut EntityStateSlice,
    registration: crate::j_batch::HashLadderRegistration,
    kind: EntityTxKind,
) -> Result<RegistrationQueueResult, EntityKernelError> {
    let j_state = state.j_batch_state.get_or_insert_with(Default::default);
    let matching = |value: &crate::j_batch::HashLadderRegistration| {
        value.target_role == registration.target_role
            && value.counterparty_entity == registration.counterparty_entity
            && value.full_hash == registration.full_hash
            && value.partial_root == registration.partial_root
    };
    let mut highest = None;
    for value in j_state
        .batch
        .hash_ladder_registrations
        .iter()
        .chain(
            j_state
                .sent_batch
                .iter()
                .flat_map(|sent| sent.batch.hash_ladder_registrations.iter()),
        )
        .chain(
            j_state
                .recovery_batches
                .iter()
                .flat_map(|batch| batch.hash_ladder_registrations.iter()),
        )
        .filter(|value| matching(value))
    {
        highest = Some(highest.unwrap_or(0_u16).max(value.witness.fill_ratio));
    }
    if highest == Some(registration.witness.fill_ratio) {
        return Ok(RegistrationQueueResult::AlreadyQueued);
    }
    if let Some(ratio) = highest
        && (!registration.target_role || registration.witness.fill_ratio < ratio)
    {
        return Err(invalid(
            kind,
            format!(
                "REGISTRATION_RATIO_CONFLICT:{ratio}:{}",
                registration.witness.fill_ratio
            ),
        ));
    }
    if let Some(existing) = j_state
        .batch
        .hash_ladder_registrations
        .iter_mut()
        .find(|value| matching(value))
    {
        *existing = registration;
    } else if j_state.batch.hash_ladder_registrations.len() < 32
        && crate::j_batch::batch_op_count(&j_state.batch) < 50
    {
        j_state.batch.hash_ladder_registrations.push(registration);
    } else {
        if j_state.sent_batch.is_some() && !crate::j_batch::batch_is_empty(&j_state.batch) {
            j_state.auto_broadcast_draft = true;
        }
        return Ok(RegistrationQueueResult::Deferred);
    }
    if j_state.status == crate::j_batch::JBatchStatus::Empty {
        j_state.status = crate::j_batch::JBatchStatus::Accumulating;
    }
    let broadcast_now = j_state.sent_batch.is_none();
    if !broadcast_now {
        j_state.auto_broadcast_draft = true;
    }
    Ok(RegistrationQueueResult::Queued { broadcast_now })
}

fn queue_registration_broadcast(
    state: &EntityStateSlice,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<(), EntityKernelError> {
    let local = normalized(&state.entity_id);
    if outputs.iter().any(|output| {
        output.entity_id == local
            && output.entity_txs.iter().any(|tx| {
                matches!(
                    tx,
                    LocalEntityOutputTx::Projected(tx) if tx.kind == EntityTxKind::JBroadcast
                )
            })
    }) {
        return Ok(());
    }
    outputs.push(routed(
        &local,
        None,
        vec![projected(
            EntityTxKind::JBroadcast,
            CanonicalValue::Object(Vec::new()),
        )?],
    ));
    Ok(())
}

/// Queue the Source Hub reveal committed by the exact signed Account
/// ProofBody. The Runtime seed stays transient; only the derived public
/// witness enters the canonical jBatch.
#[expect(
    clippy::too_many_arguments,
    reason = "the pure transition keeps each signed claim authority and output sink explicit"
)]
pub(crate) fn queue_source_hub_claim_registrations(
    state: &mut EntityStateSlice,
    counterparty: &str,
    runtime_seed: &str,
    body: &crate::j_batch::ProofBody,
    delta_transformer: [u8; 20],
    owner_is_left: bool,
    active_dispute: Option<&CanonicalValue>,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let kind = EntityTxKind::DisputeStart;
    let local = normalized(&state.entity_id);
    let counterparty = normalized(counterparty);
    let mut signed_pulls = None;
    let routes = state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default();
    let mut queued = 0_usize;
    for (route_id, mut route) in routes {
        if terminal_route(&route)
            || field(&route, "sourcePull").is_none()
            || nested_text(&route, "source", "counterpartyEntityId")
                .is_none_or(|value| normalized(value) != local)
            || nested_text(&route, "source", "entityId")
                .is_none_or(|value| normalized(value) != counterparty)
        {
            continue;
        }
        let (ratio, _, _) = committed_fill(&route, kind)?;
        if ratio == 0 {
            continue;
        }
        let ratio = u16::try_from(ratio).map_err(|_| invalid(kind, "SOURCE_CLAIM_RATIO"))?;
        let pull = field(&route, "sourcePull").expect("checked source pull");
        if signed_pulls.is_none() {
            signed_pulls = Some(decode_signed_proof_pulls(body, delta_transformer, kind)?);
        }
        if exact_signed_pull(
            signed_pulls.as_deref().expect("initialized signed pulls"),
            pull,
            false,
            kind,
        )?
        .is_none()
        {
            continue;
        }
        if let Some(confirmed) = unsigned(&route, "sourceRegistryFillRatio") {
            if confirmed == u64::from(ratio) {
                continue;
            }
            return Err(invalid(
                kind,
                format!("SOURCE_REGISTRY_RATIO_CONFLICT:{route_id}:{confirmed}:{ratio}"),
            ));
        }
        if let Some(active) = active_dispute
            && canonical_bool(active, "observedOnChain")
        {
            let start = unsigned(active, "disputeStartTimestamp")
                .ok_or_else(|| invalid(kind, "SOURCE_DISPUTE_START_MISSING"))?;
            let now = state.timestamp / 1_000;
            if now < start {
                return Err(invalid(
                    kind,
                    format!("SOURCE_WINDOW_NOT_OPEN:{now}:{start}"),
                ));
            }
            let window = if owner_is_left {
                u64::from(body.left_response_seconds)
            } else {
                u64::from(body.right_response_seconds)
            };
            if now > start.saturating_add(window) {
                continue;
            }
        }
        if runtime_seed.trim().is_empty() {
            return Err(invalid(kind, "RUNTIME_SEED_MISSING"));
        }
        let route_hash =
            text(&route, "routeHash").ok_or_else(|| invalid(kind, "ROUTE_HASH_MISSING"))?;
        let binary = reveal_binary(&hash_ladder_proof(runtime_seed, route_hash), ratio);
        let witness = salvage_witness(&binary, u64::from(ratio), kind)?;
        let registration = crate::j_batch::HashLadderRegistration {
            counterparty_entity: word(&counterparty, kind, "SOURCE_COUNTERPARTY")?,
            target_role: false,
            full_hash: word(
                text(pull, "fullHash").ok_or_else(|| invalid(kind, "SOURCE_PULL_FULL_HASH"))?,
                kind,
                "SOURCE_PULL_FULL_HASH",
            )?,
            partial_root: word(
                text(pull, "partialRoot")
                    .ok_or_else(|| invalid(kind, "SOURCE_PULL_PARTIAL_ROOT"))?,
                kind,
                "SOURCE_PULL_PARTIAL_ROOT",
            )?,
            witness,
        };
        match queue_hash_ladder_registration(state, registration.clone(), kind)? {
            RegistrationQueueResult::AlreadyQueued => {}
            RegistrationQueueResult::Queued { broadcast_now } => {
                remove(&mut route, "pendingSourceRegistryReveal")?;
                collection(&mut state.cross_jurisdiction_swaps).insert(route_id.clone(), route)?;
                if broadcast_now {
                    queue_registration_broadcast(state, outputs)?;
                }
                queued += 1;
            }
            RegistrationQueueResult::Deferred => {
                set(
                    &mut route,
                    "pendingSourceRegistryReveal",
                    pending_witness_value(&registration.witness, kind)?,
                )?;
                collection(&mut state.cross_jurisdiction_swaps).insert(route_id.clone(), route)?;
            }
        }
    }
    Ok(queued)
}

/// Move one Target witness from its canonical route into the writable jBatch
/// after that exact Account dispute has become active. The route remains the
/// only deferred source of truth; capacity failure restores the same field.
pub(crate) fn flush_pending_target_reveal_for_route(
    state: &mut EntityStateSlice,
    route_id: &str,
    account_counterparty: &str,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let kind = EntityTxKind::DisputeStart;
    let Some(mut route) = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(route_id))
        .cloned()
    else {
        return Err(invalid(kind, format!("CROSS_J_ROUTE_MISSING:{route_id}")));
    };
    let Some(pending) = field(&route, "pendingTargetRegistryReveal").cloned() else {
        return Ok(0);
    };
    let local = normalized(&state.entity_id);
    let counterparty = normalized(account_counterparty);
    let target_entity = nested_text(&route, "target", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "TARGET_ENTITY_MISSING"))?;
    let target_counterparty = nested_text(&route, "target", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, "TARGET_COUNTERPARTY_MISSING"))?;
    if !((target_entity == local && target_counterparty == counterparty)
        || (target_counterparty == local && target_entity == counterparty))
    {
        return Ok(0);
    }
    let pull = field(&route, "targetPull")
        .ok_or_else(|| invalid(kind, format!("TARGET_PULL_MISSING:{route_id}")))?;
    let registration = crate::j_batch::HashLadderRegistration {
        counterparty_entity: word(&counterparty, kind, "TARGET_COUNTERPARTY")?,
        target_role: true,
        full_hash: word(
            text(pull, "fullHash").ok_or_else(|| invalid(kind, "TARGET_PULL_FULL_HASH"))?,
            kind,
            "TARGET_PULL_FULL_HASH",
        )?,
        partial_root: word(
            text(pull, "partialRoot").ok_or_else(|| invalid(kind, "TARGET_PULL_PARTIAL_ROOT"))?,
            kind,
            "TARGET_PULL_PARTIAL_ROOT",
        )?,
        witness: pending_witness(&pending, kind)?,
    };
    remove(&mut route, "pendingTargetRegistryReveal")?;
    collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route.clone())?;
    match queue_hash_ladder_registration(state, registration.clone(), kind)? {
        RegistrationQueueResult::Deferred => {
            set(
                &mut route,
                "pendingTargetRegistryReveal",
                pending_witness_value(&registration.witness, kind)?,
            )?;
            collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route)?;
            Ok(0)
        }
        RegistrationQueueResult::AlreadyQueued => Ok(0),
        RegistrationQueueResult::Queued { broadcast_now } => {
            let broadcast_present = outputs.iter().any(|output| {
                output.entity_id == local
                    && output.entity_txs.iter().any(|tx| {
                        matches!(
                            tx,
                            LocalEntityOutputTx::Projected(tx)
                                if tx.kind == EntityTxKind::JBroadcast
                        )
                    })
            });
            if broadcast_now && !broadcast_present {
                outputs.push(routed(
                    &local,
                    None,
                    vec![projected(
                        EntityTxKind::JBroadcast,
                        CanonicalValue::Object(Vec::new()),
                    )?],
                ));
            }
            Ok(1)
        }
    }
}

fn route_leg_counterparty(
    state: &EntityStateSlice,
    route: &CanonicalValue,
    leg: &str,
    kind: EntityTxKind,
) -> Result<Option<String>, EntityKernelError> {
    let local = normalized(&state.entity_id);
    let entity = nested_text(route, leg, "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(kind, format!("{}_ENTITY_MISSING", leg.to_ascii_uppercase())))?;
    let counterparty = nested_text(route, leg, "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| {
            invalid(
                kind,
                format!("{}_COUNTERPARTY_MISSING", leg.to_ascii_uppercase()),
            )
        })?;
    if entity == local {
        Ok(Some(counterparty))
    } else if counterparty == local {
        Ok(Some(entity))
    } else {
        Ok(None)
    }
}

/// Exact Account point reads required only when a finalized Hanko ACK can
/// release a deferred registry witness. This is derived from canonical routes,
/// never persisted as another route/account index.
pub(crate) fn pending_registry_reveal_account_ids(
    state: &EntityStateSlice,
) -> Result<BTreeSet<String>, EntityKernelError> {
    let kind = EntityTxKind::DisputeStart;
    let mut accounts = BTreeSet::new();
    for (_, route) in state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default()
    {
        if field(&route, "pendingSourceRegistryReveal").is_some()
            && let Some(account) = route_leg_counterparty(state, &route, "source", kind)?
        {
            accounts.insert(account);
        }
        if field(&route, "pendingTargetRegistryReveal").is_some()
            && let Some(account) = route_leg_counterparty(state, &route, "target", kind)?
        {
            accounts.insert(account);
        }
    }
    Ok(accounts)
}

fn flush_pending_source_reveal_for_route(
    state: &mut EntityStateSlice,
    route_id: &str,
    account_counterparty: &str,
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let kind = EntityTxKind::DisputeStart;
    let Some(mut route) = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(route_id))
        .cloned()
    else {
        return Err(invalid(kind, format!("CROSS_J_ROUTE_MISSING:{route_id}")));
    };
    let Some(pending) = field(&route, "pendingSourceRegistryReveal").cloned() else {
        return Ok(0);
    };
    if dispute.active_dispute.is_none() {
        return Ok(0);
    }
    let Some(expected_counterparty) = route_leg_counterparty(state, &route, "source", kind)? else {
        return Ok(0);
    };
    if expected_counterparty != normalized(account_counterparty) {
        return Ok(0);
    }
    let witness = pending_witness(&pending, kind)?;
    if let Some(confirmed) = unsigned(&route, "sourceRegistryFillRatio") {
        if confirmed != u64::from(witness.fill_ratio) {
            return Err(invalid(
                kind,
                format!(
                    "SOURCE_REGISTRY_RATIO_CONFLICT:{route_id}:{confirmed}:{}",
                    witness.fill_ratio
                ),
            ));
        }
        remove(&mut route, "pendingSourceRegistryReveal")?;
        collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route)?;
        return Ok(0);
    }
    let active = dispute
        .active_dispute
        .as_ref()
        .expect("checked active dispute");
    if canonical_bool(active, "observedOnChain") {
        let start = unsigned(active, "disputeStartTimestamp")
            .ok_or_else(|| invalid(kind, "SOURCE_DISPUTE_START_MISSING"))?;
        let window = if dispute.owner_is_left {
            dispute
                .proof_body
                .as_ref()
                .map(|body| u64::from(body.left_response_seconds))
        } else {
            dispute
                .proof_body
                .as_ref()
                .map(|body| u64::from(body.right_response_seconds))
        }
        .map_err(|error| invalid(kind, error.clone()))?;
        let now = state.timestamp / 1_000;
        if now > start.saturating_add(window) {
            remove(&mut route, "pendingSourceRegistryReveal")?;
            collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route)?;
            return Ok(0);
        }
    }
    let pull = field(&route, "sourcePull")
        .ok_or_else(|| invalid(kind, format!("SOURCE_PULL_MISSING:{route_id}")))?;
    let registration = crate::j_batch::HashLadderRegistration {
        counterparty_entity: word(account_counterparty, kind, "SOURCE_COUNTERPARTY")?,
        target_role: false,
        full_hash: word(
            text(pull, "fullHash").ok_or_else(|| invalid(kind, "SOURCE_PULL_FULL_HASH"))?,
            kind,
            "SOURCE_PULL_FULL_HASH",
        )?,
        partial_root: word(
            text(pull, "partialRoot").ok_or_else(|| invalid(kind, "SOURCE_PULL_PARTIAL_ROOT"))?,
            kind,
            "SOURCE_PULL_PARTIAL_ROOT",
        )?,
        witness,
    };
    remove(&mut route, "pendingSourceRegistryReveal")?;
    collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route.clone())?;
    match queue_hash_ladder_registration(state, registration.clone(), kind)? {
        RegistrationQueueResult::Deferred => {
            set(
                &mut route,
                "pendingSourceRegistryReveal",
                pending_witness_value(&registration.witness, kind)?,
            )?;
            collection(&mut state.cross_jurisdiction_swaps).insert(route_id.to_string(), route)?;
            Ok(0)
        }
        RegistrationQueueResult::AlreadyQueued => Ok(0),
        RegistrationQueueResult::Queued { broadcast_now } => {
            if broadcast_now {
                queue_registration_broadcast(state, outputs)?;
            }
            Ok(1)
        }
    }
}

pub(crate) fn flush_deferred_hash_ladder_reveals(
    state: &mut EntityStateSlice,
    dispute_views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    if state
        .j_batch_state
        .as_ref()
        .is_some_and(|batch| batch.sent_batch.is_some())
    {
        return Ok(0);
    }
    let routes = state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default();
    let mut flushed = 0_usize;
    for (route_id, route) in routes {
        if field(&route, "pendingSourceRegistryReveal").is_some()
            && let Some(counterparty) =
                route_leg_counterparty(state, &route, "source", EntityTxKind::DisputeStart)?
            && let Some(dispute) = dispute_views.get(&counterparty)
        {
            flushed += flush_pending_source_reveal_for_route(
                state,
                &route_id,
                &counterparty,
                dispute,
                outputs,
            )?;
        }
        if field(&route, "pendingTargetRegistryReveal").is_some()
            && let Some(counterparty) =
                route_leg_counterparty(state, &route, "target", EntityTxKind::DisputeStart)?
            && dispute_views
                .get(&counterparty)
                .is_some_and(|view| view.active_dispute.is_some())
        {
            flushed +=
                flush_pending_target_reveal_for_route(state, &route_id, &counterparty, outputs)?;
        }
    }
    Ok(flushed)
}

fn apply_salvage(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let route_id = text(data, "routeId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ROUTE_ID_MISSING"))?
        .to_string();
    let binary = text(data, "binary").ok_or_else(|| invalid(tx.kind, "BINARY_MISSING"))?;
    let claimed_ratio = unsigned(data, "fillRatio")
        .filter(|value| *value > 0 && *value <= 65_535)
        .ok_or_else(|| invalid(tx.kind, "FILL_RATIO_INVALID"))?;
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(&route_id))
        .cloned()
        .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{route_id}")))?;
    let local = normalized(&state.entity_id);
    let target_user = nested_text(&route, "target", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "TARGET_USER_MISSING"))?;
    if local != target_user {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    if terminal_route(&route) {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    let target_hub = nested_text(&route, "target", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "TARGET_HUB_MISSING"))?;
    let target_pull = field(&route, "targetPull")
        .ok_or_else(|| invalid(tx.kind, format!("TARGET_PULL_MISSING:{route_id}")))?;
    let full_hash = text(target_pull, "fullHash")
        .ok_or_else(|| invalid(tx.kind, "TARGET_PULL_FULL_HASH_MISSING"))?;
    let partial_root = text(target_pull, "partialRoot")
        .ok_or_else(|| invalid(tx.kind, "TARGET_PULL_PARTIAL_ROOT_MISSING"))?;
    let verified = xln_rscore_engine::verify_hash_ladder_binary(full_hash, partial_root, binary)
        .map_err(|detail| invalid(tx.kind, detail))?;
    if verified != claimed_ratio {
        return Err(invalid(
            tx.kind,
            format!("FILL_RATIO_MISMATCH:{claimed_ratio}:{verified}"),
        ));
    }
    let witness = salvage_witness(binary, verified, tx.kind)?;
    let active_dispute = account_views
        .get(&target_hub)
        .and_then(|view| view.dispute.as_ref())
        .and_then(|view| view.active_dispute.as_ref())
        .is_some();
    if !active_dispute {
        set(
            &mut route,
            "pendingTargetRegistryReveal",
            pending_witness_value(&witness, tx.kind)?,
        )?;
        set(
            &mut route,
            "updatedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        collection(&mut state.cross_jurisdiction_swaps).insert(route_id.clone(), route)?;
        return Ok(CrossJurisdictionApplyResult {
            events: vec![EntityFrameEvent::Status {
                message: format!(
                    "⏳ Cross-j reveal port {route_id}: waiting for the target dispute clock"
                ),
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }
    let registration = crate::j_batch::HashLadderRegistration {
        counterparty_entity: word(&target_hub, tx.kind, "TARGET_COUNTERPARTY")?,
        target_role: true,
        full_hash: word(full_hash, tx.kind, "FULL_HASH")?,
        partial_root: word(partial_root, tx.kind, "PARTIAL_ROOT")?,
        witness,
    };
    remove(&mut route, "pendingTargetRegistryReveal")?;
    collection(&mut state.cross_jurisdiction_swaps).insert(route_id.clone(), route.clone())?;
    let queued = queue_hash_ladder_registration(state, registration.clone(), tx.kind)?;
    if queued == RegistrationQueueResult::Deferred {
        set(
            &mut route,
            "pendingTargetRegistryReveal",
            pending_witness_value(&registration.witness, tx.kind)?,
        )?;
        set(
            &mut route,
            "updatedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        collection(&mut state.cross_jurisdiction_swaps).insert(route_id, route)?;
        return Ok(CrossJurisdictionApplyResult::default());
    }
    if !matches!(
        queued,
        RegistrationQueueResult::Queued {
            broadcast_now: true
        }
    ) {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![routed(
            &local,
            None,
            vec![projected(
                EntityTxKind::JBroadcast,
                CanonicalValue::Object(Vec::new()),
            )?],
        )],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn cancel_ack_data(
    route: &CanonicalValue,
    order_id: &str,
    kind: EntityTxKind,
) -> Result<CanonicalValue, EntityKernelError> {
    let (ratio, source_amount, target_amount) = committed_fill(route, kind)?;
    let fill_seq = unsigned(route, "fillSeq").unwrap_or(0);
    Ok(CanonicalValue::Object(vec![
        ("offerId".into(), string(order_id)),
        (
            "routeHash".into(),
            string(text(route, "routeHash").unwrap_or("")),
        ),
        (
            "previousFillSeq".into(),
            number(fill_seq, kind, "PREVIOUS_FILL_SEQ")?,
        ),
        ("fillSeq".into(), number(fill_seq, kind, "FILL_SEQ")?),
        (
            "incrementalSourceAmount".into(),
            CanonicalValue::BigInt(BigInt::from(0)),
        ),
        (
            "incrementalTargetAmount".into(),
            CanonicalValue::BigInt(BigInt::from(0)),
        ),
        (
            "cumulativeSourceAmount".into(),
            CanonicalValue::BigInt(source_amount),
        ),
        (
            "cumulativeTargetAmount".into(),
            CanonicalValue::BigInt(target_amount),
        ),
        (
            "cumulativeFillRatio".into(),
            number(ratio, kind, "FILL_RATIO")?,
        ),
        (
            "fillNumerator".into(),
            bigint(route, "fillNumerator")
                .map(CanonicalValue::BigInt)
                .unwrap_or_else(|| CanonicalValue::BigInt(BigInt::from(0))),
        ),
        (
            "fillDenominator".into(),
            bigint(route, "fillDenominator")
                .map(CanonicalValue::BigInt)
                .unwrap_or_else(|| CanonicalValue::BigInt(BigInt::from(1))),
        ),
        ("ackKind".into(), string("cancel")),
        (
            "executionSourceAmount".into(),
            CanonicalValue::BigInt(BigInt::from(0)),
        ),
        (
            "executionTargetAmount".into(),
            CanonicalValue::BigInt(BigInt::from(0)),
        ),
        ("cancelRemainder".into(), CanonicalValue::Bool(true)),
        ("comment".into(), string("cross-j-cancel-request")),
        (
            "pairId".into(),
            string(text(route, "venueId").unwrap_or("")),
        ),
    ]))
}

fn queue_target_close(
    route: &CanonicalValue,
    binary: &str,
    proof: &CanonicalValue,
    description: String,
    kind: EntityTxKind,
) -> Result<LocalEntityOutput, EntityKernelError> {
    let target_hub = nested_text(route, "target", "entityId")
        .ok_or_else(|| invalid(kind, "TARGET_HUB_MISSING"))?;
    let target_user = nested_text(route, "target", "counterpartyEntityId")
        .ok_or_else(|| invalid(kind, "TARGET_USER_MISSING"))?;
    let target_pull =
        field(route, "targetPull").ok_or_else(|| invalid(kind, "TARGET_PULL_MISSING"))?;
    let target_pull_id = text(target_pull, "pullId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "TARGET_PULL_ID_MISSING"))?;
    routed_for_route(
        route,
        target_hub,
        vec![projected(
            EntityTxKind::CrossPullClose,
            CanonicalValue::Object(vec![
                ("counterpartyEntityId".into(), string(target_user)),
                ("pullId".into(), string(target_pull_id)),
                ("binary".into(), string(binary)),
                ("proof".into(), proof.clone()),
                ("route".into(), route.clone()),
                ("description".into(), string(description)),
            ]),
        )?],
        kind,
    )
}

fn apply_clear_request(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let order_id = text(data, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ORDER_ID_MISSING"))?
        .to_string();
    let mut route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|values| values.get(&order_id))
        .cloned()
        .or_else(|| field(data, "route").cloned())
        .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{order_id}")))?;
    let cancel_remainder = matches!(
        field(data, "cancelRemainder"),
        Some(CanonicalValue::Bool(true))
    );
    let local = normalized(&state.entity_id);
    let source_user = nested_text(&route, "source", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_USER_MISSING"))?;
    let source_hub = nested_text(&route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    let (ratio, _, _) = committed_fill(&route, tx.kind)?;
    if local != source_hub {
        if local != source_user {
            return Err(invalid(
                tx.kind,
                format!("SOURCE_PARTICIPANT_REQUIRED:{order_id}:{local}"),
            ));
        }
        let view = account_views
            .get(&source_hub)
            .ok_or_else(|| invalid(tx.kind, format!("ACCOUNT_VIEW_MISSING:{source_hub}")))?;
        if view
            .swap_offers
            .get(&order_id)
            .and_then(|offer| offer.cross_jurisdiction.as_ref())
            .is_none()
        {
            return Err(invalid(tx.kind, format!("SOURCE_OFFER_MISSING:{order_id}")));
        }
        if !cancel_remainder && ratio == 0 {
            return Ok(CrossJurisdictionApplyResult::default());
        }
        set(&mut route, "status", string("clear_requested"))?;
        set(
            &mut route,
            "pendingClearRequestedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        set(
            &mut route,
            "clearingPolicy",
            string(if cancel_remainder {
                "cancel_and_clear"
            } else {
                "manual"
            }),
        )?;
        collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route)?;
        return Ok(CrossJurisdictionApplyResult {
            proposal_work: vec![AccountProposalWork {
                account_id: source_hub,
                txs: vec![AccountTx::SwapCancelRequest { offer_id: order_id }],
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }

    let view = account_views
        .get(&source_user)
        .ok_or_else(|| invalid(tx.kind, format!("ACCOUNT_VIEW_MISSING:{source_user}")))?;
    let live_offer = view
        .swap_offers
        .get(&order_id)
        .and_then(|offer| offer.cross_jurisdiction.as_ref())
        .is_some();
    if live_offer && (cancel_remainder || ratio > 0) {
        if view.pending_cross_swap_ack_ids.contains(&order_id) {
            return Ok(CrossJurisdictionApplyResult::default());
        }
        set(&mut route, "status", string("clear_requested"))?;
        set(
            &mut route,
            "pendingClearRequestedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        set(&mut route, "clearingPolicy", string("cancel_and_clear"))?;
        let ack = cancel_ack_data(&route, &order_id, tx.kind)?;
        collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route)?;
        return Ok(CrossJurisdictionApplyResult {
            outputs: vec![LocalEntityOutput::non_mutating_wake(local)],
            proposal_work: vec![AccountProposalWork {
                account_id: source_user.clone(),
                txs: vec![AccountTx::CrossSwapFillAck { data: ack }],
            }],
            events: vec![EntityFrameEvent::Status {
                message: format!(
                    "🌉 Cross-j clear {order_id} {}",
                    if state.orderbook.is_some() {
                        "removed live book order and queued account offer close before pull reveal"
                    } else {
                        "queued account offer close before pull reveal"
                    }
                ),
            }],
            orderbook_deltas: vec![SameJOutputDelta::Remove {
                account_id: source_user,
                offer_id: order_id,
            }],
            account_envelope_mutations: Vec::new(),
        });
    }
    let source_pull_id = field(&route, "sourcePull")
        .and_then(|pull| text(pull, "pullId"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "SOURCE_PULL_ID_MISSING"))?
        .to_string();
    if ratio == 0 {
        if !cancel_remainder || !view.pulls.contains_key(&source_pull_id) {
            return Ok(CrossJurisdictionApplyResult::default());
        }
        let proof = build_close_proof(&route, "0x", tx.kind)?;
        set(&mut route, "sourceCloseProof", proof.clone())?;
        set(&mut route, "status", string("clearing"))?;
        set(
            &mut route,
            "updatedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        set(
            &mut route,
            "pendingClearRequestedAt",
            number(state.timestamp, tx.kind, "TIMESTAMP")?,
        )?;
        set(&mut route, "clearingPolicy", string("cancel_and_clear"))?;
        let target = queue_target_close(
            &route,
            "0x",
            &proof,
            format!("Cross-j {order_id} paired pure-cancel target close"),
            tx.kind,
        )?;
        collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route)?;
        return Ok(CrossJurisdictionApplyResult {
            outputs: vec![target, LocalEntityOutput::non_mutating_wake(local)],
            proposal_work: vec![AccountProposalWork {
                account_id: source_user,
                txs: vec![AccountTx::CrossPullClose {
                    data: CanonicalValue::Object(vec![
                        ("pullId".into(), string(source_pull_id)),
                        ("binary".into(), string("0x")),
                        ("proof".into(), proof),
                    ]),
                }],
            }],
            events: vec![EntityFrameEvent::Status {
                message: format!("🌉 Cross-j clear {order_id} queued atomic Hub pure-cancel close"),
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }
    if !view.pulls.contains_key(&source_pull_id)
        || view.pending_cross_pull_close_ids.contains(&source_pull_id)
    {
        return Ok(CrossJurisdictionApplyResult::default());
    }
    set(&mut route, "status", string("clear_requested"))?;
    set(
        &mut route,
        "pendingClearRequestedAt",
        number(state.timestamp, tx.kind, "TIMESTAMP")?,
    )?;
    set(
        &mut route,
        "clearingPolicy",
        string(if cancel_remainder || ratio < 65_535 {
            "cancel_and_clear"
        } else {
            "full_fill"
        }),
    )?;
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), route)?;
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![LocalEntityOutput::non_mutating_wake(local)],
        events: vec![EntityFrameEvent::Status {
            message: format!(
                "🌉 Cross-j clear {order_id} awaiting proposer reveal ratio={ratio}/65535"
            ),
        }],
        ..CrossJurisdictionApplyResult::default()
    })
}

fn extend_cross_jurisdiction_result(
    target: &mut CrossJurisdictionApplyResult,
    next: CrossJurisdictionApplyResult,
) {
    target.outputs.extend(next.outputs);
    target.proposal_work.extend(next.proposal_work);
    target.events.extend(next.events);
    target.orderbook_deltas.extend(next.orderbook_deltas);
    target
        .account_envelope_mutations
        .extend(next.account_envelope_mutations);
}

fn apply_orderbook_sweep(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    authority: &EntityFrameAuthority,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let local = normalized(&state.entity_id);
    let routes = state
        .cross_jurisdiction_swaps
        .as_ref()
        .map(EntityCanonicalCollection::text_entries)
        .transpose()?
        .unwrap_or_default();
    let mut combined = CrossJurisdictionApplyResult::default();
    let mut expired_routes = 0_u64;
    let mut closed_offers = 0_u64;
    let mut waiting_routes = 0_u64;
    for (order_id, route) in routes {
        if terminal_route(&route) {
            continue;
        }
        if !route_runtime_expired(&route, state.timestamp) {
            waiting_routes += 1;
            continue;
        }
        expired_routes += 1;
        let source_hub = nested_text(&route, "source", "counterpartyEntityId")
            .map(normalized)
            .ok_or_else(|| {
                invalid(
                    EntityTxKind::OrderbookSweepCrossJurisdiction,
                    format!("SOURCE_HUB_MISSING:{order_id}"),
                )
            })?;
        if source_hub != local {
            waiting_routes += 1;
            continue;
        }
        validate_local_route_binding(
            state,
            &route,
            authority,
            EntityTxKind::OrderbookSweepCrossJurisdiction,
        )?;
        let clear = projected(
            EntityTxKind::RequestCrossJurisdictionClear,
            CanonicalValue::Object(vec![
                ("orderId".into(), string(order_id)),
                ("cancelRemainder".into(), CanonicalValue::Bool(true)),
            ]),
        )?;
        let cleared = apply_clear_request(state, account_views, &clear)?;
        if cleared.proposal_work.iter().any(|work| {
            work.txs
                .iter()
                .any(|tx| matches!(tx, AccountTx::CrossSwapFillAck { .. }))
        }) {
            closed_offers += 1;
        }
        extend_cross_jurisdiction_result(&mut combined, cleared);
    }
    let reason = tx
        .frame_data()
        .and_then(|data| text(data, "reason"))
        .filter(|reason| !reason.is_empty());
    let suffix = reason.map_or_else(String::new, |reason| format!(": {reason}"));
    combined.events.push(EntityFrameEvent::Status {
        message: format!(
            "🌉 Cross-j orderbook sweep{suffix} expired={expired_routes} closedOffers={closed_offers} waiting={waiting_routes}"
        ),
    });
    Ok(combined)
}

fn exact_fill(
    value: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<(BigInt, BigInt, u64), EntityKernelError> {
    let numerator = bigint(value, "fillNumerator")
        .ok_or_else(|| invalid(kind, "EXACT_FILL_NUMERATOR_MISSING"))?;
    let denominator = bigint(value, "fillDenominator")
        .ok_or_else(|| invalid(kind, "EXACT_FILL_DENOMINATOR_MISSING"))?;
    if numerator.sign() == Sign::Minus || denominator <= BigInt::from(0) || numerator > denominator
    {
        return Err(invalid(
            kind,
            format!("EXACT_FILL_RATIO_INVALID:{numerator}:{denominator}"),
        ));
    }
    let ratio_big = if numerator == BigInt::from(0) {
        BigInt::from(0)
    } else if numerator >= denominator {
        BigInt::from(65_535_u32)
    } else {
        (&numerator * BigInt::from(65_535_u32) + &denominator - BigInt::from(1)) / &denominator
    };
    let ratio = u64::try_from(ratio_big).map_err(|_| invalid(kind, "EXACT_FILL_RATIO_U16"))?;
    if let Some(coarse) = unsigned(value, "cumulativeFillRatio")
        && coarse.min(65_535) != ratio
    {
        return Err(invalid(
            kind,
            format!("COARSE_EXACT_RATIO_MISMATCH:{coarse}:{ratio}"),
        ));
    }
    Ok((numerator, denominator, ratio))
}

fn scaled_amount(total: &BigInt, numerator: &BigInt, denominator: &BigInt) -> BigInt {
    if numerator >= denominator {
        total.clone()
    } else {
        total * numerator / denominator
    }
}

fn gcd(mut left: BigInt, mut right: BigInt) -> BigInt {
    while right != BigInt::from(0) {
        let next = &left % &right;
        left = right;
        right = next;
    }
    left
}

pub(crate) fn build_cross_jurisdiction_book_fill(
    account_id: String,
    offer_id: String,
    route: CanonicalValue,
    execution_source_amount: BigInt,
    execution_target_amount: BigInt,
    price_ticks: BigInt,
    pair_id: String,
) -> Result<CrossJurisdictionBookFill, EntityKernelError> {
    let kind = EntityTxKind::CrossJurisdictionFillNotice;
    if execution_source_amount <= BigInt::from(0) || execution_target_amount <= BigInt::from(0) {
        return Err(invalid(kind, "CROSS_J_FILL_EXECUTION_NON_POSITIVE"));
    }
    let market = cross_jurisdiction_market(&route)?;
    if &market.filled_source + &execution_source_amount > market.source_total
        || &market.filled_target + &execution_target_amount > market.target_total
    {
        return Err(invalid(kind, "CROSS_J_FILL_EXECUTION_OVERFLOW"));
    }
    let mut numerator = &market.filled_target + &execution_target_amount;
    let mut denominator = market.target_total.clone();
    let divisor = gcd(numerator.clone(), denominator.clone());
    numerator /= &divisor;
    denominator /= divisor;
    let cumulative_source = scaled_amount(&market.source_total, &numerator, &denominator);
    let cumulative_target = scaled_amount(&market.target_total, &numerator, &denominator);
    let settlement_source = &cumulative_source - &market.filled_source;
    let settlement_target = &cumulative_target - &market.filled_target;
    if settlement_target != execution_target_amount || settlement_source < execution_source_amount {
        return Err(invalid(kind, "CROSS_J_FILL_SETTLEMENT_DIVERGED"));
    }
    let ratio_big = if numerator >= denominator {
        BigInt::from(65_535_u32)
    } else {
        (&numerator * BigInt::from(65_535_u32) + &denominator - BigInt::from(1)) / &denominator
    };
    let fill_ratio =
        u64::try_from(ratio_big).map_err(|_| invalid(kind, "CROSS_J_FILL_RATIO_U16"))?;
    if fill_ratio <= market.previous_fill_ratio {
        return Err(invalid(kind, "CROSS_J_FILL_RATIO_NOT_ADVANCED"));
    }
    let price_improvement = &settlement_source - &execution_source_amount;
    let fill_seq = unsigned(&route, "fillSeq").unwrap_or(0).saturating_add(1);
    let mut fields = vec![
        ("offerId".into(), string(&offer_id)),
        (
            "previousFillSeq".into(),
            CanonicalValue::Number(
                CanonicalNumber::try_from_u64(fill_seq - 1)
                    .map_err(|_| invalid(kind, "PREVIOUS_FILL_SEQ_UNSAFE"))?,
            ),
        ),
        (
            "fillSeq".into(),
            CanonicalValue::Number(
                CanonicalNumber::try_from_u64(fill_seq)
                    .map_err(|_| invalid(kind, "FILL_SEQ_UNSAFE"))?,
            ),
        ),
        (
            "incrementalSourceAmount".into(),
            CanonicalValue::BigInt(settlement_source.clone()),
        ),
        (
            "incrementalTargetAmount".into(),
            CanonicalValue::BigInt(settlement_target.clone()),
        ),
        (
            "cumulativeSourceAmount".into(),
            CanonicalValue::BigInt(cumulative_source.clone()),
        ),
        (
            "cumulativeTargetAmount".into(),
            CanonicalValue::BigInt(cumulative_target.clone()),
        ),
        (
            "cumulativeFillRatio".into(),
            CanonicalValue::Number(
                CanonicalNumber::try_from_u64(fill_ratio)
                    .map_err(|_| invalid(kind, "FILL_RATIO_UNSAFE"))?,
            ),
        ),
        ("fillNumerator".into(), CanonicalValue::BigInt(numerator)),
        (
            "fillDenominator".into(),
            CanonicalValue::BigInt(denominator),
        ),
        ("ackKind".into(), string("fill")),
        (
            "executionSourceAmount".into(),
            CanonicalValue::BigInt(execution_source_amount),
        ),
        (
            "executionTargetAmount".into(),
            CanonicalValue::BigInt(execution_target_amount),
        ),
        ("priceImprovementMode".into(), string("source_savings")),
    ];
    if price_improvement > BigInt::from(0) {
        fields.push((
            "priceImprovementAmount".into(),
            CanonicalValue::BigInt(price_improvement),
        ));
        fields.push((
            "priceImprovementTokenId".into(),
            CanonicalValue::Number(
                CanonicalNumber::try_from_u64(u64::from(required_u32(
                    field(&route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?,
                    "tokenId",
                    kind,
                )?))
                .map_err(|_| invalid(kind, "PRICE_IMPROVEMENT_TOKEN_UNSAFE"))?,
            ),
        ));
    }
    let terminal = fill_ratio >= 65_535 || cumulative_target >= market.target_total;
    fields.extend([
        ("cancelRemainder".into(), CanonicalValue::Bool(terminal)),
        (
            "comment".into(),
            string(format!("cross-j-hashledger-fill:{fill_ratio}")),
        ),
        ("priceTicks".into(), CanonicalValue::BigInt(price_ticks)),
        ("pairId".into(), string(&pair_id)),
    ]);
    if let Some(route_hash) = text(&route, "routeHash") {
        fields.push(("routeHash".into(), string(route_hash)));
    }
    Ok(CrossJurisdictionBookFill {
        account_id,
        offer_id,
        route,
        ack_data: CanonicalValue::Object(fields),
    })
}

fn committed_fill(
    route: &CanonicalValue,
    kind: EntityTxKind,
) -> Result<(u64, BigInt, BigInt), EntityKernelError> {
    let has_numerator = field(route, "fillNumerator").is_some();
    let has_denominator = field(route, "fillDenominator").is_some();
    if !has_numerator && !has_denominator {
        if unsigned(route, "cumulativeFillRatio").unwrap_or(0) > 0 {
            return Err(invalid(kind, "EXACT_FILL_RATIO_REQUIRED"));
        }
        return Ok((0, BigInt::from(0), BigInt::from(0)));
    }
    let (numerator, denominator, ratio) = exact_fill(route, kind)?;
    let source = field(route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_amount = required_bigint(source, "amount", kind)?;
    let target_amount = required_bigint(target, "amount", kind)?;
    let filled_source = scaled_amount(&source_amount, &numerator, &denominator);
    let filled_target = scaled_amount(&target_amount, &numerator, &denominator);
    for (name, expected) in [
        ("filledSourceAmount", &filled_source),
        ("sourceClaimed", &filled_source),
        ("filledTargetAmount", &filled_target),
        ("targetClaimed", &filled_target),
    ] {
        if let Some(actual) = bigint(route, name)
            && &actual != expected
        {
            return Err(invalid(
                kind,
                format!("COMMITTED_AMOUNT_MISMATCH:{name}:{actual}:{expected}"),
            ));
        }
    }
    Ok((ratio, filled_source, filled_target))
}

fn ten_pow(decimals: u32) -> BigInt {
    BigInt::from(10_u8).pow(decimals)
}

pub(crate) fn cross_jurisdiction_market(
    route: &CanonicalValue,
) -> Result<CrossJurisdictionMarket, EntityKernelError> {
    let kind = EntityTxKind::AdmitCrossJurisdictionBookOrder;
    let canonical = canonical_route(route, kind)?;
    let (_, pair_id) = canonical_book_and_venue(&canonical, kind)?;
    let source = field(&canonical, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(&canonical, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let source_j =
        text(source, "jurisdiction").ok_or_else(|| invalid(kind, "SOURCE_JURISDICTION"))?;
    let target_j =
        text(target, "jurisdiction").ok_or_else(|| invalid(kind, "TARGET_JURISDICTION"))?;
    let source_stack = parse_stack(source_j, kind)?;
    let target_stack = parse_stack(target_j, kind)?;
    let source_key = format!("stack:{}:{}:{source_token}", source_stack.0, source_stack.1);
    let target_key = format!("stack:{}:{}:{target_token}", target_stack.0, target_stack.1);
    let source_liquid = crate::is_canonical_liquid_token(source_token);
    let target_liquid = crate::is_canonical_liquid_token(target_token);
    let source_is_base = if source_liquid != target_liquid {
        !source_liquid
    } else {
        source_key <= target_key
    };
    let source_total = required_bigint(source, "amount", kind)?;
    let target_total = required_bigint(target, "amount", kind)?;
    let (previous_fill_ratio, filled_source, filled_target) = committed_fill(&canonical, kind)?;
    let source_remaining = &source_total - &filled_source;
    let target_remaining = &target_total - &filled_target;
    if source_remaining <= BigInt::from(0) || target_remaining <= BigInt::from(0) {
        return Err(invalid(kind, "CROSS_J_ROUTE_REMAINDER_EMPTY"));
    }
    let (side, base_token_id, quote_token_id, base_amount, quote_amount) = if source_is_base {
        (
            Side::Ask,
            source_token,
            target_token,
            source_remaining,
            target_remaining,
        )
    } else {
        (
            Side::Bid,
            target_token,
            source_token,
            target_remaining,
            source_remaining,
        )
    };
    let dimensions = PairDimensions {
        base_token_decimals: crate::canonical_token_decimals(base_token_id)
            .ok_or_else(|| invalid(kind, "BASE_TOKEN_METADATA_MISSING"))?,
        quote_token_decimals: crate::canonical_token_decimals(quote_token_id)
            .ok_or_else(|| invalid(kind, "QUOTE_TOKEN_METADATA_MISSING"))?,
    };
    let (policy, _) = crate::canonical_pair_policy(base_token_id, quote_token_id, dimensions);
    let step = BigInt::from(policy.price_step_ticks.max(1));
    let numerator =
        &quote_amount * ten_pow(dimensions.base_token_decimals) * BigInt::from(10_000_u32);
    let denominator = &base_amount * ten_pow(dimensions.quote_token_decimals);
    let mut price_ticks = &numerator / &denominator;
    if side == Side::Ask {
        if &numerator % &denominator != BigInt::from(0) {
            price_ticks += 1;
        }
        price_ticks = (&price_ticks + &step - BigInt::from(1)) / &step * &step;
    } else {
        price_ticks = &price_ticks / &step * &step;
    }
    if price_ticks <= BigInt::from(0) {
        return Err(invalid(kind, "CROSS_J_PRICE_INVALID"));
    }
    Ok(CrossJurisdictionMarket {
        book_owner: route_book_owner(&canonical),
        source_asset_key: source_key,
        target_asset_key: target_key,
        pair_id,
        side,
        dimensions,
        base_token_id,
        quote_token_id,
        base_amount,
        quote_amount,
        price_ticks,
        maker_id: text(&canonical, "makerEntityId")
            .map(normalized)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(kind, "MAKER_ENTITY_MISSING"))?,
        source_total,
        target_total,
        filled_source,
        filled_target,
        previous_fill_ratio,
    })
}

pub(crate) fn cross_jurisdiction_working_offer(
    route: &CanonicalValue,
) -> Result<(String, SameJOffer), EntityKernelError> {
    let kind = EntityTxKind::AdmitCrossJurisdictionBookOrder;
    let market = cross_jurisdiction_market(route)?;
    let source = field(route, "source").ok_or_else(|| invalid(kind, "SOURCE_MISSING"))?;
    let target = field(route, "target").ok_or_else(|| invalid(kind, "TARGET_MISSING"))?;
    let source_entity = text(source, "entityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "SOURCE_ENTITY_MISSING"))?;
    let source_hub = text(source, "counterpartyEntityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(kind, "SOURCE_HUB_MISSING"))?;
    let source_token = required_u32(source, "tokenId", kind)?;
    let target_token = required_u32(target, "tokenId", kind)?;
    let offer_id = route_order_id(kind, route)?.to_string();
    let give_amount = &market.source_total - &market.filled_source;
    let want_amount = &market.target_total - &market.filled_target;
    Ok((
        source_entity.clone(),
        SameJOffer {
            offer_id,
            left_entity: source_entity,
            right_entity: source_hub,
            give_token_id: source_token,
            give_token_decimals: crate::canonical_token_decimals(source_token)
                .ok_or_else(|| invalid(kind, "GIVE_TOKEN_METADATA_MISSING"))?,
            give_amount: give_amount.clone(),
            want_token_id: target_token,
            want_token_decimals: crate::canonical_token_decimals(target_token)
                .ok_or_else(|| invalid(kind, "WANT_TOKEN_METADATA_MISSING"))?,
            want_amount: want_amount.clone(),
            max_fee: BigInt::from(0),
            min_net_receive: want_amount,
            price_ticks: market.price_ticks,
            time_in_force: Some(0),
            maker_is_left: true,
            created_height: 0,
            quantized_give: give_amount,
            quantized_want: market.target_total - market.filled_target,
            cross_jurisdiction: Some(route.clone()),
        },
    ))
}

fn canonical_bool(value: &CanonicalValue, name: &str) -> bool {
    matches!(field(value, name), Some(CanonicalValue::Bool(true)))
}

/// A fill notice never mutates the Entity route. The Account ACK/progress is
/// the canonical financial transition; its later committed Account output is
/// what advances the Entity mirror and the book-owner projection.
fn apply_fill_notice(
    state: &EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let order_id = text(data, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ORDER_ID_MISSING"))?;
    let route = state
        .cross_jurisdiction_swaps
        .as_ref()
        .and_then(|routes| routes.get(order_id))
        .ok_or_else(|| invalid(tx.kind, format!("ROUTE_MISSING:{order_id}")))?;
    if let (Some(actual), Some(expected)) = (text(data, "routeHash"), text(route, "routeHash"))
        && normalized(actual) != normalized(expected)
    {
        return Err(invalid(
            tx.kind,
            format!("ROUTE_HASH_MISMATCH:{actual}:{expected}"),
        ));
    }
    if let Some(mode) = text(data, "priceImprovementMode")
        && mode != "source_savings"
    {
        return Err(invalid(tx.kind, format!("PRICE_IMPROVEMENT_MODE:{mode}")));
    }
    let local = normalized(&state.entity_id);
    let source_hub = nested_text(route, "source", "counterpartyEntityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
    let target_hub = nested_text(route, "target", "entityId")
        .map(normalized)
        .ok_or_else(|| invalid(tx.kind, "TARGET_HUB_MISSING"))?;
    let (peer, source_role) = if local == source_hub {
        (
            nested_text(route, "source", "entityId")
                .map(normalized)
                .ok_or_else(|| invalid(tx.kind, "SOURCE_USER_MISSING"))?,
            true,
        )
    } else if local == target_hub {
        (
            nested_text(route, "target", "counterpartyEntityId")
                .map(normalized)
                .ok_or_else(|| invalid(tx.kind, "TARGET_USER_MISSING"))?,
            false,
        )
    } else {
        return Err(invalid(tx.kind, format!("HUB_REQUIRED:{order_id}:{local}")));
    };
    if !state.known_accounts.contains(&peer) {
        return Err(invalid(
            tx.kind,
            format!("ACCOUNT_MISSING:{order_id}:{peer}"),
        ));
    }
    if !matches!(text(route, "status"), Some("resting" | "partially_filled")) {
        return Err(invalid(
            tx.kind,
            format!(
                "STATUS_INVALID:{order_id}:{}",
                text(route, "status").unwrap_or("")
            ),
        ));
    }
    let target_pull_id = field(route, "targetPull")
        .and_then(|pull| text(pull, "pullId"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "TARGET_PULL_MISSING"))?;

    let current_seq = unsigned(route, "fillSeq").unwrap_or(0);
    let incoming_seq =
        unsigned(data, "fillSeq").ok_or_else(|| invalid(tx.kind, "FILL_SEQ_MISSING"))?;
    let cancel = canonical_bool(data, "cancelRemainder");
    let (prior_ratio, prior_source, prior_target) = committed_fill(route, tx.kind)?;
    let same_committed = || -> Result<bool, EntityKernelError> {
        let (numerator, denominator, ratio) = exact_fill(data, tx.kind)?;
        let source = field(route, "source").ok_or_else(|| invalid(tx.kind, "SOURCE_MISSING"))?;
        let target = field(route, "target").ok_or_else(|| invalid(tx.kind, "TARGET_MISSING"))?;
        Ok(ratio == prior_ratio
            && scaled_amount(
                &required_bigint(source, "amount", tx.kind)?,
                &numerator,
                &denominator,
            ) == prior_source
            && scaled_amount(
                &required_bigint(target, "amount", tx.kind)?,
                &numerator,
                &denominator,
            ) == prior_target
            && bigint(data, "cumulativeSourceAmount") == Some(prior_source.clone())
            && bigint(data, "cumulativeTargetAmount") == Some(prior_target.clone()))
    };
    if incoming_seq <= current_seq && !cancel {
        if incoming_seq == current_seq && !same_committed()? {
            return Err(invalid(tx.kind, "STALE_CONFLICT"));
        }
        return Ok(CrossJurisdictionApplyResult {
            events: vec![EntityFrameEvent::Status {
                message: format!("🌉 Cross-j fill notice {order_id} duplicate seq {incoming_seq}"),
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }

    let same_seq_cancel = cancel && incoming_seq == current_seq;
    let ack_data = if same_seq_cancel {
        if !same_committed()?
            || bigint(data, "incrementalSourceAmount") != Some(BigInt::from(0))
            || bigint(data, "incrementalTargetAmount") != Some(BigInt::from(0))
        {
            return Err(invalid(tx.kind, "CANCEL_PROGRESS_MISMATCH"));
        }
        let mut fields = vec![
            ("offerId".into(), string(order_id)),
            (
                "previousFillSeq".into(),
                number(current_seq, tx.kind, "PREVIOUS_FILL_SEQ")?,
            ),
            ("fillSeq".into(), number(current_seq, tx.kind, "FILL_SEQ")?),
            (
                "incrementalSourceAmount".into(),
                CanonicalValue::BigInt(BigInt::from(0)),
            ),
            (
                "incrementalTargetAmount".into(),
                CanonicalValue::BigInt(BigInt::from(0)),
            ),
            (
                "cumulativeSourceAmount".into(),
                CanonicalValue::BigInt(prior_source),
            ),
            (
                "cumulativeTargetAmount".into(),
                CanonicalValue::BigInt(prior_target),
            ),
            (
                "cumulativeFillRatio".into(),
                number(prior_ratio, tx.kind, "FILL_RATIO")?,
            ),
        ];
        for name in ["fillNumerator", "fillDenominator"] {
            fields.push((
                name.into(),
                field(data, name).expect("exact ratio validated").clone(),
            ));
        }
        fields.extend([
            ("ackKind".into(), string("cancel")),
            (
                "executionSourceAmount".into(),
                CanonicalValue::BigInt(BigInt::from(0)),
            ),
            (
                "executionTargetAmount".into(),
                CanonicalValue::BigInt(BigInt::from(0)),
            ),
            ("cancelRemainder".into(), CanonicalValue::Bool(true)),
        ]);
        if let Some(pair_id) = field(data, "pairId") {
            fields.push(("pairId".into(), pair_id.clone()));
        }
        fields.push(("comment".into(), string("cross-j-cancel-request")));
        if let Some(route_hash) = text(route, "routeHash") {
            fields.push(("routeHash".into(), string(route_hash)));
        }
        CanonicalValue::Object(fields)
    } else {
        if incoming_seq != current_seq.saturating_add(1) {
            return Err(invalid(
                tx.kind,
                format!("FILL_SEQ:{current_seq}:{incoming_seq}"),
            ));
        }
        if let Some(previous) = unsigned(data, "previousFillSeq")
            && previous != current_seq
        {
            return Err(invalid(
                tx.kind,
                format!("PREVIOUS_FILL_SEQ:{previous}:{current_seq}"),
            ));
        }
        let (numerator, denominator, next_ratio) = exact_fill(data, tx.kind)?;
        if next_ratio <= prior_ratio {
            return Err(invalid(
                tx.kind,
                format!("NON_MONOTONIC_RATIO:{prior_ratio}:{next_ratio}"),
            ));
        }
        let source = field(route, "source").ok_or_else(|| invalid(tx.kind, "SOURCE_MISSING"))?;
        let target = field(route, "target").ok_or_else(|| invalid(tx.kind, "TARGET_MISSING"))?;
        let cumulative_source = scaled_amount(
            &required_bigint(source, "amount", tx.kind)?,
            &numerator,
            &denominator,
        );
        let cumulative_target = scaled_amount(
            &required_bigint(target, "amount", tx.kind)?,
            &numerator,
            &denominator,
        );
        let incremental_source = &cumulative_source - &prior_source;
        let incremental_target = &cumulative_target - &prior_target;
        if incremental_source <= BigInt::from(0) || incremental_target <= BigInt::from(0) {
            return Err(invalid(tx.kind, "NO_INCREMENTAL_AMOUNT"));
        }
        for (name, expected) in [
            ("incrementalSourceAmount", &incremental_source),
            ("incrementalTargetAmount", &incremental_target),
            ("cumulativeSourceAmount", &cumulative_source),
            ("cumulativeTargetAmount", &cumulative_target),
        ] {
            if bigint(data, name).as_ref() != Some(expected) {
                return Err(invalid(tx.kind, format!("AMOUNT_MISMATCH:{name}")));
            }
        }
        let improvement = bigint(data, "priceImprovementAmount").unwrap_or_default();
        if improvement.sign() == Sign::Minus || improvement > incremental_source {
            return Err(invalid(tx.kind, "PRICE_IMPROVEMENT_AMOUNT"));
        }
        let execution_source = &incremental_source - &improvement;
        let terminal = cancel || next_ratio >= 65_535;
        let mut fields = vec![
            ("offerId".into(), string(order_id)),
            (
                "previousFillSeq".into(),
                number(current_seq, tx.kind, "PREVIOUS_FILL_SEQ")?,
            ),
            ("fillSeq".into(), number(incoming_seq, tx.kind, "FILL_SEQ")?),
            (
                "incrementalSourceAmount".into(),
                CanonicalValue::BigInt(incremental_source),
            ),
            (
                "incrementalTargetAmount".into(),
                CanonicalValue::BigInt(incremental_target.clone()),
            ),
            (
                "cumulativeSourceAmount".into(),
                CanonicalValue::BigInt(cumulative_source),
            ),
            (
                "cumulativeTargetAmount".into(),
                CanonicalValue::BigInt(cumulative_target),
            ),
            (
                "cumulativeFillRatio".into(),
                number(next_ratio, tx.kind, "FILL_RATIO")?,
            ),
            ("fillNumerator".into(), CanonicalValue::BigInt(numerator)),
            (
                "fillDenominator".into(),
                CanonicalValue::BigInt(denominator),
            ),
            ("ackKind".into(), string("fill")),
            (
                "executionSourceAmount".into(),
                CanonicalValue::BigInt(execution_source),
            ),
            (
                "executionTargetAmount".into(),
                CanonicalValue::BigInt(incremental_target),
            ),
            ("cancelRemainder".into(), CanonicalValue::Bool(terminal)),
        ];
        if let Some(pair_id) = field(data, "pairId") {
            fields.push(("pairId".into(), pair_id.clone()));
        }
        fields.push((
            "comment".into(),
            string(format!("cross-j-hashledger-fill:{next_ratio}")),
        ));
        if let Some(route_hash) = text(route, "routeHash") {
            fields.push(("routeHash".into(), string(route_hash)));
        }
        for name in [
            "priceImprovementMode",
            "priceImprovementAmount",
            "priceImprovementTokenId",
            "priceTicks",
        ] {
            if let Some(value) = field(data, name) {
                fields.push((name.into(), value.clone()));
            }
        }
        CanonicalValue::Object(fields)
    };

    let queued_ratio = unsigned(&ack_data, "cumulativeFillRatio")
        .ok_or_else(|| invalid(tx.kind, "FILL_RATIO_MISSING"))?;
    let tx = if source_role {
        AccountTx::CrossSwapFillAck { data: ack_data }
    } else {
        AccountTx::CrossPullProgress {
            data: CanonicalValue::Object(vec![
                ("pullId".into(), string(target_pull_id)),
                ("fill".into(), ack_data),
            ]),
        }
    };
    Ok(CrossJurisdictionApplyResult {
        outputs: vec![LocalEntityOutput::non_mutating_wake(local)],
        proposal_work: vec![AccountProposalWork {
            account_id: peer,
            txs: vec![tx],
        }],
        events: vec![EntityFrameEvent::Status {
            message: format!(
                "🌉 Cross-j {} progress {order_id} queued {queued_ratio}/65535",
                if source_role { "source" } else { "target" }
            ),
        }],
        orderbook_deltas: Vec::new(),
        account_envelope_mutations: Vec::new(),
    })
}

fn apply_progress(
    state: &mut EntityStateSlice,
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let data = tx
        .frame_data()
        .ok_or_else(|| invalid(tx.kind, "DATA_MISSING"))?;
    let order_id = text(data, "orderId")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "ORDER_ID_MISSING"))?
        .to_string();
    let source_entity = text(data, "sourceEntityId")
        .map(normalized)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(tx.kind, "SOURCE_ENTITY_MISSING"))?;
    let reason = text(data, "reason").filter(|reason| !reason.is_empty());
    let suffix = reason.map_or_else(String::new, |reason| format!(": {reason}"));
    let progress_message = format!("🌉 Cross-j book progress {order_id}{suffix}");
    let admission_key = format!("{source_entity}:{order_id}");
    let mut admission = state
        .cross_jurisdiction_book_admissions
        .as_ref()
        .and_then(|values| values.get(&admission_key))
        .cloned()
        .ok_or_else(|| {
            invalid(
                tx.kind,
                format!("ADMISSION_MISSING:{order_id}:{source_entity}"),
            )
        })?;
    let status = text(&admission, "status").unwrap_or("");
    let cancel_pending = status == "resolving" && field(&admission, "pendingCancel").is_some();
    if status != "admitted" && !cancel_pending {
        return Err(invalid(
            tx.kind,
            format!("ADMISSION_NOT_ADMITTED:{order_id}:{status}"),
        ));
    }
    let admitted_route = field(&admission, "route")
        .cloned()
        .ok_or_else(|| invalid(tx.kind, format!("ADMISSION_ROUTE_MISSING:{order_id}")))?;
    collection(&mut state.cross_jurisdiction_swaps).insert(order_id.clone(), admitted_route)?;
    let (route, terminal) = committed::apply_fill(state, data, "cross_j_book_progress")?;
    set(&mut admission, "route", route.clone())?;
    remove(&mut admission, "pendingFill")?;
    set(
        &mut admission,
        "updatedAt",
        CanonicalValue::Number(
            CanonicalNumber::try_from_u64(state.timestamp)
                .map_err(|_| invalid(tx.kind, "TIMESTAMP_UNSAFE"))?,
        ),
    )?;
    if cancel_pending {
        let source_hub = nested_text(&route, "source", "counterpartyEntityId")
            .map(normalized)
            .ok_or_else(|| invalid(tx.kind, "SOURCE_HUB_MISSING"))?;
        if normalized(&state.entity_id) != source_hub {
            set(&mut admission, "status", string("closed"))?;
            set(
                &mut admission,
                "closedAt",
                CanonicalValue::Number(
                    CanonicalNumber::try_from_u64(state.timestamp)
                        .map_err(|_| invalid(tx.kind, "TIMESTAMP_UNSAFE"))?,
                ),
            )?;
            let reason = field(&admission, "pendingCancel")
                .and_then(|pending| text(pending, "reason"))
                .unwrap_or("cancel_request_after_fill")
                .to_string();
            set(&mut admission, "closeReason", string(reason))?;
        }
        collection(&mut state.cross_jurisdiction_book_admissions)
            .insert(admission_key, admission)?;
        return Ok(CrossJurisdictionApplyResult {
            events: vec![EntityFrameEvent::Status {
                message: progress_message,
            }],
            ..CrossJurisdictionApplyResult::default()
        });
    }
    collection(&mut state.cross_jurisdiction_book_admissions).insert(admission_key, admission)?;
    let orderbook_deltas = if terminal {
        vec![SameJOutputDelta::Remove {
            account_id: source_entity,
            offer_id: order_id,
        }]
    } else {
        let (account_id, offer) = cross_jurisdiction_working_offer(&route)?;
        vec![SameJOutputDelta::Upsert {
            account_id,
            offer: Box::new(offer),
        }]
    };
    Ok(CrossJurisdictionApplyResult {
        orderbook_deltas,
        events: vec![EntityFrameEvent::Status {
            message: progress_message,
        }],
        ..Default::default()
    })
}

/// Apply one ordered list of cross-j Entity transactions. Each accepted input
/// mutates the one radix-owned state and appends outputs in input order.
pub fn apply_cross_jurisdiction_entity_txs(
    state: &mut EntityStateSlice,
    account_views: &std::collections::BTreeMap<
        String,
        crate::local_financial::LocalAccountFinancialView,
    >,
    txs: &[CanonicalEntityTx],
    admitted_signer_id: Option<&str>,
    authority: &EntityFrameAuthority,
) -> Result<CrossJurisdictionApplyResult, EntityKernelError> {
    let mut combined = CrossJurisdictionApplyResult::default();
    for tx in txs {
        if tx.kind != EntityTxKind::OrderbookSweepCrossJurisdiction {
            let semantic = semantic_route(state, tx)?;
            validate_local_route_binding(state, semantic, authority, tx.kind)?;
        }
        validate_materialize_proposer(tx, admitted_signer_id, authority)?;
        let result = match tx.kind {
            EntityTxKind::AdmitCrossJurisdictionBookOrder => apply_admit(state, tx)?,
            EntityTxKind::PrepareCrossJurisdictionSwap => apply_prepare(state, tx)?,
            EntityTxKind::MaterializeCrossJurisdictionSwap => apply_materialize_swap(state, tx)?,
            EntityTxKind::MaterializeCrossJurisdictionClear => {
                apply_materialize_clear(state, account_views, tx)?
            }
            EntityTxKind::RegisterCrossJurisdictionSwap => apply_register(state, tx)?,
            EntityTxKind::CrossPullClose => apply_cross_pull_close(state, tx)?,
            EntityTxKind::CrossJurisdictionSalvage => apply_salvage(state, account_views, tx)?,
            EntityTxKind::RequestCrossJurisdictionClear => {
                apply_clear_request(state, account_views, tx)?
            }
            EntityTxKind::OrderbookSweepCrossJurisdiction => {
                apply_orderbook_sweep(state, account_views, authority, tx)?
            }
            EntityTxKind::CrossJurisdictionFillNotice => apply_fill_notice(state, tx)?,
            EntityTxKind::ApplyCrossJurisdictionBookProgress => apply_progress(state, tx)?,
            EntityTxKind::RemoveCrossJurisdictionBookOrder => apply_remove_book_order(state, tx)?,
            EntityTxKind::CrossJurisdictionBookOrderRemoved => {
                apply_book_order_removed(state, account_views, tx)?
            }
            other => return Err(invalid(other, "HANDLER_NOT_IMPLEMENTED")),
        };
        extend_cross_jurisdiction_result(&mut combined, result);
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_account_ids_read_nothing_without_committed_routes() {
        let state = EntityStateSlice::empty("source-hub", 1);
        assert_eq!(
            cross_j_opening_account_ids(&state).expect("empty projection"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn opening_account_ids_ignore_unmaterialized_intent_without_pulls() {
        let mut state = EntityStateSlice::empty("source-hub", 1);
        collection(&mut state.cross_jurisdiction_swaps)
            .insert("order-1".into(), route("intent", false))
            .expect("intent");
        assert_eq!(
            cross_j_opening_account_ids(&state).expect("unmaterialized intent projection"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn pull_detection_ignores_absent_and_custom_transformers_but_rejects_malformed_canonical() {
        let canonical = [0x11; 20];
        let bare = crate::j_batch::ProofBody {
            watch_seed: [0; 32],
            left_response_seconds: 1,
            right_response_seconds: 1,
            offdeltas: Vec::new(),
            token_ids: Vec::new(),
            transformers: Vec::new(),
        };
        assert!(!proof_body_has_signed_pulls(&bare, canonical).expect("pull-free proof"));

        let mut custom_only = bare.clone();
        custom_only
            .transformers
            .push(crate::j_batch::TransformerClause {
                transformer_address: [0x22; 20],
                encoded_batch: vec![0xff],
                allowances: Vec::new(),
            });
        assert!(
            !proof_body_has_signed_pulls(&custom_only, canonical)
                .expect("opaque custom transformer")
        );

        let mut malformed_canonical = bare;
        malformed_canonical
            .transformers
            .push(crate::j_batch::TransformerClause {
                transformer_address: canonical,
                encoded_batch: vec![0xff],
                allowances: Vec::new(),
            });
        let error = proof_body_has_signed_pulls(&malformed_canonical, canonical)
            .expect_err("malformed canonical transformer must fail");
        assert!(error.to_string().contains("CANONICAL_DELTA_BATCH_INVALID"));
    }

    fn obj(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn string(value: &str) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn route(status: &str, pulls: bool) -> CanonicalValue {
        let mut route = obj(vec![
            ("orderId", string("order-1")),
            ("makerEntityId", string("source-user")),
            ("hubEntityId", string("source-hub")),
            (
                "source",
                obj(vec![
                    (
                        "jurisdiction",
                        string("stack:1:0x1111111111111111111111111111111111111111"),
                    ),
                    ("entityId", string("source-user")),
                    ("counterpartyEntityId", string("source-hub")),
                    (
                        "tokenId",
                        number(2, EntityTxKind::PrepareCrossJurisdictionSwap, "TOKEN").unwrap(),
                    ),
                    (
                        "amount",
                        CanonicalValue::BigInt(BigInt::from(1_000_000_000_000_000_000_u64)),
                    ),
                ]),
            ),
            (
                "target",
                obj(vec![
                    (
                        "jurisdiction",
                        string("stack:2:0x2222222222222222222222222222222222222222"),
                    ),
                    ("entityId", string("target-hub")),
                    ("counterpartyEntityId", string("target-user")),
                    (
                        "tokenId",
                        number(1, EntityTxKind::PrepareCrossJurisdictionSwap, "TOKEN").unwrap(),
                    ),
                    (
                        "amount",
                        CanonicalValue::BigInt(BigInt::from(2_000_000_u64)),
                    ),
                ]),
            ),
            (
                "sourceDisputeConfig",
                obj(vec![
                    (
                        "leftResponseSeconds",
                        number(3_600, EntityTxKind::PrepareCrossJurisdictionSwap, "CLOCK").unwrap(),
                    ),
                    (
                        "rightResponseSeconds",
                        number(86_400, EntityTxKind::PrepareCrossJurisdictionSwap, "CLOCK")
                            .unwrap(),
                    ),
                ]),
            ),
            (
                "targetDisputeConfig",
                obj(vec![
                    (
                        "leftResponseSeconds",
                        number(3_600, EntityTxKind::PrepareCrossJurisdictionSwap, "CLOCK").unwrap(),
                    ),
                    (
                        "rightResponseSeconds",
                        number(86_400, EntityTxKind::PrepareCrossJurisdictionSwap, "CLOCK")
                            .unwrap(),
                    ),
                ]),
            ),
            ("status", string(status)),
            (
                "createdAt",
                number(1_000, EntityTxKind::PrepareCrossJurisdictionSwap, "TIME").unwrap(),
            ),
            (
                "updatedAt",
                number(1_000, EntityTxKind::PrepareCrossJurisdictionSwap, "TIME").unwrap(),
            ),
            (
                "expiresAt",
                number(61_000, EntityTxKind::PrepareCrossJurisdictionSwap, "TIME").unwrap(),
            ),
            ("sourceSignerId", string("source-user-signer")),
            ("sourceHubSignerId", string("source-hub-signer")),
            ("targetHubSignerId", string("target-hub-signer")),
            ("targetSignerId", string("target-user-signer")),
        ]);
        if pulls {
            set(
                &mut route,
                "sourcePull",
                obj(vec![("pullId", string("source-pull"))]),
            )
            .expect("source pull");
            set(
                &mut route,
                "targetPull",
                obj(vec![("pullId", string("target-pull"))]),
            )
            .expect("target pull");
        }
        route
    }

    fn tx(kind: EntityTxKind, route: CanonicalValue) -> CanonicalEntityTx {
        let mut data = vec![("route", route)];
        if kind == EntityTxKind::MaterializeCrossJurisdictionSwap {
            data.insert(0, ("proposerSignerId", string("source-hub-signer")));
        }
        CanonicalEntityTx::from_frame_projection(kind, obj(data)).expect("canonical tx")
    }

    fn authority(signer: &str, chain_id: u64, depository: &str) -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: crate::EntityConsensusConfig {
                mode: crate::ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec![signer.into()],
                shares: std::collections::BTreeMap::from([(signer.into(), 1)]),
                jurisdiction: Some(obj(vec![
                    (
                        "chainId",
                        number(
                            chain_id,
                            EntityTxKind::PrepareCrossJurisdictionSwap,
                            "CHAIN",
                        )
                        .unwrap(),
                    ),
                    ("depositoryAddress", string(depository)),
                    (
                        "entityProviderAddress",
                        string("0x3333333333333333333333333333333333333333"),
                    ),
                ])),
            },
            leader_state: crate::EntityLeaderState {
                active_validator_id: signer.into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    #[test]
    fn source_user_authorization_is_radix_owned_and_routes_prepare() {
        let mut state = EntityStateSlice::empty("source-user", 1);
        let result = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            Some("source-user-signer"),
            &authority(
                "source-user-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect("prepare");
        assert!(
            state
                .cross_jurisdiction_authorizations
                .as_ref()
                .and_then(|values| values.get("order-1"))
                .is_some()
        );
        assert_eq!(result.outputs.len(), 1);
        assert_eq!(result.outputs[0].entity_id, "source-hub");
        assert!(matches!(
            result.outputs[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(projected)]
                if projected.kind == EntityTxKind::PrepareCrossJurisdictionSwap
        ));
    }

    #[test]
    fn force_sibling_dispute_targets_local_leg_and_rejects_observed_local_leg() {
        let mut state = EntityStateSlice::empty("source-user", 1);
        collection(&mut state.cross_jurisdiction_swaps)
            .insert("order-1".into(), route("resting", true))
            .expect("route");
        assert_eq!(
            force_sibling_dispute_counterparty(&state, "order-1", "target-user")
                .expect("sibling counterparty"),
            "source-hub"
        );
        let error = force_sibling_dispute_counterparty(&state, "order-1", "source-hub")
            .expect_err("observed local leg must fail");
        assert!(error.to_string().contains("OBSERVED_LEG_INVALID"));
    }

    #[test]
    fn source_cross_pull_close_uses_proof_order_for_point_lookup_and_queues_one_account_tx() {
        let mut stored = canonical_route(
            &route("clear_requested", true),
            EntityTxKind::CrossPullClose,
        )
        .expect("canonical route");
        let proof =
            build_close_proof(&stored, "0x", EntityTxKind::CrossPullClose).expect("close proof");
        let mut state = EntityStateSlice::empty("source-hub", 2_000);
        state.known_accounts.insert("source-user".into());
        state.cross_jurisdiction_swaps = Some(
            EntityCanonicalCollection::from_entries([("order-1".into(), stored.clone())])
                .expect("routes"),
        );
        let close = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::CrossPullClose,
            obj(vec![
                ("counterpartyEntityId", string("source-user")),
                ("pullId", string("source-pull")),
                ("binary", string("0x")),
                ("proof", proof.clone()),
                ("route", stored.clone()),
            ]),
        )
        .expect("close tx");
        let result = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[close],
            Some("source-hub-signer"),
            &authority(
                "source-hub-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect("source close");
        assert!(matches!(
            result.proposal_work.as_slice(),
            [AccountProposalWork { account_id, txs }]
                if account_id == "source-user"
                    && matches!(txs.as_slice(), [AccountTx::CrossPullClose { .. }])
        ));
        stored = state
            .cross_jurisdiction_swaps
            .as_ref()
            .and_then(|routes| routes.get("order-1"))
            .cloned()
            .expect("updated route");
        assert_eq!(field(&stored, "sourceCloseProof"), Some(&proof));
    }

    #[test]
    fn route_hash_matches_typescript_abi_vector_and_materializes_defaults() {
        let canonical = canonical_route(
            &route("intent", false),
            EntityTxKind::PrepareCrossJurisdictionSwap,
        )
        .expect("canonical route");
        assert_eq!(
            text(&canonical, "routeHash"),
            Some("0x166c6b1459d2972fb90464386f629afca89b7e55c4b4404feb50f6b34af5eaa9")
        );
        assert_eq!(text(&canonical, "bookOwnerEntityId"), Some("source-hub"));
        assert_eq!(
            text(&canonical, "venueId"),
            Some(
                "cross:stack:1:0x1111111111111111111111111111111111111111:2/stack:2:0x2222222222222222222222222222222222222222:1"
            )
        );
    }

    fn half_fill_data(id_field: &str) -> CanonicalValue {
        obj(vec![
            (id_field, string("order-1")),
            ("sourceEntityId", string("source-user")),
            (
                "fillSeq",
                number(1, EntityTxKind::ApplyCrossJurisdictionBookProgress, "SEQ").expect("seq"),
            ),
            (
                "cumulativeFillRatio",
                number(
                    32_768,
                    EntityTxKind::ApplyCrossJurisdictionBookProgress,
                    "RATIO",
                )
                .expect("ratio"),
            ),
            ("fillNumerator", CanonicalValue::BigInt(BigInt::from(1))),
            ("fillDenominator", CanonicalValue::BigInt(BigInt::from(2))),
            (
                "incrementalSourceAmount",
                CanonicalValue::BigInt(BigInt::from(500_000_000_000_000_000_u64)),
            ),
            (
                "incrementalTargetAmount",
                CanonicalValue::BigInt(BigInt::from(1_000_000_u64)),
            ),
            (
                "cumulativeSourceAmount",
                CanonicalValue::BigInt(BigInt::from(500_000_000_000_000_000_u64)),
            ),
            (
                "cumulativeTargetAmount",
                CanonicalValue::BigInt(BigInt::from(1_000_000_u64)),
            ),
        ])
    }

    fn admitted_source_book() -> EntityStateSlice {
        let canonical = canonical_route(
            &route("resting", true),
            EntityTxKind::AdmitCrossJurisdictionBookOrder,
        )
        .expect("canonical route");
        let mut state = EntityStateSlice::empty("source-hub", 2_000);
        apply_admit(
            &mut state,
            &tx(EntityTxKind::AdmitCrossJurisdictionBookOrder, canonical),
        )
        .expect("admit source book");
        state
    }

    #[test]
    fn routed_book_progress_updates_the_admission_route_and_orderbook_once() {
        let mut state = admitted_source_book();
        let progress = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::ApplyCrossJurisdictionBookProgress,
            half_fill_data("orderId"),
        )
        .expect("progress tx");
        let result = apply_progress(&mut state, &progress).expect("book progress");
        assert!(matches!(
            result.orderbook_deltas.as_slice(),
            [SameJOutputDelta::Upsert { account_id, offer }]
                if account_id == "source-user"
                    && offer.offer_id == "order-1"
                    && offer.give_amount == BigInt::from(500_000_000_000_000_000_u64)
                    && offer.want_amount == BigInt::from(1_000_000_u64)
        ));
        let admission = state
            .cross_jurisdiction_book_admissions
            .as_ref()
            .and_then(|values| values.get("source-user:order-1"))
            .expect("admission");
        let admitted_route = field(admission, "route").expect("admission route");
        assert_eq!(unsigned(admitted_route, "fillSeq"), Some(1));
        assert_eq!(
            bigint(admitted_route, "filledSourceAmount"),
            Some(BigInt::from(500_000_000_000_000_000_u64))
        );
    }

    #[test]
    fn committed_fill_ack_uses_the_same_book_progress_transition() {
        let mut state = admitted_source_book();
        let applied = committed::apply_committed_account_tx_followup(
            &mut state,
            "source-user",
            2_000,
            &AccountTx::CrossSwapFillAck {
                data: half_fill_data("offerId"),
            },
        )
        .expect("committed fill ack")
        .expect("cross-j followup");
        assert!(matches!(
            applied.orderbook_deltas.as_slice(),
            [SameJOutputDelta::Upsert { account_id, offer }]
                if account_id == "source-user" && offer.offer_id == "order-1"
        ));
        let admission = state
            .cross_jurisdiction_book_admissions
            .as_ref()
            .and_then(|values| values.get("source-user:order-1"))
            .expect("admission");
        assert_eq!(
            field(admission, "route").and_then(|route| unsigned(route, "fillSeq")),
            Some(1)
        );
    }

    #[test]
    fn dispute_remote_book_removal_uses_one_canonical_ack_route() {
        let mut route = route("resting", true);
        set(&mut route, "bookOwnerEntityId", string("target-hub")).expect("book owner");
        let canonical =
            canonical_route(&route, EntityTxKind::AdmitCrossJurisdictionBookOrder).expect("route");
        let mut owner = EntityStateSlice::empty("target-hub", 2_000);
        apply_admit(
            &mut owner,
            &tx(
                EntityTxKind::AdmitCrossJurisdictionBookOrder,
                canonical.clone(),
            ),
        )
        .expect("admit");
        let removal = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::RemoveCrossJurisdictionBookOrder,
            obj(vec![
                ("orderId", string("order-1")),
                ("sourceEntityId", string("source-user")),
                ("sourceAccountId", string("target-user")),
                ("route", canonical),
                ("reason", string("account_dispute_prepare")),
            ]),
        )
        .expect("removal");
        let result = apply_remove_book_order(&mut owner, &removal).expect("remove");
        assert_eq!(result.outputs.len(), 1);
        assert_eq!(result.outputs[0].entity_id, "source-hub");
        assert!(matches!(
            result.outputs[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(projected)]
                if projected.kind == EntityTxKind::CrossJurisdictionBookOrderRemoved
        ));
        assert!(matches!(
            result.orderbook_deltas.as_slice(),
            [SameJOutputDelta::Remove { account_id, offer_id }]
                if account_id == "source-user" && offer_id == "order-1"
        ));
    }

    #[test]
    fn dispute_book_removal_ack_becomes_one_typed_account_envelope_update() {
        let mut route = route("resting", true);
        set(&mut route, "bookOwnerEntityId", string("target-hub")).expect("book owner");
        let canonical = canonical_route(&route, EntityTxKind::CrossJurisdictionBookOrderRemoved)
            .expect("route");
        let mut source_hub = EntityStateSlice::empty("source-hub", 2_000);
        source_hub.cross_jurisdiction_swaps = Some(
            EntityCanonicalCollection::from_entries([("order-1".into(), canonical.clone())])
                .expect("routes"),
        );
        let ack = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::CrossJurisdictionBookOrderRemoved,
            obj(vec![
                ("orderId", string("order-1")),
                ("sourceEntityId", string("source-user")),
                ("sourceAccountId", string("target-user")),
                ("route", canonical),
                (
                    "removedAt",
                    number(
                        2_000,
                        EntityTxKind::CrossJurisdictionBookOrderRemoved,
                        "TIME",
                    )
                    .unwrap(),
                ),
                ("reason", string("account_dispute_prepare")),
            ]),
        )
        .expect("ack");
        // TS confirms the removal only for an Account whose dispute
        // preparation still waits on this exact orderbook removal.
        let views = BTreeMap::from([(
            "target-user".to_string(),
            crate::local_financial::LocalAccountFinancialView {
                active: false,
                owner_side: xln_rscore_engine::Side::Left,
                owner_out_capacity: BTreeMap::new(),
                owner_peer_credit_limit: BTreeMap::new(),
                settlement_workspace: None,
                settlement_transition_pending: false,
                settlement_execution: Err("unused".into()),
                rebalance_active_quote: None,
                htlc_locks: BTreeMap::new(),
                pulls: BTreeMap::new(),
                swap_offers: BTreeMap::new(),
                pending_cross_pull_close_ids: Default::default(),
                pending_cross_swap_ack_ids: Default::default(),
                dispute: Some(xln_rscore_batch::ResidentAccountDisputeView {
                    status: "dispute_preparing".into(),
                    dispute_prepare: Some(obj(vec![(
                        "pendingOrderbookRemovalIds",
                        CanonicalValue::Array(vec![string("order-1")]),
                    )])),
                    active_dispute: None,
                    local_dispute: None,
                    counterparty_dispute: None,
                    proof_body: Err("unused".into()),
                    j_nonce: 0,
                    owner_is_left: true,
                    delta_transformer: None,
                    payment_hashlocks: Vec::new(),
                    pull_ids: Vec::new(),
                    pull_count: 0,
                    swap_offers: Vec::new(),
                    pending_swap_fill_ratios: BTreeMap::new(),
                }),
            },
        )]);
        let unrelated = apply_book_order_removed(&mut source_hub, &BTreeMap::new(), &ack)
            .expect("apply ack without dispute");
        assert!(unrelated.account_envelope_mutations.is_empty());
        let result = apply_book_order_removed(&mut source_hub, &views, &ack).expect("apply ack");
        assert!(matches!(
            result.account_envelope_mutations.as_slice(),
            [(account, crate::AccountEnvelopeMutation::ConfirmDisputeBookRemoval { order_id })]
                if account == "target-user" && order_id == "order-1"
        ));
    }

    #[test]
    fn materialization_routes_one_register_to_each_hub_in_source_target_order() {
        let mut state = EntityStateSlice::empty("source-hub", 1);
        apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            Some("source-hub-signer"),
            &authority(
                "source-hub-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect("intent");
        let prepared = canonical_route(
            &route("intent", true),
            EntityTxKind::MaterializeCrossJurisdictionSwap,
        )
        .expect("prepared route");
        let result = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(EntityTxKind::MaterializeCrossJurisdictionSwap, prepared)],
            Some("source-hub-signer"),
            &authority(
                "source-hub-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect("materialize");
        assert_eq!(
            result
                .outputs
                .iter()
                .map(|output| output.entity_id.as_str())
                .collect::<Vec<_>>(),
            ["source-hub", "target-hub"]
        );
        assert_eq!(
            result
                .outputs
                .iter()
                .map(|output| output.target_signer_id.as_deref())
                .collect::<Vec<_>>(),
            [Some("source-hub-signer"), Some("target-hub-signer")]
        );
        assert!(result.outputs.iter().all(|output| matches!(
            output.entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(projected)]
                if projected.kind == EntityTxKind::RegisterCrossJurisdictionSwap
        )));
    }

    #[test]
    fn default_proposer_materialization_matches_typescript_hash_ladder_vector() {
        let authority = authority(
            "source-hub-signer",
            1,
            "0x1111111111111111111111111111111111111111",
        );
        let mut state = EntityStateSlice::empty("source-hub", 1_000);
        let route = canonical_route(
            &route("intent", false),
            EntityTxKind::PrepareCrossJurisdictionSwap,
        )
        .expect("canonical intent");
        state.cross_jurisdiction_swaps = Some(
            EntityCanonicalCollection::from_entries([("order-1".into(), route)]).expect("routes"),
        );
        let materialized = build_proposer_materializations(
            &state,
            "runtime-seed",
            "source-hub-signer",
            &authority,
            &std::collections::BTreeMap::new(),
            &std::collections::BTreeSet::new(),
            false,
        )
        .expect("materialization");
        assert_eq!(materialized.len(), 1);
        let route = materialized[0]
            .frame_data()
            .and_then(|data| field(data, "route"))
            .expect("prepared route");
        let source_pull = field(route, "sourcePull").expect("source pull");
        let target_pull = field(route, "targetPull").expect("target pull");
        assert_eq!(
            text(source_pull, "pullId"),
            Some("0xe7e1766f78adf8fbcc2d52396d7245e205fbdec0bdc70e884f15487771c8f897")
        );
        assert_eq!(
            text(target_pull, "pullId"),
            Some("0xd3d3858eae161b38724b54d5dc850b290f81773d8c00d36e3765892e78020bc6")
        );
        for pull in [source_pull, target_pull] {
            assert_eq!(
                text(pull, "fullHash"),
                Some("0xb2f8ec09dccf5c668c6584704f74d259b576b315cfeee4a15d3471e6c3e0ca25")
            );
            assert_eq!(
                text(pull, "partialRoot"),
                Some("0x6f3eda4369d749c3e6df77f2330a78c831a701130a262ab266400cc2987cdeca")
            );
        }
    }

    #[test]
    fn source_claim_registration_uses_exact_signed_pull_and_runtime_seed() {
        let source_user = format!("0x{}", "11".repeat(32));
        let source_hub = format!("0x{}", "22".repeat(32));
        let target_hub = format!("0x{}", "33".repeat(32));
        let target_user = format!("0x{}", "44".repeat(32));
        let mut raw = route("intent", false);
        let mut source = field(&raw, "source").cloned().expect("source");
        set(&mut source, "entityId", string(&source_user)).expect("source user");
        set(&mut source, "counterpartyEntityId", string(&source_hub)).expect("source hub");
        set(&mut raw, "source", source).expect("source leg");
        let mut target = field(&raw, "target").cloned().expect("target");
        set(&mut target, "entityId", string(&target_hub)).expect("target hub");
        set(&mut target, "counterpartyEntityId", string(&target_user)).expect("target user");
        set(&mut raw, "target", target).expect("target leg");
        set(&mut raw, "makerEntityId", string(&source_user)).expect("maker");
        set(&mut raw, "hubEntityId", string(&source_hub)).expect("hub");
        let canonical = canonical_route(&raw, EntityTxKind::PrepareCrossJurisdictionSwap)
            .expect("canonical route");
        let mut prepared =
            prepared_route(&canonical, "runtime-seed", 1_000).expect("prepared route");
        set(
            &mut prepared,
            "fillNumerator",
            CanonicalValue::BigInt(BigInt::from(1)),
        )
        .expect("fill numerator");
        set(
            &mut prepared,
            "fillDenominator",
            CanonicalValue::BigInt(BigInt::from(2)),
        )
        .expect("fill denominator");
        let source_pull = field(&prepared, "sourcePull").expect("source pull");
        let signed_amount =
            required_bigint(source_pull, "signedAmount", EntityTxKind::DisputeStart)
                .expect("signed amount");
        let full_hash = word(
            text(source_pull, "fullHash").expect("full hash"),
            EntityTxKind::DisputeStart,
            "FULL_HASH",
        )
        .expect("full hash word");
        let partial_root = word(
            text(source_pull, "partialRoot").expect("partial root"),
            EntityTxKind::DisputeStart,
            "PARTIAL_ROOT",
        )
        .expect("partial root word");
        let transformer = [0x55_u8; 20];
        let encoded_batch = ethabi::encode(&[Token::Tuple(vec![
            Token::Array(Vec::new()),
            Token::Array(Vec::new()),
            Token::Array(vec![Token::Tuple(vec![
                Token::Uint(U256::from(0)),
                Token::Int(
                    signed_u256(&signed_amount, EntityTxKind::DisputeStart, "AMOUNT")
                        .expect("signed amount"),
                ),
                Token::Uint(U256::from(0)),
                Token::FixedBytes(full_hash.to_vec()),
                Token::FixedBytes(partial_root.to_vec()),
                Token::Bool(false),
            ])]),
        ])]);
        let body = crate::j_batch::ProofBody {
            watch_seed: [0; 32],
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: Vec::new(),
            token_ids: Vec::new(),
            transformers: vec![crate::j_batch::TransformerClause {
                transformer_address: transformer,
                encoded_batch,
                allowances: Vec::new(),
            }],
        };
        let mut state = EntityStateSlice::empty(source_hub.clone(), 1_000);
        state.cross_jurisdiction_swaps = Some(
            EntityCanonicalCollection::from_entries([("order-1".into(), prepared)])
                .expect("routes"),
        );
        let mut outputs = Vec::new();
        let queued = queue_source_hub_claim_registrations(
            &mut state,
            &source_user,
            "runtime-seed",
            &body,
            transformer,
            true,
            None,
            &mut outputs,
        )
        .expect("source registration");
        assert_eq!(queued, 1);
        let registrations = &state
            .j_batch_state
            .as_ref()
            .expect("jBatch")
            .batch
            .hash_ladder_registrations;
        assert!(matches!(registrations.as_slice(), [registration]
            if !registration.target_role
                && registration.counterparty_entity == [0x11; 32]
                && registration.witness.fill_ratio == 32_768));
        assert_eq!(outputs.len(), 1);
    }

    #[test]
    fn runtime_output_binds_source_signer_and_semantic_edge_before_apply() {
        let state = EntityStateSlice::empty("source-hub", 1);
        let prepare = tx(
            EntityTxKind::PrepareCrossJurisdictionSwap,
            route("intent", false),
        );
        authorize_runtime_output(
            &state,
            &CrossJurisdictionRuntimeOutput {
                source_entity_id: "source-user".into(),
                source_signer_id: "source-user-signer".into(),
                target_entity_id: "source-hub".into(),
                entity_txs: vec![prepare.clone()],
            },
            &authority(
                "source-hub-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect("authorized source-user -> source-hub edge");
        let error = authorize_runtime_output(
            &state,
            &CrossJurisdictionRuntimeOutput {
                source_entity_id: "source-user".into(),
                source_signer_id: "attacker".into(),
                target_entity_id: "source-hub".into(),
                entity_txs: vec![prepare],
            },
            &authority(
                "source-hub-signer",
                1,
                "0x1111111111111111111111111111111111111111",
            ),
        )
        .expect_err("wrong route signer must fail");
        assert!(
            error
                .to_string()
                .contains("RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH")
        );
    }

    #[test]
    fn self_runtime_continuations_require_current_board_and_route_authority() {
        let mut state = EntityStateSlice::empty("source-hub", 1);
        state.cross_jurisdiction_swaps = Some(
            EntityCanonicalCollection::from_entries([(
                "order-1".into(),
                route("clear_requested", true),
            )])
            .expect("routes"),
        );
        let current = authority(
            "source-hub-signer",
            1,
            "0x1111111111111111111111111111111111111111",
        );
        let output = |source_signer_id: &str, entity_txs: Vec<CanonicalEntityTx>| {
            CrossJurisdictionRuntimeOutput {
                source_entity_id: "source-hub".into(),
                source_signer_id: source_signer_id.into(),
                target_entity_id: "source-hub".into(),
                entity_txs,
            }
        };
        let projected = |kind, data| {
            CanonicalEntityTx::from_frame_projection(kind, data).expect("canonical tx")
        };

        authorize_runtime_output(
            &state,
            &output(
                "source-hub-signer",
                vec![projected(EntityTxKind::JBroadcast, obj(vec![]))],
            ),
            &current,
        )
        .expect("current validator may run the committed self continuation");
        authorize_runtime_output(
            &state,
            &output(
                "source-hub-signer",
                vec![projected(
                    EntityTxKind::RequestCrossJurisdictionClear,
                    obj(vec![
                        ("orderId", string("order-1")),
                        ("cancelRemainder", CanonicalValue::Bool(true)),
                    ]),
                )],
            ),
            &current,
        )
        .expect("route signer may continue its own clear");

        let attacker = authorize_runtime_output(
            &state,
            &output(
                "attacker",
                vec![projected(EntityTxKind::JBroadcast, obj(vec![]))],
            ),
            &current,
        )
        .expect_err("non-validator self continuation must fail");
        assert!(
            attacker
                .to_string()
                .contains("RUNTIME_OUTPUT_SOURCE_SIGNER_MISMATCH")
        );

        let arbitrary = authorize_runtime_output(
            &state,
            &output(
                "source-hub-signer",
                vec![projected(EntityTxKind::SetHubConfig, obj(vec![]))],
            ),
            &current,
        )
        .expect_err("ordinary self command must fail");
        assert!(
            arbitrary
                .to_string()
                .contains("RUNTIME_OUTPUT_SELF_FORBIDDEN")
        );
    }

    #[test]
    fn route_local_signer_and_stack_are_bound_to_committed_authority() {
        let mut state = EntityStateSlice::empty("source-user", 1);
        let error = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            Some("attacker"),
            &authority("attacker", 1, "0x1111111111111111111111111111111111111111"),
        )
        .expect_err("route signer is not committed validator");
        assert!(
            error
                .to_string()
                .contains("LOCAL_ROUTE_SIGNER_NOT_VALIDATOR")
        );
        assert!(state.cross_jurisdiction_authorizations.is_none());

        let error = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            Some("source-user-signer"),
            &authority(
                "source-user-signer",
                2,
                "0x2222222222222222222222222222222222222222",
            ),
        )
        .expect_err("route stack is not local committed stack");
        assert!(error.to_string().contains("LOCAL_JURISDICTION_MISMATCH"));
        assert!(state.cross_jurisdiction_authorizations.is_none());
    }

    #[test]
    fn materialization_requires_default_proposer_payload_and_admission_signer() {
        let authority = authority(
            "source-hub-signer",
            1,
            "0x1111111111111111111111111111111111111111",
        );
        let mut state = EntityStateSlice::empty("source-hub", 1);
        apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::PrepareCrossJurisdictionSwap,
                route("intent", false),
            )],
            Some("source-hub-signer"),
            &authority,
        )
        .expect("intent");
        let before = state.clone();
        let prepared = canonical_route(
            &route("intent", true),
            EntityTxKind::MaterializeCrossJurisdictionSwap,
        )
        .expect("prepared route");
        let error = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[tx(
                EntityTxKind::MaterializeCrossJurisdictionSwap,
                prepared.clone(),
            )],
            Some("attacker"),
            &authority,
        )
        .expect_err("admission signer mismatch");
        assert!(error.to_string().contains("MATERIALIZE_PROPOSER_INVALID"));
        assert_eq!(state, before);

        let claimed_attacker = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::MaterializeCrossJurisdictionSwap,
            obj(vec![
                ("proposerSignerId", string("attacker")),
                ("route", prepared),
            ]),
        )
        .expect("materialize projection");
        let error = apply_cross_jurisdiction_entity_txs(
            &mut state,
            &std::collections::BTreeMap::new(),
            &[claimed_attacker],
            Some("source-hub-signer"),
            &authority,
        )
        .expect_err("payload proposer mismatch");
        assert!(error.to_string().contains("MATERIALIZE_PROPOSER_INVALID"));
        assert_eq!(state, before);
    }
}
