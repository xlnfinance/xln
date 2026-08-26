use std::cmp::Ordering;

use num_bigint::{BigInt, Sign};
use thiserror::Error;

use crate::rlp::{RlpError, RlpWriter, encode_list, encode_payload};

/// Largest integer JavaScript can represent without rounding.
pub const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Exact text emitted by JavaScript's canonical Number rendering.
///
/// The text is validated once at the wire boundary and then committed as-is.
/// Keeping it private prevents a binary64 value from entering hashed state.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CanonicalNumber(Box<str>);

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CanonicalNumberError {
    #[error("CANONICAL_NUMBER_INVALID")]
    Invalid,
    #[error("CANONICAL_NUMBER_NON_FINITE")]
    NonFinite,
    #[error("CANONICAL_NUMBER_NON_CANONICAL")]
    NonCanonical,
    #[error("CANONICAL_NUMBER_UNSAFE_INTEGER:{0}")]
    UnsafeInteger(String),
}

impl CanonicalNumber {
    /// Validate text received from JavaScript without retaining the parsed
    /// binary64 value. `ryu_js` is used only to prove the input is the exact
    /// canonical rendering the TypeScript encoder would hash.
    pub fn parse_js_canonical(value: &str) -> Result<Self, CanonicalNumberError> {
        let parsed = value
            .parse::<f64>()
            .map_err(|_| CanonicalNumberError::Invalid)?;
        if !parsed.is_finite() {
            return Err(CanonicalNumberError::NonFinite);
        }
        let mut buffer = ryu_js::Buffer::new();
        if buffer.format(parsed) != value {
            return Err(CanonicalNumberError::NonCanonical);
        }
        Ok(Self(value.into()))
    }

    /// Construct a Rust-produced unsigned protocol number without rounding.
    pub fn try_from_u64(value: u64) -> Result<Self, CanonicalNumberError> {
        if value > JS_MAX_SAFE_INTEGER {
            return Err(CanonicalNumberError::UnsafeInteger(value.to_string()));
        }
        Ok(Self(value.to_string().into()))
    }

    /// Construct a Rust-produced signed protocol number without rounding.
    pub fn try_from_i64(value: i64) -> Result<Self, CanonicalNumberError> {
        let maximum = JS_MAX_SAFE_INTEGER as i64;
        if !(-maximum..=maximum).contains(&value) {
            return Err(CanonicalNumberError::UnsafeInteger(value.to_string()));
        }
        Ok(Self(value.to_string().into()))
    }

    /// Every `u32` is a JavaScript-safe integer; this explicit constructor
    /// still prevents callers from entering through a floating-point cast.
    pub fn from_u32(value: u32) -> Self {
        Self(value.to_string().into())
    }

