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
