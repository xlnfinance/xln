use sha2::{Digest, Sha256};

use crate::{ABI_DOMAIN, MessageKind, OpTag};

pub fn compute_body_digest(
    protocol_fingerprint: &[u8; 32],
    runtime_id: &[u8; 20],
    op_tag: OpTag,
    message_kind: MessageKind,
    body_bytes: &[u8],
) -> Result<[u8; 32], crate::AbiError> {
    let body_len = u32::try_from(body_bytes.len()).map_err(|_| crate::AbiError::LengthOverflow)?;
    let mut hasher = Sha256::new();
    hasher.update(ABI_DOMAIN.as_bytes());
    hasher.update(protocol_fingerprint);
    hasher.update(runtime_id);
    hasher.update([op_tag as u8]);
    hasher.update([message_kind as u8]);
    hasher.update(body_len.to_be_bytes());
    hasher.update(body_bytes);
    Ok(hasher.finalize().into())
}

/// Canonical bytes of a standalone tuple, for a digest two languages must
/// agree on. It is the same writer the envelope body uses — minimal integer
/// widths, bin8/16/32, fixstr/str8+ — so a TypeScript encoder that already
/// round-trips against this ABI reproduces these bytes exactly.
pub fn encode_tuple(tuple: &crate::BodyTuple) -> Result<Vec<u8>, crate::AbiError> {
    crate::msgpack_encode::encode_body_tuple(tuple, &crate::AbiLimits::default())
}

/// One standalone value from its canonical bytes, and back. The wire is a
/// contract with another language, so both directions are exposed for the
/// vector tests that hold this ABI to bytes TypeScript wrote.
pub fn decode_value(bytes: &[u8]) -> Result<crate::AbiValue, crate::AbiError> {
    let limits = crate::AbiLimits::default();
    let mut parser = crate::msgpack_parser::Parser::new(bytes, &limits);
    let value = parser.read_standalone_value()?;
    if parser.remaining() != 0 {
        return Err(crate::AbiError::TrailingBytes(parser.remaining()));
    }
    Ok(value)
}

pub fn encode_value(value: &crate::AbiValue) -> Result<Vec<u8>, crate::AbiError> {
    let tuple = crate::BodyTuple::from_array([value.clone()]);
    let encoded = encode_tuple(&tuple)?;
    // `encode_tuple` writes a one-element array header first; the value's own
    // bytes are what follows it.
    Ok(encoded[1..].to_vec())
}