    pub fn from_u16(value: u16) -> Self {
        Self(value.to_string().into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanonicalValue {
    Null,
    Bool(bool),
    Number(CanonicalNumber),
    BigInt(BigInt),
    String(String),
    Array(Vec<CanonicalValue>),
    Map(Vec<(CanonicalValue, CanonicalValue)>),
    Set(Vec<CanonicalValue>),
    Object(Vec<(String, CanonicalValue)>),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValueEncodingError {
    #[error("ACCOUNT_STATE_RLP_DUPLICATE_OBJECT_KEY:{0}")]
    DuplicateObjectKey(String),
    #[error("ACCOUNT_STATE_RLP_DUPLICATE_MAP_KEY")]
    DuplicateMapKey,
    #[error("ACCOUNT_STATE_RLP_DUPLICATE_SET_VALUE")]
    DuplicateSetValue,
    #[error(transparent)]
    Rlp(#[from] RlpError),
}

fn text(value: &str) -> Result<Vec<u8>, RlpError> {
    encode_payload(value.as_bytes())
}

fn byte(value: u8) -> Result<Vec<u8>, RlpError> {
    encode_payload(&[value])
}

fn scalar(tag: &str, payloads: &[Vec<u8>]) -> Result<Vec<u8>, RlpError> {
    let mut children = Vec::with_capacity(payloads.len() + 1);
    children.push(text(tag)?);
    children.extend_from_slice(payloads);
    encode_list(&children)
}

fn cmp_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn encode_number(value: &CanonicalNumber) -> Result<Vec<u8>, ValueEncodingError> {
    Ok(scalar("number", &[text(value.as_str())?])?)
}

fn magnitude_bytes(value: &BigInt) -> (u8, Vec<u8>) {
    let (sign, mut magnitude) = value.to_bytes_be();
    if magnitude.is_empty() {
        magnitude.push(0);
    }
    (u8::from(sign == Sign::Minus), magnitude)
}

fn encode_map(entries: &[(CanonicalValue, CanonicalValue)]) -> Result<Vec<u8>, ValueEncodingError> {
    let mut encoded = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        encoded.push((
            encode_account_state_value(key)?,
            encode_account_state_value(value)?,
        ));
    }
    encoded.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    if encoded.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(ValueEncodingError::DuplicateMapKey);
    }
    let mut children = Vec::with_capacity(encoded.len() + 1);
    children.push(text("map")?);
    for (key, value) in encoded {
        children.push(encode_list(&[key, value])?);
    }
    Ok(encode_list(&children)?)
}

fn encode_set(entries: &[CanonicalValue]) -> Result<Vec<u8>, ValueEncodingError> {
    let mut encoded = entries
        .iter()
        .map(encode_account_state_value)
        .collect::<Result<Vec<_>, _>>()?;
    encoded.sort_unstable();
    if encoded.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ValueEncodingError::DuplicateSetValue);
    }
    let mut children = Vec::with_capacity(encoded.len() + 1);
    children.push(text("set")?);
    children.extend(encoded);
    Ok(encode_list(&children)?)
}

fn encode_object(entries: &[(String, CanonicalValue)]) -> Result<Vec<u8>, ValueEncodingError> {
    let mut ordered = entries.iter().collect::<Vec<_>>();
    ordered.sort_unstable_by(|left, right| cmp_utf16(&left.0, &right.0));
    for pair in ordered.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(ValueEncodingError::DuplicateObjectKey(pair[0].0.clone()));
        }
    }
    let mut children = Vec::with_capacity(ordered.len() + 1);
    children.push(text("object")?);
    for (key, value) in ordered {
        children.push(encode_list(&[
            text(key)?,
            encode_account_state_value(value)?,
        ])?);
    }
    Ok(encode_list(&children)?)
}

/// Same bytes as `encode_account_state_value`, written into one buffer.
///
/// The account state root hashes five of these per account per commit, so the
/// allocating encoder's malloc-per-node showed up as the single largest cost
/// in the engine profile.
pub fn write_account_state_value(
    writer: &mut RlpWriter,
    value: &CanonicalValue,
) -> Result<(), ValueEncodingError> {
    match value {
        CanonicalValue::Null => write_scalar(writer, "null", |_| Ok(())),
        CanonicalValue::Bool(flag) => write_scalar(writer, "bool", |writer| {
            Ok(writer.push_payload(&[u8::from(*flag)])?)
        }),
        CanonicalValue::Number(number) => write_scalar(writer, "number", |writer| {
            Ok(writer.push_payload(number.as_str().as_bytes())?)
        }),
        CanonicalValue::BigInt(value) => {
            let (sign, magnitude) = magnitude_bytes(value);
            write_scalar(writer, "bigint", |writer| {
                writer.push_payload(&[sign])?;
                Ok(writer.push_payload(&magnitude)?)
            })
        }
        CanonicalValue::String(value) => write_scalar(writer, "string", |writer| {
            Ok(writer.push_payload(value.as_bytes())?)
        }),
        CanonicalValue::Array(entries) => write_scalar(writer, "array", |writer| {
            for entry in entries {
                write_account_state_value(writer, entry)?;
            }
            Ok(())
        }),
        CanonicalValue::Object(entries) => {
            // Ordering and duplicate detection are the encoder's contract, so
            // the fast path keeps them: sort by UTF-16 key exactly as JavaScript
            // does, and refuse a duplicate instead of committing one of two.
            let mut ordered = entries.iter().collect::<Vec<_>>();
            ordered.sort_unstable_by(|left, right| cmp_utf16(&left.0, &right.0));
            for pair in ordered.windows(2) {
                if pair[0].0 == pair[1].0 {
                    return Err(ValueEncodingError::DuplicateObjectKey(pair[0].0.clone()));
                }
            }
            write_scalar(writer, "object", |writer| {
                for (key, value) in ordered {
                    let mark = writer.open_list();
                    writer.push_payload(key.as_bytes())?;
                    write_account_state_value(writer, value)?;
                    writer.close_list(mark)?;
                }
                Ok(())
            })
        }
        CanonicalValue::Map(entries) => write_map(writer, entries),
        CanonicalValue::Set(entries) => write_set(writer, entries),
    }
}

