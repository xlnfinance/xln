//! Canonical path-keyed Account and replica-metadata checkpoint reader.

use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Number, Value};
use thiserror::Error;

use crate::checkpoint_node_key::{
    JClaimAccumulatorRef, JClaimPhysicalRow, RadixPhysicalRow, j_claim_accumulators,
    restore_j_claim_rows, restore_radix_leaf_rows, unpack_radix16_path,
};
use crate::{StorageMessagePackError, StoredRscoreCheckpoint, decode_storage_payload};

const ACCOUNT_META_TAG: u8 = 0x17;
const ACCOUNT_ROW_TAG: u8 = 0x18;
const ACCOUNT_NODE_TAG: u8 = 0x19;
const REPLICA_META_TAG: u8 = 0x26;
const MAX_ACCOUNTS: usize = 65_536;

#[derive(Debug, Error)]
pub enum PathCheckpointRestoreError {
    #[error("RRS_RESTORE_PATH_CHECKPOINT:{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
}

#[derive(Clone, Debug)]
pub struct RestoredReplicaMetadata {
    pub signer_id: String,
    pub is_proposer: bool,
    pub value: Value,
}

fn invalid(detail: impl Into<String>) -> PathCheckpointRestoreError {
    PathCheckpointRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, PathCheckpointRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn array<'a>(
    value: &'a Value,
    length: usize,
    path: &str,
) -> Result<&'a [Value], PathCheckpointRestoreError> {
    value
        .as_array()
        .filter(|value| value.len() == length)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("ARRAY:{path}:{length}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    fields: &[&str],
    path: &str,
) -> Result<(), PathCheckpointRestoreError> {
    let mut actual = value.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = fields.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn text<'a>(value: &'a Value, path: &str) -> Result<&'a str, PathCheckpointRestoreError> {
    value
        .as_str()
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn stored_u64(value: &Value, path: &str) -> Result<u64, PathCheckpointRestoreError> {
    let value = text(value, path)?;
    if value != "0" && (value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(invalid(format!("DECIMAL:{path}")));
    }
    value.parse().map_err(|_| invalid(format!("U64:{path}")))
}

fn hex32(value: &Value, path: &str) -> Result<[u8; 32], PathCheckpointRestoreError> {
    let value = text(value, path)?;
    let payload = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid(format!("HEX32:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("HEX32:{path}")))?;
    }
    Ok(output)
}

fn tagged_bytes(bytes: &[u8]) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("TypedArray".into())),
        ("kind".into(), Value::String("Uint8Array".into())),
        ("value".into(), Value::String(BASE64.encode(bytes))),
    ]))
}

fn typed_bytes(value: &Value, path: &str) -> Result<Vec<u8>, PathCheckpointRestoreError> {
    let value = object(value, path)?;
    if value.len() != 3
        || value.get("__xlnType").and_then(Value::as_str) != Some("TypedArray")
        || value.get("kind").and_then(Value::as_str) != Some("Uint8Array")
    {
        return Err(invalid(format!("BYTES:{path}")));
    }
    BASE64
        .decode(
            value
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(format!("BYTES:{path}")))?,
        )
        .map_err(|_| invalid(format!("BYTES:{path}")))
}

fn reject_uncollapsed_bounded(value: &Value, path: &str) -> Result<(), PathCheckpointRestoreError> {
    if value
        .as_object()
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        == Some("boundedValue")
    {
        Err(invalid(format!("BOUNDED_VALUE_NOT_COLLAPSED:{path}")))
    } else {
        Ok(())
    }
}

fn owner_rows<'a>(
    rows: &'a BTreeMap<Vec<u8>, Vec<u8>>,
    tag: u8,
    owner: &[u8; 32],
) -> impl Iterator<Item = (&'a Vec<u8>, &'a Vec<u8>)> {
    rows.iter().filter(move |(key, _)| {
        key.first() == Some(&tag) && key.get(1..33) == Some(owner.as_slice())
    })
}

