//! Canonical TypeScript-compatible physical layout for large path values.

use rusty_leveldb::DB;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::NativeStorageError;

pub(super) const MAX_PHYSICAL_VALUE_BYTES: usize = 10_000;
const CHUNK_PAYLOAD_BYTES: usize = 9_000;
const KEY_BOUNDED_VALUE_CHUNK: u8 = 0x11;
type PhysicalRow = (Vec<u8>, Vec<u8>);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Manifest {
    byte_length: usize,
    chunk_count: usize,
    digest: String,
}

pub(super) fn uses_generic_bounded_layout(key: &[u8]) -> bool {
    // 0x14 Entity-context rows: leaves and digest pages stay under one
    // physical value; the manifest's page lists grow with the frame and chunk.
    matches!(key.first(), Some(0x14 | 0x18 | 0x19))
}

pub(super) fn physical_rows(
    owner_key: &[u8],
    encoded: &[u8],
) -> Result<Vec<PhysicalRow>, NativeStorageError> {
    if !uses_generic_bounded_layout(owner_key) || encoded.len() < MAX_PHYSICAL_VALUE_BYTES {
        return Ok(vec![(owner_key.to_vec(), encoded.to_vec())]);
    }
    let chunk_count = encoded.len().div_ceil(CHUNK_PAYLOAD_BYTES);
    let digest = format_digest(&Sha256::digest(encoded));
    let manifest = CanonicalValue::Object(vec![
        (
            "byteLength".into(),
            CanonicalValue::Number(number(encoded.len(), "byteLength")?),
        ),
        (
            "chunkCount".into(),
            CanonicalValue::Number(number(chunk_count, "chunkCount")?),
        ),
        ("digest".into(), CanonicalValue::String(digest)),
        ("kind".into(), CanonicalValue::String("boundedValue".into())),
        (
            "version".into(),
            CanonicalValue::Number(number(1, "version")?),
        ),
    ]);
    let owner_value = crate::encode_storage_payload(&manifest)?;
    if owner_value.len() >= MAX_PHYSICAL_VALUE_BYTES {
        return Err(NativeStorageError::BoundedValue("MANIFEST_BYTES".into()));
    }
    let mut rows = Vec::with_capacity(chunk_count + 1);
    rows.push((owner_key.to_vec(), owner_value));
    for (index, chunk) in encoded.chunks(CHUNK_PAYLOAD_BYTES).enumerate() {
        rows.push((chunk_key(owner_key, index)?, chunk.to_vec()));
    }
    Ok(rows)
}

pub(super) fn previous_physical_keys(
    database: &mut DB,
    owner_key: &[u8],
) -> Result<Vec<Vec<u8>>, NativeStorageError> {
    let Some(owner_value) = database.get(owner_key).map(|value| value.to_vec()) else {
        return Ok(Vec::new());
    };
    let mut keys = Vec::new();
    if let Some(manifest) = decode_manifest(&owner_value)? {
        for index in 0..manifest.chunk_count {
            let key = chunk_key(owner_key, index)?;
            if database.get(&key).is_none() {
                return Err(NativeStorageError::BoundedValue(format!(
                    "CHUNK_MISSING:{index}",
                )));
            }
            keys.push(key);
        }
    }
    keys.push(owner_key.to_vec());
    Ok(keys)
}

/// Derive the exact physical keys from the already-verified logical value in
/// the resident checkpoint cache. The hot checkpoint path must not re-read
/// every owner row (and every chunk) from LevelDB before overwriting it.
pub(super) fn physical_keys_for_value(
    owner_key: &[u8],
    encoded: &[u8],
) -> Result<Vec<Vec<u8>>, NativeStorageError> {
    let mut keys = Vec::new();
    if uses_generic_bounded_layout(owner_key) && encoded.len() >= MAX_PHYSICAL_VALUE_BYTES {
        for index in 0..encoded.len().div_ceil(CHUNK_PAYLOAD_BYTES) {
            keys.push(chunk_key(owner_key, index)?);
        }
    }
    keys.push(owner_key.to_vec());
    Ok(keys)
}

