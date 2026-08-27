//! Decoder for the canonical `msgpackr` storage profile used by xln LevelDB.
//!
//! This is not a JSON parser. `serde_json::Value` is used only as the existing
//! validated boundary value tree while the Runtime replay is brought online;
//! production bytes enter here directly from LevelDB (`0x03 || msgpackr`).

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use num_bigint::BigInt;
use serde_json::{Map, Number, Value};
use thiserror::Error;

const STORAGE_MAGIC: u8 = 0x03;
const RECORD_BASE: u8 = 0x40;
const MAX_DEPTH: usize = 256;
const MAX_CONTAINER_ENTRIES: usize = 2_000_000;
const JS_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StorageMessagePackError {
    #[error("RUNTIME_STORAGE_MSGPACK_MAGIC:{0}")]
    Magic(u8),
    #[error("RUNTIME_STORAGE_MSGPACK_TRUNCATED:offset={offset}:needed={needed}")]
    Truncated { offset: usize, needed: usize },
    #[error("RUNTIME_STORAGE_MSGPACK_MARKER:offset={offset}:marker={marker:#04x}")]
    Marker { offset: usize, marker: u8 },
    #[error("RUNTIME_STORAGE_MSGPACK_UTF8:offset={0}")]
    Utf8(usize),
    #[error("RUNTIME_STORAGE_MSGPACK_NUMBER:{0}")]
    Number(String),
    #[error("RUNTIME_STORAGE_MSGPACK_CONTAINER:{0}")]
    Container(usize),
    #[error("RUNTIME_STORAGE_MSGPACK_DEPTH")]
    Depth,
    #[error("RUNTIME_STORAGE_MSGPACK_RECORD_ID:{0:#04x}")]
    RecordId(u8),
    #[error("RUNTIME_STORAGE_MSGPACK_RECORD_KEYS")]
    RecordKeys,
    #[error("RUNTIME_STORAGE_MSGPACK_EXTENSION:type={extension_type}:length={length}")]
    Extension { extension_type: i8, length: usize },
    #[error("RUNTIME_STORAGE_MSGPACK_TRAILING:{0}")]
    Trailing(usize),
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    records: Vec<Option<Vec<String>>>,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            records: Vec::new(),
        }
    }

    /// Refuse a container whose claimed arity cannot fit in the unread input.
    /// Every array element (and every map key and value) costs at least one
    /// marker byte, so a larger claim is guaranteed to end in `Truncated`
    /// anyway — checking it here keeps the `with_capacity` reservation
    /// proportional to the payload instead of the adversarially claimed
    /// arity (a 41-byte input claiming 2M-entry arrays per level otherwise
    /// reserves hundreds of MiB before the first failure).
    fn require_fits_input(&self, claimed_bytes: usize) -> Result<(), StorageMessagePackError> {
        if self.bytes.len() - self.offset < claimed_bytes {
            return Err(StorageMessagePackError::Truncated {
                offset: self.offset,
                needed: claimed_bytes,
            });
        }
        Ok(())
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], StorageMessagePackError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(StorageMessagePackError::Truncated {
                offset: self.offset,
                needed: length,
            })?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(StorageMessagePackError::Truncated {
                offset: self.offset,
                needed: length,
            })?;
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, StorageMessagePackError> {
        Ok(self.take(1)?[0])
    }

    fn fixed<const N: usize>(&mut self) -> Result<[u8; N], StorageMessagePackError> {
        let offset = self.offset;
        self.take(N)?
            .try_into()
            .map_err(|_| StorageMessagePackError::Truncated { offset, needed: N })
    }

    fn length(&mut self, bytes: usize) -> Result<usize, StorageMessagePackError> {
        let raw = self.take(bytes)?;
        let value = match bytes {
            1 => u64::from(raw[0]),
            2 => u64::from(u16::from_be_bytes([raw[0], raw[1]])),
            4 => u64::from(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])),
            _ => return Err(StorageMessagePackError::Container(bytes)),
        };
        let value =
            usize::try_from(value).map_err(|_| StorageMessagePackError::Container(usize::MAX))?;
        if value > MAX_CONTAINER_ENTRIES {
            return Err(StorageMessagePackError::Container(value));
        }
        Ok(value)
    }

    fn string(&mut self, length: usize) -> Result<Value, StorageMessagePackError> {
        let offset = self.offset;
        let value = std::str::from_utf8(self.take(length)?)
            .map_err(|_| StorageMessagePackError::Utf8(offset))?;
        Ok(Value::String(value.to_owned()))
    }

    fn array(&mut self, length: usize, depth: usize) -> Result<Value, StorageMessagePackError> {
        self.require_fits_input(length)?;
        let mut output = Vec::with_capacity(length);
        for _ in 0..length {
            output.push(self.value(depth + 1)?);
        }
        Ok(Value::Array(output))
    }

    fn map(&mut self, length: usize, depth: usize) -> Result<Value, StorageMessagePackError> {
        // Each entry holds a key and a value: two markers minimum.
        self.require_fits_input(length.saturating_mul(2))?;
        let mut rows = Vec::with_capacity(length);
        for _ in 0..length {
            rows.push(Value::Array(vec![
                self.value(depth + 1)?,
                self.value(depth + 1)?,
            ]));
        }
        Ok(tagged("Map", Value::Array(rows)))
    }

    fn record(&mut self, id: u8, depth: usize) -> Result<Value, StorageMessagePackError> {
        let index = usize::from(id.saturating_sub(RECORD_BASE));
        let keys = self
            .records
            .get(index)
            .and_then(Clone::clone)
            .ok_or(StorageMessagePackError::RecordId(id))?;
        let mut output = Map::new();
        for key in keys {
            output.insert(key, self.value(depth + 1)?);
        }
        Ok(Value::Object(output))
    }

    fn record_definition(
        &mut self,
        payload: &[u8],
        depth: usize,
    ) -> Result<Value, StorageMessagePackError> {
        let [id] = payload else {
            return Err(StorageMessagePackError::RecordKeys);
        };
        if !(RECORD_BASE..0x80).contains(id) {
            return Err(StorageMessagePackError::RecordId(*id));
        }
        let Value::Array(values) = self.value(depth + 1)? else {
            return Err(StorageMessagePackError::RecordKeys);
        };
        let keys = values
            .into_iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(StorageMessagePackError::RecordKeys)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let index = usize::from(*id - RECORD_BASE);
        if self.records.len() <= index {
            self.records.resize(index + 1, None);
        }
        self.records[index] = Some(keys);
        self.record(*id, depth)
    }

    fn extension(&mut self, length: usize, depth: usize) -> Result<Value, StorageMessagePackError> {
        let extension_type = self.byte()? as i8;
        let payload = self.take(length)?.to_vec();
        match extension_type {
            0x72 => self.record_definition(&payload, depth),
            0x73 if payload == [0] => match self.value(depth + 1)? {
                Value::Array(values) => Ok(tagged("Set", Value::Array(values))),
                _ => Err(StorageMessagePackError::RecordKeys),
            },
            0x42 if payload.len() == 16 => {
                let bytes: [u8; 16] =
                    payload
                        .try_into()
                        .map_err(|_| StorageMessagePackError::Extension {
                            extension_type,
                            length,
                        })?;
                Ok(bigint(BigInt::from(i128::from_be_bytes(bytes))))
            }
            0x74 if !payload.is_empty() => typed_array(payload[0], &payload[1..]),
            _ => Err(StorageMessagePackError::Extension {
                extension_type,
                length,
            }),
        }
    }

    fn float(&mut self, bits: u64) -> Result<Value, StorageMessagePackError> {
        let value = f64::from_bits(bits);
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= JS_MAX_SAFE_INTEGER {
            if value >= 0.0 {
                return Ok(Value::Number(Number::from(value as u64)));
            }
            return Ok(Value::Number(Number::from(value as i64)));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| StorageMessagePackError::Number(value.to_string()))
    }

    fn value(&mut self, depth: usize) -> Result<Value, StorageMessagePackError> {
        if depth > MAX_DEPTH {
            return Err(StorageMessagePackError::Depth);
        }
        let marker_offset = self.offset;
        let marker = self.byte()?;
        match marker {
            0x00..=0x3f => Ok(Value::Number(Number::from(marker))),
            0x40..=0x7f
                if self
                    .records
                    .get(usize::from(marker - RECORD_BASE))
                    .is_some_and(Option::is_some) =>
            {
                self.record(marker, depth)
            }
            0x40..=0x7f => Ok(Value::Number(Number::from(marker))),
            0x80..=0x8f => self.map(usize::from(marker & 0x0f), depth),
            0x90..=0x9f => self.array(usize::from(marker & 0x0f), depth),
            0xa0..=0xbf => self.string(usize::from(marker & 0x1f)),
            0xc0 => Ok(Value::Null),
            0xc2 => Ok(Value::Bool(false)),
            0xc3 => Ok(Value::Bool(true)),
            0xc4 => {
                let length = self.length(1)?;
                self.binary(length)
            }
            0xc5 => {
                let length = self.length(2)?;
                self.binary(length)
            }
            0xc6 => {
                let length = self.length(4)?;
                self.binary(length)
            }
            0xc7 => {
                let length = self.length(1)?;
                self.extension(length, depth)
            }
            0xc8 => {
                let length = self.length(2)?;
                self.extension(length, depth)
            }
            0xc9 => {
                let length = self.length(4)?;
                self.extension(length, depth)
            }
            0xca => {
                let raw: [u8; 4] =
                    self.take(4)?
                        .try_into()
                        .map_err(|_| StorageMessagePackError::Truncated {
                            offset: self.offset,
                            needed: 4,
                        })?;
                float_value(f64::from(f32::from_bits(u32::from_be_bytes(raw))))
            }
            0xcb => {
                let raw = self.fixed()?;
                self.float(u64::from_be_bytes(raw))
            }
            0xcc => Ok(Value::Number(Number::from(self.byte()?))),
            0xcd => Ok(Value::Number(Number::from(u16::from_be_bytes(
                self.take(2)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 2,
                    })?,
            )))),
            0xce => Ok(Value::Number(Number::from(u32::from_be_bytes(
                self.take(4)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 4,
                    })?,
            )))),
            0xcf => Ok(bigint(BigInt::from(u64::from_be_bytes(
                self.take(8)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 8,
                    })?,
            )))),
            0xd0 => Ok(Value::Number(Number::from(i8::from_be_bytes([
                self.byte()?
            ])))),
            0xd1 => Ok(Value::Number(Number::from(i16::from_be_bytes(
                self.take(2)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 2,
                    })?,
            )))),
            0xd2 => Ok(Value::Number(Number::from(i32::from_be_bytes(
                self.take(4)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 4,
                    })?,
            )))),
            0xd3 => Ok(bigint(BigInt::from(i64::from_be_bytes(
                self.take(8)?
                    .try_into()
                    .map_err(|_| StorageMessagePackError::Truncated {
                        offset: self.offset,
                        needed: 8,
                    })?,
            )))),
            0xd4 => self.extension(1, depth),
            0xd5 => self.extension(2, depth),
            0xd6 => self.extension(4, depth),
            0xd7 => self.extension(8, depth),
            0xd8 => self.extension(16, depth),
            0xd9 => {
                let length = self.length(1)?;
                self.string(length)
            }
            0xda => {
                let length = self.length(2)?;
                self.string(length)
            }
            0xdb => {
                let length = self.length(4)?;
                self.string(length)
            }
            0xdc => {
                let length = self.length(2)?;
                self.array(length, depth)
            }
            0xdd => {
                let length = self.length(4)?;
                self.array(length, depth)
            }
            0xde => {
                let length = self.length(2)?;
                self.map(length, depth)
            }
            0xdf => {
                let length = self.length(4)?;
                self.map(length, depth)
            }
            0xe0..=0xff => Ok(Value::Number(Number::from(i8::from_be_bytes([marker])))),
            _ => Err(StorageMessagePackError::Marker {
                offset: marker_offset,
                marker,
            }),
        }
    }

    fn binary(&mut self, length: usize) -> Result<Value, StorageMessagePackError> {
        let bytes = self.take(length)?;
        typed_array(1, bytes)
    }
}