fn tree_value(
    namespace: u8,
    row: &[Value],
    key_bytes: &[u8],
    path: &str,
) -> Result<Value, PathCheckpointRestoreError> {
    if row.first().and_then(Value::as_u64) != Some(1) {
        return Err(invalid(format!("LEAF_TAG:{path}")));
    }
    let encoded_key = typed_bytes(&row[2], &format!("{path}.key"))?;
    if encoded_key != key_bytes {
        return Err(invalid(format!("LEAF_KEY:{path}")));
    }
    match namespace {
        3 => {
            let length = encoded_key
                .get(..2)
                .and_then(|value| <[u8; 2]>::try_from(value).ok())
                .map(u16::from_be_bytes)
                .map(usize::from)
                .ok_or_else(|| invalid(format!("LENDING_KEY:{path}")))?;
            if encoded_key.len() != length.saturating_add(2) {
                return Err(invalid(format!("LENDING_KEY:{path}")));
            }
            let key = std::str::from_utf8(&encoded_key[2..])
                .map_err(|_| invalid(format!("LENDING_UTF8:{path}")))?;
            Ok(Value::Array(vec![
                Value::String(key.to_owned()),
                row[3].clone(),
            ]))
        }
        5 => {
            if encoded_key.len() != 32 || encoded_key[..30].iter().any(|byte| *byte != 0) {
                return Err(invalid(format!("POLICY_KEY:{path}")));
            }
            Ok(Value::Array(vec![
                Value::Number(Number::from(u16::from_be_bytes([
                    encoded_key[30],
                    encoded_key[31],
                ]))),
                row[3].clone(),
            ]))
        }
        _ => Ok(row[3].clone()),
    }
}

fn account_nodes(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
    account: &[u8; 32],
    namespace: u8,
    j_claim_roots: Option<&[JClaimAccumulatorRef; 2]>,
) -> Result<Vec<Value>, PathCheckpointRestoreError> {
    let mut values = Vec::new();
    let mut leaf_keys = BTreeSet::new();
    let mut j_claim_rows = Vec::new();
    let mut radix_rows = Vec::new();
    for (key, bytes) in owner_rows(rows, ACCOUNT_NODE_TAG, owner) {
        if key.len() < 68 || key.get(33..65) != Some(account.as_slice()) || key[65] != namespace {
            continue;
        }
        let kind = key[66];
        let payload = &key[67..];
        if !matches!(kind, 0 | 1) {
            return Err(invalid("ACCOUNT_NODE_KEY"));
        }
        let decoded = decode_storage_payload(bytes)?;
        reject_uncollapsed_bounded(&decoded, "accountNode")?;
        if namespace == 6 {
            let side = *payload.first().ok_or_else(|| invalid("J_CLAIM_SIDE"))?;
            let logical_path = payload
                .get(1..)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| invalid("J_CLAIM_PATH"))?;
            j_claim_rows.push(JClaimPhysicalRow {
                kind,
                side,
                path: logical_path.to_vec(),
                value: decoded,
            });
        } else if (1..=5).contains(&namespace) {
            let logical_path = if kind == 0 {
                unpack_radix16_path(payload).map_err(invalid)?
            } else {
                payload.to_vec()
            };
            if kind == 1 && !leaf_keys.insert(logical_path.clone()) {
                return Err(invalid("ACCOUNT_NODE_DUPLICATE"));
            }
            radix_rows.push(RadixPhysicalRow {
                kind,
                path: logical_path,
                value: decoded,
            });
        } else {
            return Err(invalid(format!("ACCOUNT_NAMESPACE:{namespace}")));
        }
    }
    if namespace == 6 {
        let roots = j_claim_roots.ok_or_else(|| invalid("J_CLAIM_ROOTS_MISSING"))?;
        values = restore_j_claim_rows(j_claim_rows, roots).map_err(invalid)?;
    } else {
        for decoded in restore_radix_leaf_rows(radix_rows).map_err(invalid)? {
            let row = array(&decoded, 4, "accountLeaf")?;
            let key = typed_bytes(&row[2], "accountLeaf.key")?;
            values.push(tree_value(namespace, row, &key, "accountLeaf")?);
        }
    }
    Ok(values)
}

fn replica_metadata(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
) -> Result<RestoredReplicaMetadata, PathCheckpointRestoreError> {
    let matches = owner_rows(rows, REPLICA_META_TAG, owner).collect::<Vec<_>>();
    let [(key, bytes)] = matches.as_slice() else {
        return Err(invalid(format!("REPLICA_META_COUNT:{}", matches.len())));
    };
    if key.len() != 65 || key[33..45].iter().any(|byte| *byte != 0) {
        return Err(invalid("REPLICA_META_KEY"));
    }
    let value = decode_storage_payload(bytes)?;
    reject_uncollapsed_bounded(&value, "replicaMeta")?;
    let meta = object(&value, "replicaMeta")?;
    let signer_id = text(
        meta.get("signerId")
            .ok_or_else(|| invalid("REPLICA_META_SIGNER"))?,
        "replicaMeta.signerId",
    )?
    .to_ascii_lowercase();
    let signer_bytes = hex20(&signer_id)?;
    if key[45..] != signer_bytes {
        return Err(invalid("REPLICA_META_SIGNER_KEY"));
    }
    let entity = meta
        .get("entityId")
        .ok_or_else(|| invalid("REPLICA_META_ENTITY"))?;
    if hex32(entity, "replicaMeta.entityId")? != *owner {
        return Err(invalid("REPLICA_META_OWNER"));
    }
    let is_proposer = meta
        .get("isProposer")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("REPLICA_META_PROPOSER"))?;
    Ok(RestoredReplicaMetadata {
        signer_id,
        is_proposer,
        value,
    })
}

