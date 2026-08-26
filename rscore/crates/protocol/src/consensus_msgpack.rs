//! Exact encoder for the deterministic `msgpackr` profile used by
//! TypeScript's `encodeCanonicalConsensusBytes`.
//!
//! This is intentionally an encoder only. Typed Rust boundaries validate
//! consensus values before they reach this module; accepting arbitrary
//! MessagePack here would create a second validation path.

use std::cmp::Ordering;

use num_bigint::{BigInt, Sign};
use thiserror::Error;

use crate::{CanonicalNumber, CanonicalValue};

const RECORD_BASE: u8 = 0x40;
const RECORD_LIMIT: usize = 64;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConsensusMessagePackError {
    #[error("CONSENSUS_MSGPACK_BIGINT_OUT_OF_RANGE:{0}")]
    BigIntOutOfRange(String),
    #[error("CONSENSUS_MSGPACK_DUPLICATE_OBJECT_KEY:{0}")]
    DuplicateObjectKey(String),
    #[error("CONSENSUS_MSGPACK_LENGTH_OUT_OF_RANGE:{0}")]
    LengthOutOfRange(usize),
    #[error("CONSENSUS_MSGPACK_NUMBER_INVALID:{0}")]
    NumberInvalid(String),
    #[error("CONSENSUS_MSGPACK_RECORD_SHAPE_LIMIT:{0}")]
    RecordShapeLimit(usize),
}

struct Encoder {
    bytes: Vec<u8>,
    record_shapes: Vec<Vec<String>>,
}

