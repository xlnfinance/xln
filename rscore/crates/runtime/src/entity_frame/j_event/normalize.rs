//! Field decoders mirroring `event-normalization-primitives.ts`.

use num_bigint::BigInt;
use serde_json::{Map, Number, Value};

use super::super::EntityFrameError;

const SAFE_INT_ABS: u64 = 9_007_199_254_740_991;
const UINT256_MAX: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

pub(super) fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub(super) fn normalize_entity(value: &Value) -> Option<String> {
    let entity_id = value.as_str()?.trim().to_ascii_lowercase();
    if entity_id.is_empty() {
        None
    } else {
        Some(entity_id)
    }
}

pub(super) fn normalize_address(value: &Value) -> Option<String> {
    let address = value.as_str()?.trim().to_ascii_lowercase();
    hex_len(&address, 40).then_some(address)
}

pub(super) fn normalize_bytes32(value: &Value) -> Option<String> {
    let bytes = value.as_str()?.trim().to_ascii_lowercase();
    hex_len(&bytes, 64).then_some(bytes)
}

pub(super) fn normalize_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

pub(super) fn normalize_big_numberish(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => integer_number(number).map(|n| n.to_string()),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            let inner = text
                .strip_prefix("BigInt(")
                .and_then(|rest| rest.strip_suffix(')'))
                .filter(|inner| is_signed_digits(inner))
                .unwrap_or(text);
            if !is_signed_digits(inner) {
                return None;
            }
            inner.parse::<BigInt>().ok().map(|n| n.to_string())
        }
        _ => None,
    }
}

pub(super) fn normalize_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => integer_number(number),
        _ => {
            let integer = normalize_big_numberish(value)?;
            let parsed = integer.parse::<i64>().ok()?;
            (parsed.unsigned_abs() <= SAFE_INT_ABS).then_some(parsed)
        }
    }
}

pub(super) fn is_positive_uint256(value: &str) -> bool {
    let Ok(n) = value.parse::<BigInt>() else {
        return false;
    };
    let max = UINT256_MAX.parse::<BigInt>().expect("uint256 max");
    n >= BigInt::from(1) && n <= max
}

pub(super) fn is_action_kind(value: i64) -> bool {
    value == 0 || value == 1
}

pub(super) fn string_value(text: String) -> Value {
    Value::String(text)
}

pub(super) fn int_value(value: i64) -> Value {
    Value::Number(Number::from(value))
}

pub(super) fn metadata(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut metadata = Map::new();
    if let Some(value) = raw.get("blockNumber").and_then(normalize_int) {
        metadata.insert("blockNumber".into(), int_value(value));
    }
    if let Some(Value::String(text)) = raw.get("blockHash")
        && !text.trim().is_empty()
    {
        metadata.insert("blockHash".into(), Value::String(text.clone()));
    }
    if let Some(Value::String(text)) = raw.get("transactionHash")
        && !text.trim().is_empty()
    {
        metadata.insert("transactionHash".into(), Value::String(text.clone()));
    }
    if let Some(value) = raw.get("logIndex").and_then(normalize_int)
        && value >= 0
    {
        metadata.insert("logIndex".into(), int_value(value));
    }
    if let Some(value) = raw.get("eventIndex").and_then(normalize_int)
        && value >= 0
    {
        metadata.insert("eventIndex".into(), int_value(value));
    }
    metadata
}

pub(super) fn invalid(index: usize) -> EntityFrameError {
    EntityFrameError::Value(format!("JURISDICTION_EVENT_INVALID:{index}"))
}

fn hex_len(value: &str, len: usize) -> bool {
    value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == len && payload.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn is_signed_digits(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn integer_number(number: &Number) -> Option<i64> {
    number
        .as_i64()
        .filter(|value| value.unsigned_abs() <= SAFE_INT_ABS)
        .or_else(|| {
            number
                .as_u64()
                .filter(|value| *value <= SAFE_INT_ABS)
                .and_then(|value| i64::try_from(value).ok())
        })
}
