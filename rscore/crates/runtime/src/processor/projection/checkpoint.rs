//! Exact path-keyed Account checkpoint projection for the native Runtime WAL.

use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Number, Value};
use thiserror::Error;
use xln_rscore_abi::AbiValue;
use xln_rscore_batch::{
    AccountsCheckpoint, EncodedAccountCheckpointNodeAddress, EncodedAccountCheckpointTreeChanges,
    EncodedAccountJClaimChanges, encode_account_checkpoint_nodes, encode_account_checkpoint_rows,
};

use crate::checkpoint_node_key::{JClaimPhysicalRow, j_claim_accumulators, project_j_claim_rows};
use crate::storage::native::{PathNodeChange, PathNodeKey};

const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;
const ACCOUNT_META_TAG: u8 = 0x17;
const ACCOUNT_ROW_TAG: u8 = 0x18;
const ACCOUNT_NODE_TAG: u8 = 0x19;
const J_CLAIM_NAMESPACE: u8 = 7;

pub(crate) struct PreparedAccountCheckpoint {
    pub(crate) changes: Vec<PathNodeChange>,
}

pub(crate) fn prepare_account_checkpoint(
    checkpoint: &AccountsCheckpoint,
    owner: [u8; 32],
    protocol_fingerprint: [u8; 32],
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<PreparedAccountCheckpoint, AccountCheckpointProjectionError> {
    let restore = checkpoint.restore_token();
    if checkpoint
        .accounts
        .iter()
        .any(|row| row.header.owner.as_bytes() != &owner)
    {
        return Err(AccountCheckpointProjectionError::Owner);
    }
    let mut changes = BTreeMap::<Vec<u8>, Option<Vec<u8>>>::new();
    changes.insert(
        account_meta_key(owner),
        Some(encode_value(&account_meta_value(
            owner,
            protocol_fingerprint,
            restore,
        )?)?),
    );
    for account_id in &checkpoint.removed {
        let prefix = account_prefix(owner, *account_id.as_bytes());
        for tag in [ACCOUNT_ROW_TAG, ACCOUNT_NODE_TAG] {
            let mut tagged = Vec::with_capacity(65);
            tagged.push(tag);
            tagged.extend_from_slice(&prefix);
            for (key, _) in prefix_range(prior, &tagged) {
                changes.insert(key.clone(), None);
            }
        }
    }
    for row in &checkpoint.accounts {
        let encoded = encode_account_checkpoint_rows(row, true)?;
        let fields = tuple(&encoded, "account")?;
        if fields.len() != 12 {
            return Err(AccountCheckpointProjectionError::Shape("account"));
        }
        let account_id = *row.account_id.as_bytes();
        let nodes = encode_account_checkpoint_nodes(row)?;
        changes.insert(
            account_row_key(owner, account_id),
            Some(encode_value(&Value::Array(vec![
                abi_json(&fields[1])?,
                abi_json(&fields[2])?,
                abi_json(&fields[11])?,
            ]))?),
        );
        for tree in &nodes.trees {
            apply_radix_changes(&mut changes, owner, account_id, tree)?;
        }
        apply_j_claim_changes(
            &mut changes,
            owner,
            account_id,
            prior,
            &fields[2],
            &nodes.j_claims,
        )?;
    }
    Ok(PreparedAccountCheckpoint {
        changes: changes
            .into_iter()
            .map(|(key, value)| {
                Ok(PathNodeChange {
                    key: PathNodeKey::new(key)?,
                    value,
                })
            })
            .collect::<Result<_, crate::storage::native::NativeStorageError>>()?,
    })
}

fn apply_radix_changes(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    account_id: [u8; 32],
    tree: &EncodedAccountCheckpointTreeChanges,
) -> Result<(), AccountCheckpointProjectionError> {
    let namespace = tree.namespace.tag();
    for put in &tree.puts {
        let (kind, logical_key) = node_address(&put.address)?;
        changes.insert(
            account_node_key(owner, account_id, namespace, kind, &logical_key),
            Some(encode_value(&abi_json(&put.wire_value)?)?),
        );
    }
    for deletion in &tree.dels {
        let (kind, logical_key) = node_address(&deletion.address)?;
        changes.insert(
            account_node_key(owner, account_id, namespace, kind, &logical_key),
            None,
        );
    }
    Ok(())
}

fn node_address(
    value: &EncodedAccountCheckpointNodeAddress,
) -> Result<(u8, Vec<u8>), AccountCheckpointProjectionError> {
    Ok(match value {
        EncodedAccountCheckpointNodeAddress::Branch { path } => (
            0,
            crate::checkpoint_node_key::pack_radix16_path(path)
                .map_err(AccountCheckpointProjectionError::Radix)?,
        ),
        EncodedAccountCheckpointNodeAddress::Leaf { key, .. } => (1, key.clone()),
    })
}

fn apply_j_claim_changes(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    account_id: [u8; 32],
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
    header: &AbiValue,
    delta: &EncodedAccountJClaimChanges,
) -> Result<(), AccountCheckpointProjectionError> {
    let prefix = account_node_prefix(owner, account_id, J_CLAIM_NAMESPACE);
    let mut entries = BTreeMap::<[u8; 32], Value>::new();
    let mut prior_keys = Vec::new();
    for (key, bytes) in prefix_range(prior, &prefix) {
        let value = crate::decode_storage_payload(bytes)?;
        let fields = json_array(&value, 2, "storedJClaim")?;
        let hash = json_bytes::<32>(&fields[0], "storedJClaim.hash")?;
        match entries.insert(hash, value) {
            Some(previous) if previous != entries[&hash] => {
                return Err(AccountCheckpointProjectionError::JClaim(
                    "HASH_CONFLICT".into(),
                ));
            }
            _ => {}
        }
        prior_keys.push(key.clone());
    }
    for put in &delta.puts {
        let value = Value::Array(vec![tagged_bytes(&put.hash), abi_json(&put.wire_value)?]);
        let hash = put.hash;
        if entries
            .insert(hash, value)
            .is_some_and(|previous| previous != entries[&hash])
        {
            return Err(AccountCheckpointProjectionError::JClaim(
                "HASH_CONFLICT".into(),
            ));
        }
    }
    for deletion in &delta.dels {
        entries.remove(deletion);
    }
    for key in prior_keys {
        changes.insert(key, None);
    }
    let header = abi_json(header)?;
    let roots = j_claim_accumulators(&header).map_err(AccountCheckpointProjectionError::JClaim)?;
    for row in project_j_claim_rows(entries.into_values().collect(), &roots)
        .map_err(AccountCheckpointProjectionError::JClaim)?
    {
        let key = j_claim_node_key(owner, account_id, &row);
        changes.insert(key, Some(encode_value(&row.value)?));
    }
    Ok(())
}

/// Ordered range of `map` whose keys start with `prefix`. Same rows in the
/// same order as a full-map `starts_with` filter, without visiting the rest
/// of the checkpoint graph for every account.
fn prefix_range<'a>(
    map: &'a BTreeMap<Vec<u8>, Vec<u8>>,
    prefix: &[u8],
) -> impl Iterator<Item = (&'a Vec<u8>, &'a Vec<u8>)> {
    let lower = prefix.to_vec();
    let mut upper = prefix.to_vec();
    while upper.last() == Some(&0xff) {
        upper.pop();
    }
    let bounded = match upper.last_mut() {
        Some(last) => {
            *last += 1;
            true
        }
        None => false,
    };
    let range: Box<dyn Iterator<Item = _>> = if bounded {
        Box::new(map.range(lower..upper))
    } else {
        Box::new(map.range(lower..))
    };
    range
}

