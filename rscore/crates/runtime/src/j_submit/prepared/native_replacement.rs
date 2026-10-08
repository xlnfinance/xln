//! Shared signed native expiry replacement witness for committed intents.
use super::prepared_wire::decode_prepared_transaction;
use serde_json::Value;
fn fail(name: &str) -> String {
    format!("TRON_REPLACEMENT_{name}")
}
pub(crate) fn exact(value: &Value, keys: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or_else(|| fail("FIELDS"))?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(fail("FIELDS"));
    }
    Ok(())
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| fail(key))
}
pub(crate) fn raw_hex(value: &str, expected: Option<usize>) -> Result<Vec<u8>, String> {
    let raw = value.strip_prefix("0x").ok_or_else(|| fail("HEX"))?;
    if raw.is_empty()
        || raw.len() > 524288
        || raw.len() % 2 != 0
        || !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(fail("HEX"));
    }
    let bytes = hex::decode(raw).map_err(|_| fail("HEX"))?;
    if expected.is_some_and(|length| length != bytes.len()) {
        return Err(fail("HEX_LENGTH"));
    }
    Ok(bytes)
}
pub(crate) fn number(value: &Value, key: &str) -> Result<u64, String> {
    value[key]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| fail(key))
}
pub(crate) fn validate_evidence(value: &Value) -> Result<(), String> {
    exact(
        value,
        &[
            "oldTransactionHash",
            "blockNumber",
            "blockHash",
            "timestamp",
        ],
    )?;
    for key in ["oldTransactionHash", "blockHash"] {
        raw_hex(text(value, key)?, Some(32))?;
    }
    number(value, "blockNumber")?;
    number(value, "timestamp")?;
    Ok(())
}
pub(crate) fn validate_native_replacement(
    old_raw: &str,
    raw: &str,
    previous: &str,
    evidence: &Value,
) -> Result<bool, String> {
    validate_evidence(evidence)?;
    raw_hex(previous, Some(32))?;
    let next = decode_prepared_transaction(raw, true).map_err(|e| e.to_string())?;
    let hash = format!("0x{}", hex::encode(next.hash));
    if evidence["oldTransactionHash"] != previous || hash == previous {
        return Err(fail("PREVIOUS_HASH_MISMATCH"));
    }
    let block = raw_hex(text(evidence, "blockHash")?, Some(32))?;
    let block_number = u64::from_be_bytes(block[..8].try_into().map_err(|_| fail("BLOCK_HASH"))?);
    let timestamp = number(evidence, "timestamp")?;
    let expires = next.expires_at.ok_or_else(|| fail("NATIVE_REQUIRED"))?;
    if block_number != number(evidence, "blockNumber")?
        || expires.saturating_sub(60000) < timestamp
        || expires <= timestamp
    {
        return Err(fail("EXPIRY_EVIDENCE_INVALID"));
    }
    // Same accepted target is idempotent; prior raw remains only in WAL history.
    if old_raw == raw {
        return Ok(true);
    }
    let old = decode_prepared_transaction(old_raw, true).map_err(|e| e.to_string())?;
    if format!("0x{}", hex::encode(old.hash)) != previous {
        return Err(fail("PREVIOUS_HASH_MISMATCH"));
    }
    if timestamp <= old.expires_at.ok_or_else(|| fail("NATIVE_REQUIRED"))? {
        return Err(fail("EXPIRY_EVIDENCE_INVALID"));
    }
    if old.signer != next.signer
        || old.to != next.to
        || old.value != next.value
        || old.data != next.data
    {
        return Err(fail("CALL_MISMATCH"));
    }
    Ok(false)
}