fn tagged(kind: &str, value: Value) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".to_string(), Value::String(kind.to_string())),
        ("value".to_string(), value),
    ]))
}

fn float_value(value: f64) -> Result<Value, StorageMessagePackError> {
    Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| StorageMessagePackError::Number(value.to_string()))
}

fn bigint(value: BigInt) -> Value {
    tagged("BigInt", Value::String(value.to_string()))
}

fn typed_array(kind: u8, bytes: &[u8]) -> Result<Value, StorageMessagePackError> {
    let name = match kind {
        1 => "Uint8Array",
        _ => {
            return Err(StorageMessagePackError::Extension {
                extension_type: 0x74,
                length: bytes.len().saturating_add(1),
            });
        }
    };
    Ok(Value::Object(Map::from_iter([
        (
            "__xlnType".to_string(),
            Value::String("TypedArray".to_string()),
        ),
        ("kind".to_string(), Value::String(name.to_string())),
        ("value".to_string(), Value::String(BASE64.encode(bytes))),
    ])))
}

/// Decode exactly one magic-framed xln storage value.
pub fn decode_storage_payload(bytes: &[u8]) -> Result<Value, StorageMessagePackError> {
    let Some((&magic, body)) = bytes.split_first() else {
        return Err(StorageMessagePackError::Magic(0));
    };
    if magic != STORAGE_MAGIC {
        return Err(StorageMessagePackError::Magic(magic));
    }
    let mut decoder = Decoder::new(body);
    let value = decoder.value(0)?;
    if decoder.offset != body.len() {
        return Err(StorageMessagePackError::Trailing(
            body.len() - decoder.offset,
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("fixture hex"))
            .collect()
    }

    #[test]
    fn decodes_msgpackr_records_maps_sets_and_bigints() {
        let body = bytes(
            "d4724095a6626967696e74a36d6170a66f626a656374a3736574a776657273696f6ecfab54a98ceb1f0ad282a161d30000000000000001a17ad30000000000000002d4724192a161a17aa17802d4730092a161a17a01",
        );
        let mut payload = vec![STORAGE_MAGIC];
        payload.extend(body);
        let value = decode_storage_payload(&payload).expect("decode golden");
        assert_eq!(value["version"], Value::Number(Number::from(1)));
        assert_eq!(value["object"]["a"], Value::String("x".into()));
        assert_eq!(value["bigint"]["value"], "12345678901234567890");
        assert_eq!(value["map"]["__xlnType"], "Map");
        assert_eq!(value["set"]["__xlnType"], "Set");
    }

    #[test]
    fn reuses_record_shapes() {
        let mut payload = vec![STORAGE_MAGIC];
        payload.extend(bytes("92d4724091a178014002"));
        let value = decode_storage_payload(&payload).expect("decode records");
        assert_eq!(value[0]["x"], 1);
        assert_eq!(value[1]["x"], 2);
    }

    #[test]
    fn normalizes_exact_js_float_integers_without_rounding_fractional_values() {
        let mut exact = vec![STORAGE_MAGIC, 0xcb];
        exact.extend_from_slice(&1_784_000_000_000_f64.to_bits().to_be_bytes());
        assert_eq!(
            decode_storage_payload(&exact).expect("exact JS integer"),
            Value::Number(Number::from(1_784_000_000_000_u64)),
        );
        let fractional_bits = 1.5_f64.to_bits().to_be_bytes();
        let mut fractional = vec![STORAGE_MAGIC, 0xcb];
        fractional.extend_from_slice(&fractional_bits);
        assert_eq!(
            decode_storage_payload(&fractional).expect("fractional number"),
            Value::Number(Number::from_f64(1.5).expect("finite")),
        );
    }
}