fn account_meta_value(
    owner: [u8; 32],
    protocol_fingerprint: [u8; 32],
    token: xln_rscore_batch::CheckpointToken,
) -> Result<Value, AccountCheckpointProjectionError> {
    let account_count = u64::try_from(token.account_count)
        .map_err(|_| AccountCheckpointProjectionError::AccountCount(token.account_count))?;
    Ok(Value::Object(Map::from_iter([
        ("version".into(), Value::Number(1_u64.into())),
        ("ownerEntityId".into(), Value::String(hex(&owner))),
        (
            "protocolFingerprint".into(),
            Value::String(hex(&protocol_fingerprint)),
        ),
        (
            "baseRevision".into(),
            Value::String(token.base_revision.to_string()),
        ),
        ("revision".into(), Value::String(token.revision.to_string())),
        (
            "accountsRoot".into(),
            Value::String(hex(&token.accounts_root)),
        ),
        (
            "signerDigest".into(),
            Value::String(hex(&token.signer_digest)),
        ),
        ("accountCount".into(), Value::Number(account_count.into())),
    ])))
}

fn abi_json(value: &AbiValue) -> Result<Value, AccountCheckpointProjectionError> {
    Ok(match value {
        AbiValue::Nil => Value::Null,
        AbiValue::Bool(value) => Value::Bool(*value),
        AbiValue::Integer(value) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(value) => {
            let value = i64::try_from(*value)
                .map_err(|_| AccountCheckpointProjectionError::Shape("safeInteger"))?;
            Value::Number(Number::from(value))
        }
        AbiValue::Integer(value) => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("BigInt".into())),
            ("value".into(), Value::String(value.to_string())),
        ])),
        AbiValue::Bytes(value) => tagged_bytes(value),
        AbiValue::Text(value) => Value::String(value.clone()),
        AbiValue::Tuple(value) => Value::Array(
            value
                .fields()
                .iter()
                .map(abi_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    })
}