pub(super) fn collapse(
    database: &mut DB,
    owner_key: &[u8],
    owner_value: &[u8],
) -> Result<Vec<u8>, NativeStorageError> {
    let Some(manifest) = decode_manifest(owner_value)? else {
        return Ok(owner_value.to_vec());
    };
    if !uses_generic_bounded_layout(owner_key) {
        return Err(NativeStorageError::BoundedValue("OWNER_NAMESPACE".into()));
    }
    let mut bytes = Vec::with_capacity(manifest.byte_length);
    for index in 0..manifest.chunk_count {
        let key = chunk_key(owner_key, index)?;
        let chunk = database
            .get(&key)
            .map(|value| value.to_vec())
            .ok_or_else(|| NativeStorageError::BoundedValue(format!("CHUNK_MISSING:{index}")))?;
        let expected = (manifest.byte_length - bytes.len()).min(CHUNK_PAYLOAD_BYTES);
        if chunk.len() != expected {
            return Err(NativeStorageError::BoundedValue(format!(
                "CHUNK_BYTES:{index}:{}:{expected}",
                chunk.len(),
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != manifest.byte_length {
        return Err(NativeStorageError::BoundedValue("BYTE_LENGTH".into()));
    }
    let actual = format_digest(&Sha256::digest(&bytes));
    if actual != manifest.digest {
        return Err(NativeStorageError::BoundedValue("DIGEST".into()));
    }
    Ok(bytes)
}

fn decode_manifest(encoded: &[u8]) -> Result<Option<Manifest>, NativeStorageError> {
    let value = crate::decode_storage_payload(encoded)?;
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object.get("kind").and_then(Value::as_str) != Some("boundedValue") {
        return Ok(None);
    }
    if object.len() != 5
        || !["kind", "version", "byteLength", "chunkCount", "digest"]
            .iter()
            .all(|field| object.contains_key(*field))
        || object.get("version").and_then(Value::as_u64) != Some(1)
    {
        return Err(NativeStorageError::BoundedValue("MANIFEST_FIELDS".into()));
    }
    let byte_length = object
        .get("byteLength")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value >= MAX_PHYSICAL_VALUE_BYTES)
        .ok_or_else(|| NativeStorageError::BoundedValue("BYTE_LENGTH".into()))?;
    let chunk_count = object
        .get("chunkCount")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value == byte_length.div_ceil(CHUNK_PAYLOAD_BYTES))
        .ok_or_else(|| NativeStorageError::BoundedValue("CHUNK_COUNT".into()))?;
    let digest = object
        .get("digest")
        .and_then(Value::as_str)
        .filter(|value| valid_digest(value))
        .ok_or_else(|| NativeStorageError::BoundedValue("DIGEST_FORMAT".into()))?
        .to_ascii_lowercase();
    Ok(Some(Manifest {
        byte_length,
        chunk_count,
        digest,
    }))
}

fn chunk_key(owner_key: &[u8], index: usize) -> Result<Vec<u8>, NativeStorageError> {
    let owner_length = u16::try_from(owner_key.len())
        .map_err(|_| NativeStorageError::BoundedValue("OWNER_KEY_LENGTH".into()))?;
    let index =
        u32::try_from(index).map_err(|_| NativeStorageError::BoundedValue("CHUNK_INDEX".into()))?;
    let mut key = Vec::with_capacity(3 + owner_key.len() + 4);
    key.push(KEY_BOUNDED_VALUE_CHUNK);
    key.extend_from_slice(&owner_length.to_be_bytes());
    key.extend_from_slice(owner_key);
    key.extend_from_slice(&index.to_be_bytes());
    Ok(key)
}

fn number(value: usize, field: &'static str) -> Result<CanonicalNumber, NativeStorageError> {
    let value = u64::try_from(value)
        .map_err(|_| NativeStorageError::BoundedValue(format!("{field}:RANGE")))?;
    CanonicalNumber::try_from_u64(value)
        .map_err(|_| NativeStorageError::BoundedValue(format!("{field}:SAFE_INTEGER")))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value.as_bytes()[2..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn format_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_bytes_match_the_typescript_golden() {
        let mut owner = vec![0x18];
        owner.extend_from_slice(&[0; 64]);
        let rows = physical_rows(&owner, &vec![0x5a; 10_000]).expect("rows");
        assert_eq!(rows.len(), 3);
        assert_eq!(
            hex(&rows[0].1),
            "03d4724095aa627974654c656e677468aa6368756e6b436f756e74a6646967657374a46b696e64a776657273696f6ecd271002c720482fa3eb87256b150eb851e6eb6e679eafb0151f8944f5e16e9cac6a67d424a67fac626f756e64656456616c756501",
        );
        assert_eq!(rows[1].1.len(), 9_000);
        assert_eq!(rows[2].1.len(), 1_000);
    }

    #[test]
    fn resident_logical_value_derives_the_same_physical_keys_as_encoding() {
        let mut owner = vec![0x18];
        owner.extend_from_slice(&[0x42; 64]);
        for value in [vec![0x5a; 99], vec![0x5a; 10_000], vec![0x5a; 27_001]] {
            let mut encoded = physical_rows(&owner, &value)
                .expect("physical rows")
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>();
            let mut resident = physical_keys_for_value(&owner, &value).expect("resident keys");
            encoded.sort();
            resident.sort();
            assert_eq!(resident, encoded);
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
