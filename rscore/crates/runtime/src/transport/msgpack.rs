//! `msgpackr` value-only encoder used by the canonical Runtime socket.

use num_bigint::{BigInt, Sign};
use serde_json::Value;

use super::RuntimeTransportError;

mod tagged;

const RECORD_BASE: u8 = 0x40;
const RECORD_LIMIT: usize = 64;
const STORAGE_MAGIC: u8 = 0x03;

struct Encoder {
    bytes: Vec<u8>,
    shapes: Vec<Vec<String>>,
}

impl Encoder {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            shapes: Vec::new(),
        }
    }

    fn length(
        &mut self,
        length: usize,
        fix: u8,
        fix_max: usize,
        marker16: u8,
        marker32: u8,
    ) -> Result<(), RuntimeTransportError> {
        if length <= fix_max {
            self.bytes.push(fix | length as u8);
        } else if let Ok(value) = u16::try_from(length) {
            self.bytes.push(marker16);
            self.bytes.extend_from_slice(&value.to_be_bytes());
        } else {
            let value = u32::try_from(length)
                .map_err(|_| RuntimeTransportError::MessagePack("length".into()))?;
            self.bytes.push(marker32);
            self.bytes.extend_from_slice(&value.to_be_bytes());
        }
        Ok(())
    }

    fn string(&mut self, value: &str) -> Result<(), RuntimeTransportError> {
        let bytes = value.as_bytes();
        match bytes.len() {
            length @ 0..=31 => self.bytes.push(0xa0 | length as u8),
            length @ 32..=255 => self.bytes.extend_from_slice(&[0xd9, length as u8]),
            length @ 256..=65_535 => {
                self.bytes.push(0xda);
                self.bytes.extend_from_slice(&(length as u16).to_be_bytes());
            }
            length => {
                let length = u32::try_from(length)
                    .map_err(|_| RuntimeTransportError::MessagePack("string-length".into()))?;
                self.bytes.push(0xdb);
                self.bytes.extend_from_slice(&length.to_be_bytes());
            }
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn array_len(&mut self, length: usize) -> Result<(), RuntimeTransportError> {
        self.length(length, 0x90, 15, 0xdc, 0xdd)
    }

    fn map_len(&mut self, length: usize) -> Result<(), RuntimeTransportError> {
        self.length(length, 0x80, 15, 0xde, 0xdf)
    }

    fn extension(&mut self, kind: u8, payload: &[u8]) -> Result<(), RuntimeTransportError> {
        match payload.len() {
            1 => self.bytes.push(0xd4),
            2 => self.bytes.push(0xd5),
            4 => self.bytes.push(0xd6),
            8 => self.bytes.push(0xd7),
            16 => self.bytes.push(0xd8),
            length @ 0..=255 => self.bytes.extend_from_slice(&[0xc7, length as u8]),
            length @ 256..=65_535 => {
                self.bytes.push(0xc8);
                self.bytes.extend_from_slice(&(length as u16).to_be_bytes());
            }
            length => {
                let length = u32::try_from(length)
                    .map_err(|_| RuntimeTransportError::MessagePack("extension-length".into()))?;
                self.bytes.push(0xc9);
                self.bytes.extend_from_slice(&length.to_be_bytes());
            }
        }
        self.bytes.push(kind);
        self.bytes.extend_from_slice(payload);
        Ok(())
    }

    fn unsigned(&mut self, value: u64) {
        match value {
            0..=63 => self.bytes.push(value as u8),
            64..=255 => self.bytes.extend_from_slice(&[0xcc, value as u8]),
            256..=65_535 => {
                self.bytes.push(0xcd);
                self.bytes.extend_from_slice(&(value as u16).to_be_bytes());
            }
            65_536..=4_294_967_295 => {
                self.bytes.push(0xce);
                self.bytes.extend_from_slice(&(value as u32).to_be_bytes());
            }
            _ => {
                self.bytes.push(0xcb);
                self.bytes
                    .extend_from_slice(&(value as f64).to_bits().to_be_bytes());
            }
        }
    }

    fn signed(&mut self, value: i64) {
        if value >= 0 {
            self.unsigned(value as u64);
        } else if value >= -32 {
            self.bytes.push(value as i8 as u8);
        } else if value >= i8::MIN as i64 {
            self.bytes.extend_from_slice(&[0xd0, value as i8 as u8]);
        } else if value >= i16::MIN as i64 {
            self.bytes.push(0xd1);
            self.bytes.extend_from_slice(&(value as i16).to_be_bytes());
        } else if value >= i32::MIN as i64 {
            self.bytes.push(0xd2);
            self.bytes.extend_from_slice(&(value as i32).to_be_bytes());
        } else {
            self.bytes.push(0xcb);
            self.bytes
                .extend_from_slice(&(value as f64).to_bits().to_be_bytes());
        }
    }

    fn bigint(&mut self, value: &str) -> Result<(), RuntimeTransportError> {
        let value = value
            .parse::<BigInt>()
            .map_err(|_| RuntimeTransportError::MessagePack("bigint".into()))?;
        if let Ok(value) = i64::try_from(&value) {
            self.bytes.push(0xd3);
            self.bytes.extend_from_slice(&value.to_be_bytes());
            return Ok(());
        }
        if value.sign() != Sign::Minus
            && let Ok(value) = u64::try_from(&value)
        {
            self.bytes.push(0xcf);
            self.bytes.extend_from_slice(&value.to_be_bytes());
            return Ok(());
        }
        let value = i128::try_from(value)
            .map_err(|_| RuntimeTransportError::MessagePack("bigint-range".into()))?;
        self.extension(0x42, &value.to_be_bytes())
    }

    fn object(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> Result<(), RuntimeTransportError> {
        if let Some(kind) = object.get("__xlnType").and_then(Value::as_str) {
            return self.tagged(object, kind);
        }
        let mut ordered = object.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
        self.object_entries(&ordered)
    }

    fn object_entries(
        &mut self,
        ordered: &[(&String, &Value)],
    ) -> Result<(), RuntimeTransportError> {
        let keys = ordered
            .iter()
            .map(|(key, _)| (*key).clone())
            .collect::<Vec<_>>();
        if let Some(index) = self.shapes.iter().position(|shape| shape == &keys) {
            self.bytes.push(RECORD_BASE + index as u8);
        } else {
            if self.shapes.len() >= RECORD_LIMIT {
                return Err(RuntimeTransportError::MessagePack("record-limit".into()));
            }
            let record = RECORD_BASE + self.shapes.len() as u8;
            self.shapes.push(keys.clone());
            self.extension(0x72, &[record])?;
            self.array_len(keys.len())?;
            for key in &keys {
                self.string(key)?;
            }
        }
        for (_, value) in ordered {
            self.value(value)?;
        }
        Ok(())
    }

    fn value(&mut self, value: &Value) -> Result<(), RuntimeTransportError> {
        match value {
            Value::Null => self.bytes.push(0xc0),
            Value::Bool(false) => self.bytes.push(0xc2),
            Value::Bool(true) => self.bytes.push(0xc3),
            Value::Number(number) => {
                if let Some(value) = number.as_u64() {
                    self.unsigned(value);
                } else if let Some(value) = number.as_i64() {
                    self.signed(value);
                } else {
                    let value = number
                        .as_f64()
                        .ok_or_else(|| RuntimeTransportError::MessagePack("number".into()))?;
                    self.bytes.push(0xcb);
                    self.bytes.extend_from_slice(&value.to_bits().to_be_bytes());
                }
            }
            Value::String(value) => self.string(value)?,
            Value::Array(values) => {
                self.array_len(values.len())?;
                for value in values {
                    self.value(value)?;
                }
            }
            Value::Object(object) => self.object(object)?,
        }
        Ok(())
    }
}

pub(super) fn required_text<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, RuntimeTransportError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeTransportError::MessagePack(field.into()))
}