impl Encoder {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            record_shapes: Vec::new(),
        }
    }

    fn write_u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_i16(&mut self, value: i16) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_i64(&mut self, value: i64) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn write_len(
        &mut self,
        length: usize,
        fix: u8,
        fix_limit: usize,
        marker16: u8,
        marker32: u8,
    ) -> Result<(), ConsensusMessagePackError> {
        if length <= fix_limit {
            let length = u8::try_from(length)
                .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
            self.bytes.push(fix | length);
        } else if let Ok(length) = u16::try_from(length) {
            self.bytes.push(marker16);
            self.write_u16(length);
        } else {
            let length = u32::try_from(length)
                .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
            self.bytes.push(marker32);
            self.write_u32(length);
        }
        Ok(())
    }

    fn write_string(&mut self, value: &str) -> Result<(), ConsensusMessagePackError> {
        let bytes = value.as_bytes();
        match bytes.len() {
            length @ 0..=31 => {
                let length = u8::try_from(length)
                    .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
                self.bytes.push(0xa0 | length);
            }
            length @ 32..=255 => {
                let length = u8::try_from(length)
                    .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
                self.bytes.extend_from_slice(&[0xd9, length]);
            }
            length @ 256..=65_535 => {
                let length = u16::try_from(length)
                    .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
                self.bytes.push(0xda);
                self.write_u16(length);
            }
            length => {
                let length = u32::try_from(length)
                    .map_err(|_| ConsensusMessagePackError::LengthOutOfRange(length))?;
                self.bytes.push(0xdb);
                self.write_u32(length);
            }
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn write_array_len(&mut self, length: usize) -> Result<(), ConsensusMessagePackError> {
        self.write_len(length, 0x90, 15, 0xdc, 0xdd)
    }

    fn write_map_len(&mut self, length: usize) -> Result<(), ConsensusMessagePackError> {
        self.write_len(length, 0x80, 15, 0xde, 0xdf)
    }

    fn write_number(&mut self, value: &CanonicalNumber) -> Result<(), ConsensusMessagePackError> {
        if let Ok(unsigned) = value.as_str().parse::<u32>() {
            self.write_unsigned_number(unsigned);
            return Ok(());
        }
        if let Ok(signed) = value.as_str().parse::<i32>() {
            self.write_signed_number(signed);
            return Ok(());
        }
        let parsed = value
            .as_str()
            .parse::<f64>()
            .map_err(|_| ConsensusMessagePackError::NumberInvalid(value.as_str().to_string()))?;
        self.bytes.push(0xcb);
        self.write_u64(parsed.to_bits());
        Ok(())
    }

    fn write_unsigned_number(&mut self, value: u32) {
        match value {
            0..=63 => self.bytes.push(value.to_be_bytes()[3]),
            64..=255 => self
                .bytes
                .extend_from_slice(&[0xcc, value.to_be_bytes()[3]]),
            256..=65_535 => {
                self.bytes.push(0xcd);
                self.write_u16(value as u16);
            }
            _ => {
                self.bytes.push(0xce);
                self.write_u32(value);
            }
        }
    }

    fn write_signed_number(&mut self, value: i32) {
        if value >= 0 {
            self.write_unsigned_number(value as u32);
        } else if value >= -32 {
            self.bytes.push(value.to_be_bytes()[3]);
        } else if value >= i32::from(i8::MIN) {
            self.bytes
                .extend_from_slice(&[0xd0, value.to_be_bytes()[3]]);
        } else if value >= i32::from(i16::MIN) {
            self.bytes.push(0xd1);
            self.write_i16(value as i16);
        } else {
            self.bytes.push(0xd2);
            self.write_i32(value);
        }
    }

    fn write_bigint(&mut self, value: &BigInt) -> Result<(), ConsensusMessagePackError> {
        if let Ok(value) = i64::try_from(value) {
            self.bytes.push(0xd3);
            self.write_i64(value);
            return Ok(());
        }
        if value.sign() != Sign::Minus
            && let Ok(value) = u64::try_from(value)
        {
            self.bytes.push(0xcf);
            self.write_u64(value);
            return Ok(());
        }
        let value = i128::try_from(value)
            .map_err(|_| ConsensusMessagePackError::BigIntOutOfRange(value.to_string()))?;
        self.bytes.extend_from_slice(&[0xd8, 0x42]);
        self.bytes.extend_from_slice(&value.to_be_bytes());
        Ok(())
    }

    fn write_map(
        &mut self,
        entries: &[(CanonicalValue, CanonicalValue)],
    ) -> Result<(), ConsensusMessagePackError> {
        let mut ordered = entries
            .iter()
            .map(|(key, value)| {
                Ok((
                    encode_canonical_consensus_bytes(key)?,
                    encode_canonical_consensus_bytes(value)?,
                    key,
                    value,
                ))
            })
            .collect::<Result<Vec<_>, ConsensusMessagePackError>>()?;
        ordered.sort_by(|left, right| match left.0.cmp(&right.0) {
            Ordering::Equal => left.1.cmp(&right.1),
            ordering => ordering,
        });
        self.write_map_len(ordered.len())?;
        for (_, _, key, value) in ordered {
            self.write_value(key)?;
            self.write_value(value)?;
        }
        Ok(())
    }

    fn write_set(&mut self, entries: &[CanonicalValue]) -> Result<(), ConsensusMessagePackError> {
        let mut ordered = entries
            .iter()
            .map(|value| Ok((encode_canonical_consensus_bytes(value)?, value)))
            .collect::<Result<Vec<_>, ConsensusMessagePackError>>()?;
        ordered.sort_by(|left, right| left.0.cmp(&right.0));
        self.bytes.extend_from_slice(&[0xd4, 0x73, 0x00]);
        self.write_array_len(ordered.len())?;
        for (_, value) in ordered {
            self.write_value(value)?;
        }
        Ok(())
    }

    fn write_object(
        &mut self,
        entries: &[(String, CanonicalValue)],
    ) -> Result<(), ConsensusMessagePackError> {
        let mut ordered = entries.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
        if let Some(pair) = ordered.windows(2).find(|pair| pair[0].0 == pair[1].0) {
            return Err(ConsensusMessagePackError::DuplicateObjectKey(
                pair[0].0.clone(),
            ));
        }
        let keys = ordered
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        if let Some(index) = self.record_shapes.iter().position(|shape| shape == &keys) {
            self.bytes.push(RECORD_BASE + index as u8);
        } else {
            if self.record_shapes.len() >= RECORD_LIMIT {
                return Err(ConsensusMessagePackError::RecordShapeLimit(
                    self.record_shapes.len() + 1,
                ));
            }
            let record_id = RECORD_BASE + self.record_shapes.len() as u8;
            self.record_shapes.push(keys.clone());
            self.bytes.extend_from_slice(&[0xd4, 0x72, record_id]);
            self.write_array_len(keys.len())?;
            for key in &keys {
                self.write_string(key)?;
            }
        }
        for (_, value) in ordered {
            self.write_value(value)?;
        }
        Ok(())
    }

    fn write_value(&mut self, value: &CanonicalValue) -> Result<(), ConsensusMessagePackError> {
        match value {
            CanonicalValue::Null => self.bytes.push(0xc0),
            CanonicalValue::Bool(false) => self.bytes.push(0xc2),
            CanonicalValue::Bool(true) => self.bytes.push(0xc3),
            CanonicalValue::Number(value) => self.write_number(value)?,
            CanonicalValue::BigInt(value) => self.write_bigint(value)?,
            CanonicalValue::String(value) => self.write_string(value)?,
            CanonicalValue::Array(entries) => {
                self.write_array_len(entries.len())?;
                for entry in entries {
                    self.write_value(entry)?;
                }
            }
            CanonicalValue::Map(entries) => self.write_map(entries)?,
            CanonicalValue::Set(entries) => self.write_set(entries)?,
            CanonicalValue::Object(entries) => self.write_object(entries)?,
        }
        Ok(())
    }
}

/// Produce byte-identical output to TypeScript's canonical `msgpackr` encoder
/// for the closed `CanonicalValue` domain.
pub fn encode_canonical_consensus_bytes(
    value: &CanonicalValue,
) -> Result<Vec<u8>, ConsensusMessagePackError> {
    let mut encoder = Encoder::new();
    encoder.write_value(value)?;
    Ok(encoder.bytes)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;

    use super::*;

    fn number(value: i64) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::try_from_i64(value).expect("safe fixture number"))
    }

    fn text(value: &str) -> CanonicalValue {
        CanonicalValue::String(value.to_string())
    }

    fn hex(value: CanonicalValue) -> String {
        hex::encode(encode_canonical_consensus_bytes(&value).expect("encode fixture"))
    }

    #[test]
    fn matches_typescript_msgpackr_consensus_golden() {
        let value = CanonicalValue::Object(vec![
            ("version".into(), number(1)),
            (
                "object".into(),
                CanonicalValue::Object(vec![("z".into(), number(2)), ("a".into(), text("x"))]),
            ),
            (
                "map".into(),
                CanonicalValue::Map(vec![
                    (text("z"), CanonicalValue::BigInt(BigInt::from(2))),
                    (text("a"), CanonicalValue::BigInt(BigInt::from(1))),
                ]),
            ),
            (
                "set".into(),
                CanonicalValue::Set(vec![text("z"), text("a")]),
            ),
            (
                "bigint".into(),
                CanonicalValue::BigInt(
                    BigInt::parse_bytes(b"12345678901234567890", 10).expect("fixture bigint"),
                ),
            ),
        ]);
        assert_eq!(
            hex(value),
            "d4724095a6626967696e74a36d6170a66f626a656374a3736574a776657273696f6ecfab54a98ceb1f0ad282a161d30000000000000001a17ad30000000000000002d4724192a161a17aa17802d4730092a161a17a01"
        );
    }

    #[test]
    fn matches_typescript_integer_and_large_bigint_boundaries() {
        let values = CanonicalValue::Array(vec![
            number(63),
            number(64),
            number(4_294_967_296),
            CanonicalValue::BigInt(BigInt::from(u64::MAX)),
            CanonicalValue::BigInt(BigInt::from(u64::MAX) + BigInt::from(1_u8)),
            CanonicalValue::BigInt(-(BigInt::from(i64::MAX) + BigInt::from(2_u8))),
        ]);
        assert_eq!(
            hex(values),
            "963fcc40cb41f0000000000000cfffffffffffffffffd84200000000000000010000000000000000d842ffffffffffffffff7fffffffffffffff"
        );
    }

    #[test]
    fn reuses_record_shapes_in_the_same_order_as_msgpackr() {
        let row = |value| CanonicalValue::Object(vec![("x".into(), number(value))]);
        assert_eq!(
            hex(CanonicalValue::Array(vec![row(1), row(2)])),
            "92d4724091a178014002"
        );
    }
}