fn write_map(
    writer: &mut RlpWriter,
    entries: &[(CanonicalValue, CanonicalValue)],
) -> Result<(), ValueEncodingError> {
    let mut ordered = entries
        .iter()
        .map(|(key, value)| Ok((encode_account_state_value(key)?, value)))
        .collect::<Result<Vec<_>, ValueEncodingError>>()?;
    ordered.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    if ordered.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(ValueEncodingError::DuplicateMapKey);
    }
    write_scalar(writer, "map", |writer| {
        for (key, value) in ordered {
            let mark = writer.open_list();
            writer.push_encoded(&key);
            write_account_state_value(writer, value)?;
            writer.close_list(mark)?;
        }
        Ok(())
    })
}

fn write_set(writer: &mut RlpWriter, entries: &[CanonicalValue]) -> Result<(), ValueEncodingError> {
    let mut ordered = entries
        .iter()
        .map(encode_account_state_value)
        .collect::<Result<Vec<_>, _>>()?;
    ordered.sort_unstable();
    if ordered.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ValueEncodingError::DuplicateSetValue);
    }
    write_scalar(writer, "set", |writer| {
        for value in ordered {
            writer.push_encoded(&value);
        }
        Ok(())
    })
}

fn write_scalar(
    writer: &mut RlpWriter,
    tag: &str,
    body: impl FnOnce(&mut RlpWriter) -> Result<(), ValueEncodingError>,
) -> Result<(), ValueEncodingError> {
    let mark = writer.open_list();
    writer.push_payload(tag.as_bytes())?;
    body(writer)?;
    Ok(writer.close_list(mark)?)
}

