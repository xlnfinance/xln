use sha3::{Digest as _, Keccak256};
use thiserror::Error;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, ConsensusMessagePackError, encode_canonical_consensus_bytes,
};

pub(super) const BINARY_PAYLOAD_MAGIC: u8 = 0x03;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityEncodingError {
    #[error(transparent)]
    MessagePack(#[from] ConsensusMessagePackError),
    #[error("ENTITY_CONSENSUS_NUMBER_UNSAFE:{field}:{value}")]
    UnsafeNumber { field: &'static str, value: u64 },
}

pub(super) fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

pub(super) fn number(
    field: &'static str,
    value: u64,
) -> Result<CanonicalValue, EntityEncodingError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| EntityEncodingError::UnsafeNumber { field, value })
}

pub(super) fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

pub(super) fn binary_payload(value: &CanonicalValue) -> Result<Vec<u8>, EntityEncodingError> {
    let body = encode_canonical_consensus_bytes(value)?;
    let mut output = Vec::with_capacity(body.len() + 1);
    output.push(BINARY_PAYLOAD_MAGIC);
    output.extend_from_slice(&body);
    Ok(output)
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub(super) fn parse_digest(value: &str) -> Option<[u8; 32]> {
    let payload = value.strip_prefix("0x")?;
    if payload.len() != 64 {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, slot) in output.iter_mut().enumerate() {
        let offset = index * 2;
        *slot = u8::from_str_radix(&payload[offset..offset + 2], 16).ok()?;
    }
    (hex_digest(&output) == value).then_some(output)
}

pub(super) fn keccak_bytes(bytes: &[u8]) -> String {
    hex_digest(&Keccak256::digest(bytes))
}
