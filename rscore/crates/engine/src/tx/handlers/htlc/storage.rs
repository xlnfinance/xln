use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_raw_text_key};

use super::boundary::hex_32;
use crate::state::encode_account_state_leaf;
use crate::{HtlcLock, StateError};

fn number(value: u64) -> Result<CanonicalValue, StateError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| StateError::PersistentMap(error.to_string()))
}

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
            number(lock.reveal_before_height())?,
        ),
        (
            "amount".into(),
            CanonicalValue::BigInt(lock.amount().clone()),
        ),
        (
            "tokenId".into(),
            CanonicalValue::Number(CanonicalNumber::from_u16(lock.token_id().get())),
        ),
        (
            "senderIsLeft".into(),
            CanonicalValue::Bool(lock.sender() == crate::Side::Left),
        ),
        ("createdHeight".into(), number(lock.created_height())?),
        ("createdTimestamp".into(), number(lock.created_timestamp())?),
    ];
    if let Some(hash) = lock.envelope_hash() {
        fields.push(("envelopeHash".into(), CanonicalValue::String(hex_32(hash))));
    }
    encode_account_state_leaf(&CanonicalValue::Object(fields))
}

pub fn htlc_lock_value_digest(lock: &HtlcLock) -> Result<[u8; 32], StateError> {
    Ok(Sha256::digest(encode_htlc_lock_value(lock)?).into())
}