pub fn encode_account_state_value(value: &CanonicalValue) -> Result<Vec<u8>, ValueEncodingError> {
    match value {
        CanonicalValue::Null => Ok(scalar("null", &[])?),
        CanonicalValue::Bool(value) => Ok(scalar("bool", &[byte(u8::from(*value))?])?),
        CanonicalValue::Number(value) => encode_number(value),
        CanonicalValue::BigInt(value) => {
            let (sign, magnitude) = magnitude_bytes(value);
            Ok(scalar(
                "bigint",
                &[byte(sign)?, encode_payload(&magnitude)?],
            )?)
        }
        CanonicalValue::String(value) => Ok(scalar("string", &[text(value)?])?),
        CanonicalValue::Array(entries) => {
            let mut children = Vec::with_capacity(entries.len() + 1);
            children.push(text("array")?);
            children.extend(
                entries
                    .iter()
                    .map(encode_account_state_value)
                    .collect::<Result<Vec<_>, _>>()?,
            );
            Ok(encode_list(&children)?)
        }
        CanonicalValue::Map(entries) => encode_map(entries),
        CanonicalValue::Set(entries) => encode_set(entries),
        CanonicalValue::Object(entries) => encode_object(entries),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(value: &str) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::parse_js_canonical(value).expect("number"))
    }

    fn encoded_hex(value: CanonicalValue) -> String {
        hex::encode(encode_account_state_value(&value).expect("encode"))
    }

    #[test]
    fn matches_typescript_literal_vectors() {
        let vectors = [
            (CanonicalValue::Null, "c5846e756c6c"),
            (CanonicalValue::Bool(false), "c684626f6f6c00"),
            (CanonicalValue::Bool(true), "c684626f6f6c01"),
            (number("0"), "c8866e756d62657230"),
            (number("42"), "ca866e756d626572823432"),
            (number("-3.5"), "cc866e756d626572842d332e35"),
            (CanonicalValue::BigInt(0.into()), "c986626967696e740000"),
            (
                CanonicalValue::BigInt((-255).into()),
                "ca86626967696e740181ff",
            ),
            (CanonicalValue::String("x".into()), "c886737472696e6778"),
        ];
        for (value, expected) in vectors {
            assert_eq!(encoded_hex(value), expected);
        }
    }

    #[test]
    fn matches_typescript_composite_vectors() {
        let array = CanonicalValue::Array(vec![
            number("1"),
            CanonicalValue::String("a".into()),
            CanonicalValue::BigInt(2.into()),
        ]);
        assert_eq!(
            encoded_hex(array),
            "e2856172726179c8866e756d62657231c886737472696e6761c986626967696e740002",
        );
        let object = CanonicalValue::Object(vec![
            ("z".into(), CanonicalValue::BigInt(2.into())),
            ("a".into(), CanonicalValue::String("x".into())),
        ]);
        assert_eq!(
            encoded_hex(object),
            "de866f626a656374ca61c886737472696e6778cb7ac986626967696e740002",
        );
        let map = CanonicalValue::Map(vec![
            (
                CanonicalValue::String("z".into()),
                CanonicalValue::BigInt(2.into()),
            ),
            (
                CanonicalValue::String("a".into()),
                CanonicalValue::BigInt(1.into()),
            ),
        ]);
        assert_eq!(
            encoded_hex(map),
            "ec836d6170d3c886737472696e6761c986626967696e740001d3c886737472696e677ac986626967696e740002",
        );
        let set = CanonicalValue::Set(vec![
            CanonicalValue::String("z".into()),
            CanonicalValue::String("a".into()),
        ]);
        assert_eq!(
            encoded_hex(set),
            "d683736574c886737472696e6761c886737472696e677a",
        );
    }

    #[test]
    fn streaming_writer_matches_allocating_encoder_for_nested_maps_and_sets() {
        let value = CanonicalValue::Object(vec![
            (
                "map".into(),
                CanonicalValue::Map(vec![
                    (
                        CanonicalValue::String("z".into()),
                        CanonicalValue::Set(vec![number("2"), number("1")]),
                    ),
                    (
                        CanonicalValue::String("a".into()),
                        CanonicalValue::Array(vec![
                            CanonicalValue::Null,
                            CanonicalValue::BigInt((-9).into()),
                        ]),
                    ),
                ]),
            ),
            ("enabled".into(), CanonicalValue::Bool(false)),
        ]);
        let expected = encode_account_state_value(&value).expect("allocating encoder");
        let mut writer = RlpWriter::with_capacity(expected.len());
        write_account_state_value(&mut writer, &value).expect("streaming writer");
        assert_eq!(writer.as_slice(), expected);
    }

    #[test]
    fn canonical_number_accepts_javascript_rendering_thresholds() {
        for value in [
            "0",
            "42",
            "-3.5",
            "100000000000000000000",
            "1e+21",
            "0.000001",
            "1e-7",
        ] {
            assert_eq!(
                CanonicalNumber::parse_js_canonical(value)
                    .expect("canonical")
                    .as_str(),
                value
            );
        }
    }

    #[test]
    fn canonical_number_rejects_negative_zero_non_finite_and_alternate_text() {
        assert_eq!(
            CanonicalNumber::parse_js_canonical("-0"),
            Err(CanonicalNumberError::NonCanonical)
        );
        for value in ["NaN", "inf", "-inf", "Infinity", "-Infinity"] {
            assert!(matches!(
                CanonicalNumber::parse_js_canonical(value),
                Err(CanonicalNumberError::Invalid | CanonicalNumberError::NonFinite)
            ));
        }
        for value in ["01", "+1", "1.0", "1e20", "1e21", "0.0000001"] {
            assert_eq!(
                CanonicalNumber::parse_js_canonical(value),
                Err(CanonicalNumberError::NonCanonical)
            );
        }
    }

    #[test]
    fn safe_integer_constructors_enforce_javascript_bounds() {
        let maximum = JS_MAX_SAFE_INTEGER;
        assert_eq!(
            CanonicalNumber::try_from_u64(maximum)
                .expect("maximum")
                .as_str(),
            "9007199254740991"
        );
        assert_eq!(
            CanonicalNumber::try_from_i64(-(maximum as i64))
                .expect("minimum")
                .as_str(),
            "-9007199254740991"
        );
        assert!(matches!(
            CanonicalNumber::try_from_u64(maximum + 1),
            Err(CanonicalNumberError::UnsafeInteger(_))
        ));
        assert!(matches!(
            CanonicalNumber::try_from_i64(-((maximum as i64) + 1)),
            Err(CanonicalNumberError::UnsafeInteger(_))
        ));
    }
}