pub(crate) fn encode_transport(value: &Value) -> Result<Vec<u8>, RuntimeTransportError> {
    let mut encoder = Encoder::new();
    encoder.value(value)?;
    Ok(encoder.bytes)
}

pub(crate) fn encode_framed(value: &Value) -> Result<Vec<u8>, RuntimeTransportError> {
    let body = encode_transport(value)?;
    let mut framed = Vec::with_capacity(body.len() + 1);
    framed.push(STORAGE_MAGIC);
    framed.extend_from_slice(&body);
    Ok(framed)
}

/// Canonical TS RuntimeFrame storage bytes have one deliberate top-level
/// exception to ordinary key sorting: `frameHash` is appended after the
/// already-canonical frame base.  The hash itself commits the sorted base;
/// keeping it last avoids a second multi-megabyte canonicalization in TS.
/// Nested values still use the one canonical value encoder above.
pub(crate) fn encode_framed_runtime_frame(value: &Value) -> Result<Vec<u8>, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::MessagePack("runtime-frame-object".into()))?;
    let frame_hash = object
        .get_key_value("frameHash")
        .ok_or_else(|| RuntimeTransportError::MessagePack("runtime-frame-hash".into()))?;
    let mut ordered = object
        .iter()
        .filter(|(key, _)| key.as_str() != "frameHash")
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    ordered.push(frame_hash);
    let mut encoder = Encoder::new();
    encoder.object_entries(&ordered)?;
    let mut framed = Vec::with_capacity(encoder.bytes.len().saturating_add(1));
    framed.push(STORAGE_MAGIC);
    framed.extend_from_slice(&encoder.bytes);
    Ok(framed)
}

pub(crate) fn decode_framed(bytes: &[u8]) -> Result<Value, RuntimeTransportError> {
    crate::decode_storage_payload(bytes)
        .map_err(|error| RuntimeTransportError::MessagePack(error.to_string()))
}