fn tuple<'a>(
    value: &'a AbiValue,
    path: &'static str,
) -> Result<&'a [AbiValue], AccountCheckpointProjectionError> {
    match value {
        AbiValue::Tuple(value) => Ok(value.fields()),
        _ => Err(AccountCheckpointProjectionError::Shape(path)),
    }
}

fn json_array<'a>(
    value: &'a Value,
    len: usize,
    path: &'static str,
) -> Result<&'a [Value], AccountCheckpointProjectionError> {
    value
        .as_array()
        .filter(|values| values.len() == len)
        .map(Vec::as_slice)
        .ok_or(AccountCheckpointProjectionError::Shape(path))
}

fn json_bytes<const N: usize>(
    value: &Value,
    path: &'static str,
) -> Result<[u8; N], AccountCheckpointProjectionError> {
    let object = value
        .as_object()
        .ok_or(AccountCheckpointProjectionError::Shape(path))?;
    if object.get("__xlnType").and_then(Value::as_str) != Some("TypedArray")
        || object.get("kind").and_then(Value::as_str) != Some("Uint8Array")
    {
        return Err(AccountCheckpointProjectionError::Shape(path));
    }
    BASE64
        .decode(
            object
                .get("value")
                .and_then(Value::as_str)
                .ok_or(AccountCheckpointProjectionError::Shape(path))?,
        )
        .map_err(|_| AccountCheckpointProjectionError::Shape(path))?
        .try_into()
        .map_err(|_| AccountCheckpointProjectionError::Shape(path))
}

fn encode_value(value: &Value) -> Result<Vec<u8>, AccountCheckpointProjectionError> {
    Ok(crate::transport::msgpack::encode_framed(value)?)
}

fn tagged_bytes(value: &[u8]) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("TypedArray".into())),
        ("kind".into(), Value::String("Uint8Array".into())),
        ("value".into(), Value::String(BASE64.encode(value))),
    ]))
}

fn account_meta_key(owner: [u8; 32]) -> Vec<u8> {
    let mut key = Vec::with_capacity(33);
    key.push(ACCOUNT_META_TAG);
    key.extend_from_slice(&owner);
    key
}

fn account_prefix(owner: [u8; 32], account_id: [u8; 32]) -> Vec<u8> {
    let mut key = Vec::with_capacity(64);
    key.extend_from_slice(&owner);
    key.extend_from_slice(&account_id);
    key
}

fn account_row_key(owner: [u8; 32], account_id: [u8; 32]) -> Vec<u8> {
    let mut key = Vec::with_capacity(65);
    key.push(ACCOUNT_ROW_TAG);
    key.extend_from_slice(&account_prefix(owner, account_id));
    key
}

fn account_node_prefix(owner: [u8; 32], account_id: [u8; 32], namespace: u8) -> Vec<u8> {
    let mut key = Vec::with_capacity(66);
    key.push(ACCOUNT_NODE_TAG);
    key.extend_from_slice(&account_prefix(owner, account_id));
    key.push(namespace);
    key
}

fn account_node_key(
    owner: [u8; 32],
    account_id: [u8; 32],
    namespace: u8,
    kind: u8,
    logical_key: &[u8],
) -> Vec<u8> {
    let mut key = account_node_prefix(owner, account_id, namespace);
    key.push(kind);
    key.extend_from_slice(logical_key);
    key
}

fn j_claim_node_key(owner: [u8; 32], account_id: [u8; 32], row: &JClaimPhysicalRow) -> Vec<u8> {
    let mut key = account_node_prefix(owner, account_id, J_CLAIM_NAMESPACE);
    key.push(row.kind);
    key.push(row.side);
    key.extend_from_slice(&row.path);
    key
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[derive(Debug, Error)]
pub(crate) enum AccountCheckpointProjectionError {
    #[error("RRS_CHECKPOINT_ACCOUNT_OWNER")]
    Owner,
    #[error("RRS_CHECKPOINT_ACCOUNT_COUNT:{0}")]
    AccountCount(usize),
    #[error("RRS_CHECKPOINT_ACCOUNT_SHAPE:{0}")]
    Shape(&'static str),
    #[error("RRS_CHECKPOINT_ACCOUNT_J_CLAIM:{0}")]
    JClaim(String),
    #[error("RRS_CHECKPOINT_ACCOUNT_RADIX:{0}")]
    Radix(String),
    #[error(transparent)]
    Wire(#[from] xln_rscore_batch::AccountWireEncodeError),
    #[error(transparent)]
    Storage(#[from] crate::storage::native::NativeStorageError),
    #[error(transparent)]
    StorageMessagePack(#[from] crate::StorageMessagePackError),
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
}
