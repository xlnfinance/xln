use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{EntityId, TokenId};

use crate::ProcessError;

pub fn token(value: &AbiValue) -> Result<TokenId, ProcessError> {
    Ok(TokenId::new(bounded_u32(value, "tokenId")?)?)
}

pub fn bounded_u32(value: &AbiValue, field: &'static str) -> Result<u32, ProcessError> {
    let value = integer(value)?;
    u32::try_from(value).map_err(|_| ProcessError::Integer { field, value })
}

pub fn unsigned(value: &AbiValue, field: &'static str) -> Result<u64, ProcessError> {
    let value = integer(value)?;
    u64::try_from(value).map_err(|_| ProcessError::Integer { field, value })
}

pub fn bigint(value: &AbiValue, field: &'static str) -> Result<BigInt, ProcessError> {
    let value = text(value)?;
    value.parse().map_err(|_| ProcessError::BigInt {
        field,
        value: value.into(),
    })
}

pub fn integer(value: &AbiValue) -> Result<i128, ProcessError> {
    match value {
        AbiValue::Integer(value) => Ok(*value),
        _ => Err(ProcessError::Expected("integer")),
    }
}

pub fn text(value: &AbiValue) -> Result<&str, ProcessError> {
    match value {
        AbiValue::Text(value) => Ok(value),
        _ => Err(ProcessError::Expected("text")),
    }
}

pub fn optional_text(value: &AbiValue) -> Result<Option<String>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Text(value) => Ok(Some(value.clone())),
        _ => Err(ProcessError::Expected("optionalText")),
    }
}

pub fn text_list(value: &AbiValue) -> Result<Vec<String>, ProcessError> {
    tuple(value)?
        .iter()
        .map(|value| Ok(text(value)?.into()))
        .collect()
}

pub fn tuple(value: &AbiValue) -> Result<&[AbiValue], ProcessError> {
    match value {
        AbiValue::Tuple(value) => Ok(value.fields()),
        _ => Err(ProcessError::Expected("tuple")),
    }
}

pub fn fixed_bytes<const N: usize>(
    value: &AbiValue,
    field: &'static str,
) -> Result<[u8; N], ProcessError> {
    match value {
        AbiValue::Bytes(bytes) => bytes
            .as_slice()
            .try_into()
            .map_err(|_| ProcessError::Expected(field)),
        _ => Err(ProcessError::Expected(field)),
    }
}

pub fn optional_fixed_bytes<const N: usize>(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<[u8; N]>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        _ => Ok(Some(fixed_bytes(value, field)?)),
    }
}

pub fn entity(value: &AbiValue, field: &'static str) -> Result<EntityId, ProcessError> {
    Ok(EntityId::parse(&hex_fixed(value, field, 32)?)?)
}

pub fn hex_fixed(
    value: &AbiValue,
    field: &'static str,
    length: usize,
) -> Result<String, ProcessError> {
    let AbiValue::Bytes(bytes) = value else {
        return Err(ProcessError::Expected(field));
    };
    if bytes.len() != length {
        return Err(ProcessError::Expected(field));
    }
    let mut output = String::with_capacity(length * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        use std::fmt::Write;
        write!(output, "{byte:02x}").map_err(|_| ProcessError::Expected(field))?;
    }
    Ok(output)
}

pub fn exact<'a>(
    fields: &'a [AbiValue],
    expected: usize,
    context: &'static str,
) -> Result<&'a [AbiValue], ProcessError> {
    if fields.len() != expected {
        return Err(ProcessError::Arity {
            context,
            actual: fields.len(),
            expected,
        });
    }
    Ok(fields)
}