fn hex20(value: &str) -> Result<[u8; 20], PathCheckpointRestoreError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 40)
        .ok_or_else(|| invalid("SIGNER_HEX20"))?;
    let mut output = [0_u8; 20];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid("SIGNER_HEX20"))?;
    }
    Ok(output)
}

pub fn restore_path_checkpoint(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: [u8; 32],
) -> Result<(StoredRscoreCheckpoint, RestoredReplicaMetadata), PathCheckpointRestoreError> {
    for key in rows.keys().filter(|key| {
        key.first().is_some_and(|tag| {
            [
                ACCOUNT_META_TAG,
                ACCOUNT_ROW_TAG,
                ACCOUNT_NODE_TAG,
                REPLICA_META_TAG,
            ]
            .contains(tag)
        })
    }) {
        if key.get(1..33) != Some(owner.as_slice()) {
            return Err(invalid("FOREIGN_OWNER_ROW"));
        }
    }
    let meta_key = [vec![ACCOUNT_META_TAG], owner.to_vec()].concat();
    let raw_meta = rows
        .get(&meta_key)
        .ok_or_else(|| invalid("ACCOUNT_META_MISSING"))?;
    let decoded_meta = decode_storage_payload(raw_meta)?;
    reject_uncollapsed_bounded(&decoded_meta, "accountMeta")?;
    let meta = object(&decoded_meta, "accountMeta")?;
    exact_fields(
        meta,
        &[
            "version",
            "ownerEntityId",
            "protocolFingerprint",
            "baseRevision",
            "revision",
            "accountsRoot",
            "signerDigest",
            "accountCount",
        ],
        "accountMeta",
    )?;
    if meta.get("version").and_then(Value::as_u64) != Some(1)
        || hex32(&meta["ownerEntityId"], "ownerEntityId")? != owner
    {
        return Err(invalid("ACCOUNT_META_ID"));
    }
    let base_revision = stored_u64(&meta["baseRevision"], "baseRevision")?;
    let revision = stored_u64(&meta["revision"], "revision")?;
    if base_revision != revision {
        return Err(invalid("ACCOUNT_META_BASE_REVISION"));
    }
    let account_count = meta["accountCount"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= MAX_ACCOUNTS)
        .ok_or_else(|| invalid("ACCOUNT_COUNT"))?;
    let mut accounts = Vec::new();
    let mut seen = BTreeSet::new();
    for (key, bytes) in owner_rows(rows, ACCOUNT_ROW_TAG, &owner) {
        if key.len() != 65 {
            return Err(invalid("ACCOUNT_KEY"));
        }
        let account: [u8; 32] = key
            .get(33..)
            .and_then(|value| value.try_into().ok())
            .ok_or_else(|| invalid("ACCOUNT_KEY"))?;
        if !seen.insert(account) {
            return Err(invalid("ACCOUNT_DUPLICATE"));
        }
        let value = decode_storage_payload(bytes)?;
        reject_uncollapsed_bounded(&value, "accountRow")?;
        let account_meta = array(&value, 3, "accountRow")?;
        let leaf = typed_bytes(&account_meta[0], "accountRow.leaf")?;
        if leaf.len() != 32 {
            return Err(invalid("ACCOUNT_LEAF"));
        }
        let j_claim_roots = j_claim_accumulators(&account_meta[1]).map_err(invalid)?;
        let mut row = Vec::with_capacity(10);
        row.push(tagged_bytes(&account));
        row.extend([account_meta[0].clone(), account_meta[1].clone()]);
        for namespace in 1..=6 {
            row.push(Value::Array(account_nodes(
                rows,
                &owner,
                &account,
                namespace,
                (namespace == 6).then_some(&j_claim_roots),
            )?));
        }
        row.push(account_meta[2].clone());
        accounts.push(Value::Array(row));
    }
    if accounts.len() != account_count {
        return Err(invalid(format!(
            "ACCOUNT_COUNT:expected={account_count}:actual={}",
            accounts.len()
        )));
    }
    for (key, _) in owner_rows(rows, ACCOUNT_NODE_TAG, &owner) {
        let account = key
            .get(33..65)
            .and_then(|value| <[u8; 32]>::try_from(value).ok())
            .ok_or_else(|| invalid("ACCOUNT_NODE_KEY"))?;
        if !seen.contains(&account) {
            return Err(invalid("ACCOUNT_NODE_ORPHAN"));
        }
    }
    let checkpoint = StoredRscoreCheckpoint {
        owner_entity_id: owner,
        protocol_fingerprint: hex32(&meta["protocolFingerprint"], "protocolFingerprint")?,
        base_revision,
        revision,
        accounts_root: hex32(&meta["accountsRoot"], "accountsRoot")?,
        signer_digest: hex32(&meta["signerDigest"], "signerDigest")?,
        account_count,
        accounts,
    };
    Ok((checkpoint, replica_metadata(rows, &owner)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

    fn text(value: impl Into<String>) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn object(fields: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn number(value: u64) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture number"))
    }

    fn hex(bytes: &[u8]) -> String {
        let mut value = String::from("0x");
        for byte in bytes {
            value.push_str(&format!("{byte:02x}"));
        }
        value
    }

    fn encoded(value: &CanonicalValue) -> Vec<u8> {
        crate::encode_storage_payload(value).expect("canonical fixture")
    }

    fn fixture() -> (BTreeMap<Vec<u8>, Vec<u8>>, [u8; 32]) {
        let owner = [0x11; 32];
        let signer = [0x22; 20];
        let meta = object(vec![
            ("version", number(1)),
            ("ownerEntityId", text(hex(&owner))),
            ("protocolFingerprint", text(hex(&[0x33; 32]))),
            ("baseRevision", text("7")),
            ("revision", text("7")),
            ("accountsRoot", text(hex(&[0x44; 32]))),
            ("signerDigest", text(hex(&[0x55; 32]))),
            ("accountCount", number(0)),
        ]);
        let replica = object(vec![
            ("entityId", text(hex(&owner))),
            ("signerId", text(hex(&signer))),
            ("isProposer", CanonicalValue::Bool(true)),
        ]);
        let mut rows = BTreeMap::new();
        rows.insert(
            [vec![ACCOUNT_META_TAG], owner.to_vec()].concat(),
            encoded(&meta),
        );
        rows.insert(
            [
                vec![REPLICA_META_TAG],
                owner.to_vec(),
                vec![0_u8; 12],
                signer.to_vec(),
            ]
            .concat(),
            encoded(&replica),
        );
        (rows, owner)
    }

    #[test]
    fn zero_account_checkpoint_uses_durable_replica_identity() {
        let (rows, owner) = fixture();
        let (checkpoint, replica) =
            restore_path_checkpoint(&rows, owner).expect("restore zero-account checkpoint");
        assert_eq!(checkpoint.account_count, 0);
        assert_eq!(checkpoint.revision, 7);
        assert_eq!(replica.signer_id, hex(&[0x22; 20]));
        assert!(replica.is_proposer);
    }

    #[test]
    fn missing_identity_is_a_typed_failure() {
        let (mut rows, owner) = fixture();
        rows.retain(|key, _| key.first() != Some(&REPLICA_META_TAG));
        let error = restore_path_checkpoint(&rows, owner).expect_err("identity must be durable");
        assert!(error.to_string().contains("REPLICA_META_COUNT:0"));
    }

    #[test]
    fn foreign_account_graph_is_rejected() {
        let (mut rows, owner) = fixture();
        rows.insert(
            [vec![ACCOUNT_META_TAG], vec![0x99; 32]].concat(),
            vec![0x03, 0xc0],
        );
        let error = restore_path_checkpoint(&rows, owner).expect_err("foreign owner must fail");
        assert!(error.to_string().contains("FOREIGN_OWNER_ROW"));
    }

    #[test]
    fn truncated_checkpoint_value_is_rejected() {
        let (mut rows, owner) = fixture();
        let key = [vec![ACCOUNT_META_TAG], owner.to_vec()].concat();
        rows.insert(key, vec![0x03, 0xde, 0x00]);
        assert!(matches!(
            restore_path_checkpoint(&rows, owner),
            Err(PathCheckpointRestoreError::Storage(_))
        ));
    }
}
