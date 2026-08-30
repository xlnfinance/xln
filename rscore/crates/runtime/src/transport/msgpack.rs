//! `msgpackr` value-only encoder used by the canonical Runtime socket.

use num_bigint::{BigInt, Sign};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};

use super::RuntimeTransportError;

const HEX_BYTES_EXTENSION: u8 = 0x48;
const HEX_BYTES_MIN_LENGTH: usize = 16;

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn canonical_hex_payload(value: &str) -> Option<&[u8]> {
    let bytes = value.as_bytes();
    let payload = bytes.strip_prefix(b"0x")?;
    if payload.len() < HEX_BYTES_MIN_LENGTH * 2 || payload.len() % 2 != 0 {
        return None;
    }
    payload
        .iter()
        .all(|byte| hex_nibble(*byte).is_some())
        .then_some(payload)
}

mod tagged;

const RECORD_BASE: u8 = 0x40;
const RECORD_LIMIT: usize = 64;
const STORAGE_MAGIC: u8 = 0x03;

struct Encoder {
    bytes: Vec<u8>,
    shapes: Vec<Vec<String>>,
    shape_indexes: HashMap<u64, Vec<usize>>,
}

impl Encoder {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            shapes: Vec::new(),
            shape_indexes: HashMap::new(),
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

    fn plain_string(&mut self, value: &str) -> Result<(), RuntimeTransportError> {
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

    fn string(&mut self, value: &str) -> Result<(), RuntimeTransportError> {
        if let Some(payload) = canonical_hex_payload(value) {
            let length = payload.len() / 2;
            self.extension_header(HEX_BYTES_EXTENSION, length)?;
            self.bytes.reserve(length);
            for pair in payload.chunks_exact(2) {
                self.bytes.push(
                    (hex_nibble(pair[0]).expect("validated hex") << 4)
                        | hex_nibble(pair[1]).expect("validated hex"),
                );
            }
            return Ok(());
        }
        self.plain_string(value)
    }

    fn array_len(&mut self, length: usize) -> Result<(), RuntimeTransportError> {
        self.length(length, 0x90, 15, 0xdc, 0xdd)
    }

    fn map_len(&mut self, length: usize) -> Result<(), RuntimeTransportError> {
        self.length(length, 0x80, 15, 0xde, 0xdf)
    }

    fn extension(&mut self, kind: u8, payload: &[u8]) -> Result<(), RuntimeTransportError> {
        self.extension_header(kind, payload.len())?;
        self.bytes.extend_from_slice(payload);
        Ok(())
    }

    fn extension_header(
        &mut self,
        kind: u8,
        payload_length: usize,
    ) -> Result<(), RuntimeTransportError> {
        match payload_length {
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
        if let Ok(value) = value.parse::<i64>() {
            self.bytes.push(0xd3);
            self.bytes.extend_from_slice(&value.to_be_bytes());
            return Ok(());
        }
        if let Ok(value) = value.parse::<u64>() {
            self.bytes.push(0xcf);
            self.bytes.extend_from_slice(&value.to_be_bytes());
            return Ok(());
        }
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
        if object.keys().all(|key| key.is_ascii()) {
            return self.object_map(object);
        }
        let mut ordered = object.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
        self.object_entries(&ordered)
    }

    fn object_map(
        &mut self,
        object: &serde_json::Map<String, Value>,
    ) -> Result<(), RuntimeTransportError> {
        let shape_hash = shape_hash(object.keys().map(String::as_str));
        let existing = self.shape_indexes.get(&shape_hash).and_then(|indexes| {
            indexes.iter().copied().find(|index| {
                self.shapes[*index]
                    .iter()
                    .map(String::as_str)
                    .eq(object.keys().map(String::as_str))
            })
        });
        if let Some(index) = existing {
            self.bytes.push(RECORD_BASE + index as u8);
        } else {
            self.define_object_shape(object.keys().cloned().collect(), shape_hash)?;
        }
        for value in object.values() {
            self.value(value)?;
        }
        Ok(())
    }

    fn object_entries(
        &mut self,
        ordered: &[(&String, &Value)],
    ) -> Result<(), RuntimeTransportError> {
        let shape_hash = shape_hash(ordered.iter().map(|(key, _)| key.as_str()));
        let existing = self.shape_indexes.get(&shape_hash).and_then(|indexes| {
            indexes.iter().copied().find(|index| {
                self.shapes[*index]
                    .iter()
                    .map(String::as_str)
                    .eq(ordered.iter().map(|(key, _)| key.as_str()))
            })
        });
        if let Some(index) = existing {
            self.bytes.push(RECORD_BASE + index as u8);
        } else {
            self.define_object_shape(
                ordered.iter().map(|(key, _)| (*key).clone()).collect(),
                shape_hash,
            )?;
        }
        for (_, value) in ordered {
            self.value(value)?;
        }
        Ok(())
    }

    fn object_header(&mut self, keys: &[String]) -> Result<(), RuntimeTransportError> {
        let shape_hash = shape_hash(keys.iter().map(String::as_str));
        if let Some(index) = self.shape_indexes.get(&shape_hash).and_then(|indexes| {
            indexes
                .iter()
                .copied()
                .find(|index| self.shapes[*index].as_slice() == keys)
        }) {
            self.bytes.push(RECORD_BASE + index as u8);
        } else {
            self.define_object_shape(keys.to_vec(), shape_hash)?;
        }
        Ok(())
    }

    fn define_object_shape(
        &mut self,
        keys: Vec<String>,
        shape_hash: u64,
    ) -> Result<(), RuntimeTransportError> {
        if self.shapes.len() >= RECORD_LIMIT {
            return Err(RuntimeTransportError::MessagePack("record-limit".into()));
        }
        let index = self.shapes.len();
        let record = RECORD_BASE + index as u8;
        self.extension(0x72, &[record])?;
        self.array_len(keys.len())?;
        for key in &keys {
            // msgpackr record keys are JavaScript property names, not values.
            // Even a hex-looking property name stays a string.
            self.plain_string(key)?;
        }
        self.shapes.push(keys);
        self.shape_indexes
            .entry(shape_hash)
            .or_default()
            .push(index);
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

fn shape_hash<'a>(keys: impl Iterator<Item = &'a str>) -> u64 {
    let mut hasher = DefaultHasher::new();
    for key in keys {
        key.hash(&mut hasher);
    }
    hasher.finish()
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

/// Encode the Runtime-frame hash preimage and stored frame with one traversal
/// of every nested RuntimeInput value. The two top-level record shapes differ
/// only by `kind` versus the final `frameHash`; all base fields and nested
/// msgpackr record definitions are byte-identical and are reused directly.
pub(crate) fn encode_and_hash_framed_runtime_frame(
    fields: &serde_json::Map<String, Value>,
    domain: &str,
) -> Result<([u8; 32], Vec<u8>), RuntimeTransportError> {
    if fields.contains_key("kind") || fields.contains_key("frameHash") {
        return Err(RuntimeTransportError::MessagePack(
            "runtime-frame-base-fields".into(),
        ));
    }
    let mut ordered = fields.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));

    let mut stored_keys = ordered
        .iter()
        .map(|(key, _)| (*key).clone())
        .collect::<Vec<_>>();
    stored_keys.push("frameHash".into());
    let mut stored = Encoder::new();
    stored.object_header(&stored_keys)?;
    let mut value_ranges = Vec::with_capacity(ordered.len());
    for (_, value) in &ordered {
        let start = stored.bytes.len();
        stored.value(value)?;
        value_ranges.push(start..stored.bytes.len());
    }

    let mut hash_keys = ordered
        .iter()
        .map(|(key, _)| (*key).clone())
        .collect::<Vec<_>>();
    hash_keys.push("kind".into());
    let inserted_empty_entity_hashes = !fields.contains_key("canonicalEntityHashes");
    if inserted_empty_entity_hashes {
        hash_keys.push("canonicalEntityHashes".into());
    }
    hash_keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let mut hash_header = Encoder::new();
    hash_header.object_header(&hash_keys)?;
    let mut kind_value = Encoder::new();
    kind_value.string(domain)?;
    // The stored encoder already owns every potentially multi-megabyte field.
    // Hash those exact byte ranges directly instead of copying the complete
    // Runtime input into a second preimage buffer. The logical byte stream is
    // unchanged; only the transient duplicate allocation is removed.
    let mut frame_digest = Sha256::new();
    frame_digest.update([STORAGE_MAGIC]);
    frame_digest.update(&hash_header.bytes);
    let mut base_index = 0;
    for key in &hash_keys {
        if key == "kind" {
            frame_digest.update(&kind_value.bytes);
        } else if inserted_empty_entity_hashes && key == "canonicalEntityHashes" {
            frame_digest.update([0x90]);
        } else if let Some(range) = value_ranges.get(base_index) {
            frame_digest.update(&stored.bytes[range.clone()]);
            base_index += 1;
        } else {
            return Err(RuntimeTransportError::MessagePack(
                "runtime-frame-hash-fields".into(),
            ));
        }
    }
    if base_index != ordered.len() {
        return Err(RuntimeTransportError::MessagePack(
            "runtime-frame-hash-cardinality".into(),
        ));
    }
    let frame_hash: [u8; 32] = frame_digest.finalize().into();

    let mut frame_hash_text = String::with_capacity(66);
    frame_hash_text.push_str("0x");
    for byte in frame_hash {
        use std::fmt::Write as _;
        write!(&mut frame_hash_text, "{byte:02x}")
            .expect("writing a digest into String cannot fail");
    }
    stored.string(&frame_hash_text)?;
    let mut framed = Vec::with_capacity(stored.bytes.len().saturating_add(1));
    framed.push(STORAGE_MAGIC);
    framed.extend_from_slice(&stored.bytes);
    Ok((frame_hash, framed))
}

pub(crate) fn decode_framed(bytes: &[u8]) -> Result<Value, RuntimeTransportError> {
    crate::decode_storage_payload(bytes)
        .map_err(|error| RuntimeTransportError::MessagePack(error.to_string()))
}

pub(crate) fn decode_transport(bytes: &[u8]) -> Result<Value, RuntimeTransportError> {
    crate::storage_msgpack::decode_transport_payload(bytes)
        .map_err(|error| RuntimeTransportError::MessagePack(error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use sha2::{Digest as _, Sha256};

    use super::*;

    fn assert_one_pass_matches_two_pass(mut fields: Map<String, Value>) {
        let domain = "xln-runtime-frame-v1";
        let mut hash_fields = fields.clone();
        hash_fields.insert("kind".into(), Value::String(domain.into()));
        hash_fields
            .entry("canonicalEntityHashes")
            .or_insert_with(|| Value::Array(vec![]));
        let expected_hash: [u8; 32] =
            Sha256::digest(encode_framed(&Value::Object(hash_fields)).expect("old hash preimage"))
                .into();
        fields.insert(
            "frameHash".into(),
            Value::String(format!("0x{}", hex::encode(expected_hash))),
        );
        let expected_bytes =
            encode_framed_runtime_frame(&Value::Object(fields)).expect("old frame bytes");
        let mut base = match decode_framed(&expected_bytes).expect("decode old frame") {
            Value::Object(base) => base,
            _ => panic!("frame object"),
        };
        base.remove("frameHash");
        let (actual_hash, actual_bytes) =
            encode_and_hash_framed_runtime_frame(&base, domain).expect("one pass");
        assert_eq!(actual_hash, expected_hash);
        assert_eq!(actual_bytes, expected_bytes);
    }

    #[test]
    fn one_pass_runtime_frame_encoding_preserves_exact_canonical_bytes() {
        let Value::Object(fields) = json!({
            "height": 7,
            "runtimeInput": {
                "runtimeTxs": [],
                "entityInputs": [
                    {"entityId": format!("0x{}", "11".repeat(32)), "txs": [{"type": "accountInput"}]},
                    {"entityId": format!("0x{}", "22".repeat(32)), "txs": [{"type": "accountInput"}]}
                ]
            },
            "touchedEntities": []
        }) else {
            unreachable!()
        };
        assert_one_pass_matches_two_pass(fields.clone());
        let mut with_entity_hashes = fields;
        with_entity_hashes.insert(
            "canonicalEntityHashes".into(),
            json!([{"entityId": format!("0x{}", "33".repeat(32)), "hash": format!("0x{}", "44".repeat(32))}]),
        );
        assert_one_pass_matches_two_pass(with_entity_hashes);
    }
}
