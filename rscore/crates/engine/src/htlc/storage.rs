use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalValue, encode_account_state_value, encode_raw_text_key};

use super::boundary::hex_32;
use crate::{HtlcLock, StateError};

const MAX_ACCOUNT_STATE_LEAF_BYTES: usize = 10_000;

pub fn htlc_lock_radix_key(lock_id: &str) -> Result<Vec<u8>, StateError> {
    encode_raw_text_key(lock_id).map_err(|error| StateError::PersistentMap(error.to_string()))
}

pub fn encode_htlc_lock_value(lock: &HtlcLock) -> Result<Vec<u8>, StateError> {
    let mut fields = vec![
        (
            "lockId".into(),
            CanonicalValue::String(lock.lock_id().into()),
        ),
        (
            "hashlock".into(),
            CanonicalValue::String(lock.hashlock().as_str().into()),
        ),
        (
            "timelock".into(),
            CanonicalValue::BigInt(lock.timelock().clone()),
        ),
        (
            "revealBeforeHeight".into(),
            CanonicalValue::Number(lock.reveal_before_height() as f64),
        ),
        (
            "amount".into(),
            CanonicalValue::BigInt(lock.amount().clone()),
        ),
        (
            "tokenId".into(),
            CanonicalValue::Number(f64::from(lock.token_id().get())),
        ),
        (
            "senderIsLeft".into(),
            CanonicalValue::Bool(lock.sender() == crate::Side::Left),
        ),
        (
            "createdHeight".into(),
            CanonicalValue::Number(lock.created_height() as f64),
        ),
        (
            "createdTimestamp".into(),
            CanonicalValue::Number(lock.created_timestamp() as f64),
        ),
    ];
    if let Some(hash) = lock.envelope_hash() {
        fields.push(("envelopeHash".into(), CanonicalValue::String(hex_32(hash))));
    }
    let encoded = encode_account_state_value(&CanonicalValue::Object(fields))
        .map_err(|error| StateError::PersistentMap(error.to_string()))?;
    if encoded.len() > MAX_ACCOUNT_STATE_LEAF_BYTES {
        return Err(StateError::AccountStateLeafTooLarge {
            actual: encoded.len(),
            maximum: MAX_ACCOUNT_STATE_LEAF_BYTES,
        });
    }
    Ok(encoded)
}

pub fn htlc_lock_value_digest(lock: &HtlcLock) -> Result<[u8; 32], StateError> {
    Ok(Sha256::digest(encode_htlc_lock_value(lock)?).into())
}
