use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::{EntityCommandError, invalid};

pub(super) fn object<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityCommandError> {
    match value {
        CanonicalValue::Object(entries) => Ok(entries),
        _ => Err(invalid(format!("ENTITY_COMMAND_OBJECT_REQUIRED:{path}"))),
    }
}

pub(super) fn exact_fields(
    entries: &[(String, CanonicalValue)],
    expected: &[&str],
    path: &str,
) -> Result<(), EntityCommandError> {
    let mut actual = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!(
            "ENTITY_COMMAND_FIELDS_INVALID:{path}:{}",
            actual.join(",")
        )))
    }
}

pub(super) fn field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
    path: &str,
) -> Result<&'a CanonicalValue, EntityCommandError> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("ENTITY_COMMAND_FIELD_REQUIRED:{path}.{name}")))
}

pub(super) fn string(value: &CanonicalValue, code: &str) -> Result<String, EntityCommandError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(code)),
    }
}

pub(super) fn signer(value: &CanonicalValue) -> Result<String, EntityCommandError> {
    let signer = string(value, "ENTITY_COMMAND_AUTHOR_SIGNER_ID_REQUIRED")?
        .trim()
        .to_lowercase();
    (!signer.is_empty())
        .then_some(signer)
        .ok_or_else(|| invalid("ENTITY_COMMAND_AUTHOR_SIGNER_ID_REQUIRED"))
}

pub(super) fn fixed_hex<const N: usize>(
    value: &str,
    code: &str,
) -> Result<[u8; N], EntityCommandError> {
    let normalized = value.trim().to_lowercase();
    let payload = normalized
        .strip_prefix("0x")
        .filter(|payload| payload.len() == N * 2)
        .ok_or_else(|| invalid(format!("{code}:{normalized}")))?;
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("{code}:{normalized}")))?;
    }
    Ok(output)
}

pub(super) fn canonical_hex<const N: usize>(
    value: &CanonicalValue,
    code: &str,
) -> Result<String, EntityCommandError> {
    let value = string(value, code)?.trim().to_lowercase();
    fixed_hex::<N>(&value, code)?;
    Ok(value)
}

pub(super) fn safe_u64(value: &CanonicalValue, code: &str) -> Result<u64, EntityCommandError> {
    match value {
        CanonicalValue::Number(value) => value
            .as_str()
            .parse::<u64>()
            .ok()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid(code)),
        _ => Err(invalid(code)),
    }
}

pub(super) fn exact_number(
    value: &CanonicalValue,
    expected: u64,
    code: &str,
) -> Result<(), EntityCommandError> {
    if safe_u64(value, code)? == expected {
        Ok(())
    } else {
        Err(invalid(code))
    }
}

pub(super) fn positive_bigint(
    value: &CanonicalValue,
    code: &str,
) -> Result<BigInt, EntityCommandError> {
    match value {
        CanonicalValue::BigInt(value) if value > &BigInt::from(0_u8) => Ok(value.clone()),
        _ => Err(invalid(code)),
    }
}

pub(super) fn object_value(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

pub(super) fn number(value: u64) -> Result<CanonicalValue, EntityCommandError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| invalid(format!("ENTITY_COMMAND_NUMBER_UNSAFE:{value}")))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}
