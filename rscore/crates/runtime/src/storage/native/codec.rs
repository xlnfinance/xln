//! Canonical frame/head/checkpoint codecs and ordered outbox commitment.

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::NativeStorageError;
use super::types::StorageHead;

const OUTBOX_DIGEST_DOMAIN: &[u8] = b"xln.runtime.outbox.v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn output_digest(rows: &[Vec<u8>]) -> Result<[u8; 32], NativeStorageError> {
    let count =
        u32::try_from(rows.len()).map_err(|_| NativeStorageError::OutputCount(rows.len()))?;
    let mut digest = Sha256::new();
    digest.update(OUTBOX_DIGEST_DOMAIN);
    digest.update(count.to_be_bytes());
    for row in rows {
        let length =
            u32::try_from(row.len()).map_err(|_| NativeStorageError::OutputBytes(row.len()))?;
        digest.update(length.to_be_bytes());
        digest.update(row);
    }
    Ok(digest.finalize().into())
}

pub(super) fn validate_storage_row(bytes: &[u8]) -> Result<(), NativeStorageError> {
    crate::decode_storage_payload(bytes)?;
    Ok(())
}

pub(super) fn encode_head(head: &StorageHead) -> Result<Vec<u8>, NativeStorageError> {
    let fields = vec![
        field("schemaVersion", head.schema_version)?,
        field("latestHeight", head.latest_height)?,
        field("latestMaterializedHeight", head.latest_materialized_height)?,
        field("latestSnapshotHeight", head.latest_snapshot_height)?,
        field("snapshotPeriodFrames", head.snapshot_period_frames)?,
        field("retainSnapshots", head.retain_snapshots)?,
        field("epochMaxBytes", head.epoch_max_bytes)?,
        field("accountMerkleRadix", head.account_merkle_radix)?,
        field("epochReplayBytes", head.epoch_replay_bytes)?,
        field("retainedWalBytes", head.retained_wal_bytes)?,
    ];
    crate::encode_storage_payload(&CanonicalValue::Object(fields)).map_err(Into::into)
}

pub(super) fn decode_head(bytes: &[u8]) -> Result<StorageHead, NativeStorageError> {
    let value = crate::decode_storage_payload(bytes)?;
    let object = value
        .as_object()
        .ok_or(NativeStorageError::Head("object"))?;
    let head = StorageHead {
        schema_version: unsigned(object.get("schemaVersion"), "schemaVersion")?,
        latest_height: unsigned(object.get("latestHeight"), "latestHeight")?,
        latest_materialized_height: unsigned(
            object.get("latestMaterializedHeight"),
            "latestMaterializedHeight",
        )?,
        latest_snapshot_height: unsigned(
            object.get("latestSnapshotHeight"),
            "latestSnapshotHeight",
        )?,
        snapshot_period_frames: unsigned(
            object.get("snapshotPeriodFrames"),
            "snapshotPeriodFrames",
        )?,
        retain_snapshots: unsigned(object.get("retainSnapshots"), "retainSnapshots")?,
        epoch_max_bytes: unsigned(object.get("epochMaxBytes"), "epochMaxBytes")?,
        account_merkle_radix: unsigned(object.get("accountMerkleRadix"), "accountMerkleRadix")?,
        epoch_replay_bytes: unsigned(object.get("epochReplayBytes"), "epochReplayBytes")?,
        retained_wal_bytes: unsigned(object.get("retainedWalBytes"), "retainedWalBytes")?,
    };
    validate_head(&head)?;
    Ok(head)
}

pub(super) fn encode_checkpoint(
    height: u64,
    state_root: &[u8; 32],
) -> Result<Vec<u8>, NativeStorageError> {
    let fields = vec![
        ("height".to_string(), number(height)?),
        (
            "stateRoot".to_string(),
            CanonicalValue::String(format_hash(state_root)),
        ),
    ];
    crate::encode_storage_payload(&CanonicalValue::Object(fields)).map_err(Into::into)
}

pub(super) fn decode_checkpoint(bytes: &[u8]) -> Result<(u64, [u8; 32]), NativeStorageError> {
    let value = crate::decode_storage_payload(bytes)?;
    let object = value
        .as_object()
        .ok_or(NativeStorageError::Checkpoint("object"))?;
    Ok((
        unsigned(object.get("height"), "checkpoint.height")?,
        parse_hash(object.get("stateRoot"), "checkpoint.stateRoot")?,
    ))
}

fn validate_head(head: &StorageHead) -> Result<(), NativeStorageError> {
    if head.schema_version != 5 {
        return Err(NativeStorageError::Head("schemaVersion"));
    }
    if head.latest_materialized_height > head.latest_height
        || head.latest_snapshot_height > head.latest_height
    {
        return Err(NativeStorageError::Head("height-order"));
    }
    if head.snapshot_period_frames == 0
        || head.retain_snapshots == 0
        || head.epoch_max_bytes == 0
        || head.account_merkle_radix != 16
    {
        return Err(NativeStorageError::Head("config"));
    }
    Ok(())
}

fn unsigned(value: Option<&Value>, field: &'static str) -> Result<u64, NativeStorageError> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(NativeStorageError::FrameField(field))
}

fn number(value: u64) -> Result<CanonicalValue, NativeStorageError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| NativeStorageError::UnsafeNumber(value))
}

fn field(name: &str, value: u64) -> Result<(String, CanonicalValue), NativeStorageError> {
    Ok((name.to_string(), number(value)?))
}

fn parse_hash(value: Option<&Value>, field: &'static str) -> Result<[u8; 32], NativeStorageError> {
    let text = value
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or(NativeStorageError::FrameField(field))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| NativeStorageError::FrameField(field))?;
    }
    Ok(output)
}

fn format_hash(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}
