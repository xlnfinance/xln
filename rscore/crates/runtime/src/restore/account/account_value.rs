//! Strict readers for the persisted `RestoreExact` positional ABI.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use num_bigint::BigInt;
use serde_json::Value;
use thiserror::Error;
use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_engine::{EntityId, TokenId};

const JS_MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Error)]
pub enum AccountWireRestoreError {
    #[error("RRS_RESTORE_ACCOUNT_WIRE:{0}")]
    Invalid(String),
}

pub fn invalid(detail: impl Into<String>) -> AccountWireRestoreError {
    AccountWireRestoreError::Invalid(detail.into())
}

fn tagged(value: &serde_json::Map<String, Value>) -> Result<AbiValue, AccountWireRestoreError> {
    let tag = value
        .get("__xlnType")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("OBJECT"))?;
    match tag {
        "TypedArray"
            if value.len() == 3
                && value.get("kind").and_then(Value::as_str) == Some("Uint8Array") =>
        {
            let encoded = value
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("BYTES"))?;
            BASE64
                .decode(encoded)
                .map(AbiValue::Bytes)
                .map_err(|_| invalid("BYTES"))
        }
        "BigInt" if value.len() == 2 => value
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("BIGINT"))?
            .parse::<i128>()
            .map(AbiValue::Integer)
            .map_err(|_| invalid("BIGINT")),
        _ => Err(invalid(format!("TAG:{tag}"))),
    }
}

/// Exact inverse of the tagged-storage boundary used by the TS checkpoint
/// reader. Objects other than the two explicit tagged scalar forms are not a
/// positional ABI value and are rejected instead of being reinterpreted.
pub fn abi(value: &Value) -> Result<AbiValue, AccountWireRestoreError> {
    match value {
        Value::Null => Ok(AbiValue::Nil),
        Value::Bool(value) => Ok(AbiValue::Bool(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(i128::from)
            .or_else(|| value.as_u64().map(i128::from))
            .map(AbiValue::Integer)
            .ok_or_else(|| invalid("NUMBER")),
        Value::String(value) => Ok(AbiValue::Text(value.clone())),
        Value::Array(values) => values
            .iter()
            .map(abi)
            .collect::<Result<Vec<_>, _>>()
            .map(BodyTuple::from_vec)
            .map(AbiValue::Tuple),
        Value::Object(value) => tagged(value),
    }
}

pub fn exact<'a>(
    fields: &'a [AbiValue],
    expected: usize,
    context: &'static str,
) -> Result<&'a [AbiValue], AccountWireRestoreError> {
    if fields.len() == expected {
        Ok(fields)
    } else {
        Err(invalid(format!(
            "ARITY:{context}:{}:{expected}",
            fields.len()
        )))
    }
}

pub fn tuple(value: &AbiValue) -> Result<&[AbiValue], AccountWireRestoreError> {
    match value {
        AbiValue::Tuple(value) => Ok(value.fields()),
        _ => Err(invalid("TUPLE")),
    }
}

pub fn integer(value: &AbiValue) -> Result<i128, AccountWireRestoreError> {
    match value {
        AbiValue::Integer(value) => Ok(*value),
        _ => Err(invalid("INTEGER")),
    }
}

pub fn unsigned(value: &AbiValue, field: &'static str) -> Result<u64, AccountWireRestoreError> {
    let value = integer(value)?;
    u64::try_from(value).map_err(|_| invalid(format!("UNSIGNED:{field}:{value}")))
}

pub fn js_number(value: &AbiValue, field: &'static str) -> Result<u64, AccountWireRestoreError> {
    let value = unsigned(value, field)?;
    if value <= JS_MAX_SAFE_INTEGER {
        Ok(value)
    } else {
        Err(invalid(format!("JS_NUMBER:{field}:{value}")))
    }
}

pub fn bounded_u32(value: &AbiValue, field: &'static str) -> Result<u32, AccountWireRestoreError> {
    let value = integer(value)?;
    u32::try_from(value).map_err(|_| invalid(format!("U32:{field}:{value}")))
}

pub fn text(value: &AbiValue) -> Result<&str, AccountWireRestoreError> {
    match value {
        AbiValue::Text(value) => Ok(value),
        _ => Err(invalid("TEXT")),
    }
}

pub fn optional_text(value: &AbiValue) -> Result<Option<String>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Text(value) => Ok(Some(value.clone())),
        _ => Err(invalid("OPTIONAL_TEXT")),
    }
}

pub fn text_list(value: &AbiValue) -> Result<Vec<String>, AccountWireRestoreError> {
    tuple(value)?
        .iter()
        .map(|value| text(value).map(str::to_owned))
        .collect()
}

pub fn bytes<'a>(
    value: &'a AbiValue,
    field: &'static str,
) -> Result<&'a [u8], AccountWireRestoreError> {
    match value {
        AbiValue::Bytes(value) => Ok(value),
        _ => Err(invalid(format!("BYTES:{field}"))),
    }
}

pub fn fixed_bytes<const N: usize>(
    value: &AbiValue,
    field: &'static str,
) -> Result<[u8; N], AccountWireRestoreError> {
    bytes(value, field)?
        .try_into()
        .map_err(|_| invalid(format!("FIXED_BYTES:{field}:{N}")))
}

pub fn optional_fixed_bytes<const N: usize>(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<[u8; N]>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        _ => fixed_bytes(value, field).map(Some),
    }
}

pub fn boolean(value: &AbiValue, field: &'static str) -> Result<bool, AccountWireRestoreError> {
    match value {
        AbiValue::Bool(value) => Ok(*value),
        AbiValue::Integer(0) => Ok(false),
        AbiValue::Integer(1) => Ok(true),
        _ => Err(invalid(format!("BOOLEAN:{field}"))),
    }
}

pub fn strict_boolean(
    value: &AbiValue,
    field: &'static str,
) -> Result<bool, AccountWireRestoreError> {
    match value {
        AbiValue::Bool(value) => Ok(*value),
        _ => Err(invalid(format!("STRICT_BOOLEAN:{field}"))),
    }
}

pub fn bigint(value: &AbiValue, field: &'static str) -> Result<BigInt, AccountWireRestoreError> {
    let value = text(value)?;
    value
        .parse()
        .map_err(|_| invalid(format!("BIGINT:{field}:{value}")))
}

pub fn token(value: &AbiValue) -> Result<TokenId, AccountWireRestoreError> {
    TokenId::new(bounded_u32(value, "tokenId")?).map_err(|error| invalid(format!("TOKEN:{error}")))
}

pub fn hex_fixed(
    value: &AbiValue,
    field: &'static str,
    length: usize,
) -> Result<String, AccountWireRestoreError> {
    let bytes = bytes(value, field)?;
    if bytes.len() != length {
        return Err(invalid(format!("HEX_FIXED:{field}:{length}")));
    }
    let mut output = String::with_capacity(length.saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        use std::fmt::Write as _;
        write!(output, "{byte:02x}").map_err(|_| invalid(format!("HEX_FIXED:{field}")))?;
    }
    Ok(output)
}

pub fn entity(value: &AbiValue, field: &'static str) -> Result<EntityId, AccountWireRestoreError> {
    EntityId::parse(&hex_fixed(value, field, 32)?)
        .map_err(|error| invalid(format!("ENTITY:{field}:{error}")))
}
