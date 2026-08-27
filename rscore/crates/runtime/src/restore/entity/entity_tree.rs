//! Exact inverse of `core/storage/schema/entity/graph-codec.ts`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Number, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::{
    PersistentNodeRecord, PersistentRadixMap, encode_canonical_consensus_bytes,
    encode_raw_text_key, pack_path16,
};

use crate::{
    StorageMessagePackError, TaggedJsonError, canonical_value_from_tagged_json,
    decode_storage_payload,
};

#[derive(Debug, Error)]
pub enum EntityTreeRestoreError {
    #[error("RRS_RESTORE_ENTITY_TREE:{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error("RRS_RESTORE_ENTITY_TREE_RADIX:{0}")]
    Radix(String),
}

fn invalid(detail: impl Into<String>) -> EntityTreeRestoreError {
    EntityTreeRestoreError::Invalid(detail.into())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn branch_value<V: Clone>(record: &PersistentNodeRecord<V>) -> Option<Value> {
    let PersistentNodeRecord::Branch { children, .. } = record else {
        return None;
    };
    Some(Value::Object(Map::from_iter([(
        "children".into(),
        Value::Array(
            children
                .iter()
                .map(|child| {
                    Value::Object(Map::from_iter([
                        ("slot".into(), Value::Number(Number::from(child.slot))),
                        ("kind".into(), Value::String(child.kind.into())),
                        (
                            "path".into(),
                            Value::Array(
                                child
                                    .path
                                    .iter()
                                    .map(|slot| Value::Number(Number::from(*slot)))
                                    .collect(),
                            ),
                        ),
                        ("edgeHash".into(), Value::String(hex(&child.edge_hash))),
                    ]))
                })
                .collect(),
        ),
    )])))
}

fn exact_leaf(value: Value, key_bytes: &[u8]) -> Result<(String, Value), EntityTreeRestoreError> {
    let leaf = value.as_object().ok_or_else(|| invalid("LEAF_OBJECT"))?;
    let mut fields = leaf.keys().map(String::as_str).collect::<Vec<_>>();
    fields.sort_unstable();
    if fields != ["key", "value"] {
        return Err(invalid(format!("LEAF_FIELDS:{}", fields.join(","))));
    }
    let key = leaf
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("LEAF_KEY"))?
        .to_owned();
    let encoded = encode_raw_text_key(&key)
        .map_err(|error| EntityTreeRestoreError::Radix(error.to_string()))?;
    if encoded != key_bytes {
        return Err(invalid(format!("LEAF_KEY_BYTES:{key}")));
    }
    let value = leaf
        .get("value")
        .cloned()
        .ok_or_else(|| invalid("LEAF_VALUE"))?;
    Ok((key, value))
}

fn prefix(tag: u8, owner: &[u8; 32], namespace_tag: u8) -> Vec<u8> {
    let mut output = Vec::with_capacity(34);
    output.push(tag);
    output.extend_from_slice(owner);
    output.push(namespace_tag);
    output
}

pub struct HydratedEntityTree {
    pub tagged_map: Value,
    pub used_keys: BTreeSet<Vec<u8>>,
}

/// Rebuild a persisted Entity collection from its leaf values, authenticate
/// its canonical root, then require every stored branch to equal the rebuilt
/// Patricia record. Neither corrupt edges nor unreachable extra rows survive.
pub fn hydrate_entity_tree(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
    namespace_tag: u8,
    expected_root: &[u8; 32],
    expected_count: usize,
) -> Result<HydratedEntityTree, EntityTreeRestoreError> {
    let leaf_prefix = prefix(0x38, owner, namespace_tag);
    let mut leaves = Vec::<(Vec<u8>, String, Value)>::new();
    let mut used_keys = BTreeSet::new();
    for (storage_key, bytes) in rows
        .range(leaf_prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&leaf_prefix))
    {
        let key_bytes = storage_key
            .get(leaf_prefix.len()..)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("LEAF_STORAGE_KEY"))?;
        let (key, value) = exact_leaf(decode_storage_payload(bytes)?, key_bytes)?;
        leaves.push((key_bytes.to_vec(), key, value));
        used_keys.insert(storage_key.clone());
    }
    leaves.sort_by(|left, right| left.0.cmp(&right.0));
    let mut tree = PersistentRadixMap::empty();
    for (key_bytes, _, value) in &leaves {
        let canonical = canonical_value_from_tagged_json(value)?;
        let encoded = encode_canonical_consensus_bytes(&canonical)
            .map_err(|error| EntityTreeRestoreError::Radix(error.to_string()))?;
        tree = tree
            .updated(key_bytes.clone(), canonical, Sha256::digest(encoded).into())
            .map_err(|error| EntityTreeRestoreError::Radix(error.to_string()))?;
    }
    if tree.len() != expected_count || tree.root_hash() != *expected_root {
        return Err(invalid(format!(
            "ROOT:expected={}:actual={}:expectedCount={expected_count}:actualCount={}",
            hex(expected_root),
            hex(&tree.root_hash()),
            tree.len(),
        )));
    }
    let branch_prefix = prefix(0x37, owner, namespace_tag);
    let mut expected_branches = BTreeSet::new();
    for record in tree.node_records() {
        let PersistentNodeRecord::Branch { path, .. } = &record else {
            continue;
        };
        let mut key = branch_prefix.clone();
        key.extend(
            pack_path16(path).map_err(|error| EntityTreeRestoreError::Radix(error.to_string()))?,
        );
        let stored = rows.get(&key).ok_or_else(|| invalid("BRANCH_MISSING"))?;
        let actual = decode_storage_payload(stored)?;
        if branch_value(&record).as_ref() != Some(&actual) {
            return Err(invalid(format!("BRANCH_VALUE:{}", hex(&key))));
        }
        expected_branches.insert(key.clone());
        used_keys.insert(key);
    }
    let actual_branches = rows
        .range(branch_prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&branch_prefix))
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    if actual_branches != expected_branches {
        return Err(invalid("BRANCH_SET"));
    }
    Ok(HydratedEntityTree {
        tagged_map: Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("Map".into())),
            (
                "value".into(),
                Value::Array(
                    leaves
                        .into_iter()
                        .map(|(_, key, value)| Value::Array(vec![Value::String(key), value]))
                        .collect(),
                ),
            ),
        ])),
        used_keys,
    })
}
