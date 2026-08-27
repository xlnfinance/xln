use serde_json::Value;

use super::types::{
    AccountAuthorityCheckpointRef, Digest, RuntimeFrameCodecError, RuntimeFrameEntityHash,
    TouchedAccount,
};
use super::value::{format_hash, number, object, text};

pub(super) fn canonical_entity_hashes(
    rows: &[RuntimeFrameEntityHash],
) -> Result<Value, RuntimeFrameCodecError> {
    let mut rows = rows.to_vec();
    rows.sort_by(|left, right| left.entity_id.cmp(&right.entity_id));
    if rows
        .windows(2)
        .any(|pair| pair[0].entity_id == pair[1].entity_id)
    {
        return Err(RuntimeFrameCodecError::EntityHashOrder);
    }
    rows.into_iter()
        .map(|row| {
            Ok(object(vec![
                ("entityId", text(row.entity_id.to_lowercase())),
                ("hash", text(format_hash(&row.hash))),
                (
                    "cellCount",
                    number("canonicalEntityHashes.cellCount", row.cell_count)?,
                ),
            ]))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn tagged_map(rows: Vec<(Value, Value)>) -> Value {
    object(vec![
        ("__xlnType", text("Map")),
        (
            "value",
            Value::Array(
                rows.into_iter()
                    .map(|(key, value)| Value::Array(vec![key, value]))
                    .collect(),
            ),
        ),
    ])
}

pub(super) fn context_refs(
    rows: &[(String, Digest)],
) -> Result<Option<Value>, RuntimeFrameCodecError> {
    let mut rows = rows.to_vec();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    if let Some(pair) = rows.windows(2).find(|pair| pair[0].0 == pair[1].0) {
        return Err(RuntimeFrameCodecError::DuplicateContext(pair[0].0.clone()));
    }
    Ok((!rows.is_empty()).then(|| {
        tagged_map(
            rows.into_iter()
                .map(|(key, hash)| (text(key), text(format_hash(&hash))))
                .collect(),
        )
    }))
}

fn decimal_revision(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes == b"0"
        || bytes
            .first()
            .is_some_and(|first| (b'1'..=b'9').contains(first))
            && bytes[1..].iter().all(u8::is_ascii_digit)
}

pub(super) fn checkpoint_refs(
    rows: &[AccountAuthorityCheckpointRef],
) -> Result<Option<Value>, RuntimeFrameCodecError> {
    let mut rows = rows.to_vec();
    rows.sort_by_key(|row| row.owner_entity_id);
    if rows
        .windows(2)
        .any(|pair| pair[0].owner_entity_id == pair[1].owner_entity_id)
    {
        return Err(RuntimeFrameCodecError::CheckpointOwnerOrder);
    }
    let values = rows
        .into_iter()
        .map(checkpoint_ref)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((!values.is_empty()).then_some(Value::Array(values)))
}

fn checkpoint_ref(row: AccountAuthorityCheckpointRef) -> Result<Value, RuntimeFrameCodecError> {
    if row.base_revision != row.revision || !decimal_revision(&row.revision) {
        return Err(RuntimeFrameCodecError::CheckpointRevision(row.revision));
    }
    if row.account_count > 65_536 {
        return Err(RuntimeFrameCodecError::CheckpointAccountCount(
            row.account_count,
        ));
    }
    Ok(object(vec![
        ("ownerEntityId", text(format_hash(&row.owner_entity_id))),
        (
            "protocolFingerprint",
            text(format_hash(&row.protocol_fingerprint)),
        ),
        ("baseRevision", text(row.base_revision)),
        ("revision", text(row.revision)),
        ("accountsRoot", text(format_hash(&row.accounts_root))),
        ("signerDigest", text(format_hash(&row.signer_digest))),
        (
            "accountCount",
            number(
                "accountAuthorityCheckpoints.accountCount",
                row.account_count,
            )?,
        ),
    ]))
}

pub(super) fn touched_accounts(rows: &[TouchedAccount]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                object(vec![
                    ("entityId", text(&row.entity_id)),
                    ("counterpartyId", text(&row.counterparty_id)),
                ])
            })
            .collect(),
    )
}

pub(super) fn sorted_strings(values: &[String]) -> Value {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    Value::Array(values.into_iter().map(text).collect())
}
