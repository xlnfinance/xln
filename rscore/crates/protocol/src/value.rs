use std::cmp::Ordering;

use num_bigint::{BigInt, Sign};
use thiserror::Error;

use crate::rlp::{RlpError, RlpWriter, encode_list, encode_payload};

#[derive(Clone, Debug, PartialEq)]
pub enum CanonicalValue {
    Null,
    Bool(bool),
    Number(f64),
    BigInt(BigInt),
    String(String),
    Array(Vec<CanonicalValue>),
    Map(Vec<(CanonicalValue, CanonicalValue)>),
    Set(Vec<CanonicalValue>),
    Object(Vec<(String, CanonicalValue)>),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValueEncodingError {
    #[error("ACCOUNT_STATE_RLP_NON_FINITE_NUMBER")]
    NonFiniteNumber,
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

fn encode_number(value: f64) -> Result<Vec<u8>, ValueEncodingError> {
    if !value.is_finite() {
        return Err(ValueEncodingError::NonFiniteNumber);
    }
    let mut buffer = ryu_js::Buffer::new();
    let rendered = buffer.format(value);
    Ok(scalar("number", &[text(rendered)?])?)
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
        CanonicalValue::Number(number) => {
            if !number.is_finite() {
                return Err(ValueEncodingError::NonFiniteNumber);
            }
            let mut buffer = ryu_js::Buffer::new();
            let rendered = buffer.format(*number).to_owned();
            write_scalar(writer, "number", |writer| {
                Ok(writer.push_payload(rendered.as_bytes())?)
            })
        }
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
        // Map and Set order by ENCODED bytes, which the streaming writer cannot
        // know before it writes them. They are rare in committed account state,
        // so they fall back to the allocating encoder.
        CanonicalValue::Map(_) | CanonicalValue::Set(_) => {
            let encoded = encode_account_state_value(value)?;
            writer.push_encoded(&encoded);
            Ok(())
        }
    }
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
        CanonicalValue::Number(value) => encode_number(*value),
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

    fn encoded_hex(value: CanonicalValue) -> String {
        hex::encode(encode_account_state_value(&value).expect("encode"))
    }

    #[test]
    fn matches_typescript_literal_vectors() {
        let vectors = [
            (CanonicalValue::Null, "c5846e756c6c"),
            (CanonicalValue::Bool(false), "c684626f6f6c00"),
            (CanonicalValue::Bool(true), "c684626f6f6c01"),
            (CanonicalValue::Number(0.0), "c8866e756d62657230"),
            (CanonicalValue::Number(42.0), "ca866e756d626572823432"),
            (CanonicalValue::Number(-3.5), "cc866e756d626572842d332e35"),
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
            CanonicalValue::Number(1.0),
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
}
