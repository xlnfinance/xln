//! Physical Account-checkpoint node keys.
//!
//! A digest authenticates a value; it never addresses storage. Branch rows
//! live at their logical Patricia prefix and leaf rows at their full protocol
//! key, so replacing or pruning a path cannot leave a content-addressed DAG.

use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};
use xln_rscore_engine::{
    EMPTY_J_CLAIM_ROOT, JClaimNode, JClaimRecord, JClaimSide, hash_j_claim_node,
};
use xln_rscore_protocol::{PersistentNodeRecord, PersistentRadixMap};

const J_CLAIM_BRANCH_PATH_BYTES: usize = 34;
#[derive(Clone, Debug)]
pub(crate) struct RadixPhysicalRow {
    pub(crate) kind: u8,
    pub(crate) path: Vec<u8>,
    pub(crate) value: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct JClaimAccumulatorRef {
    pub(crate) root: [u8; 32],
    pub(crate) count: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct JClaimPhysicalRow {
    pub(crate) kind: u8,
    pub(crate) side: u8,
    pub(crate) path: Vec<u8>,
    pub(crate) value: Value,
}

#[derive(Clone, Debug)]
enum ValidatedNode {
    Leaf {
        key: [u8; 32],
    },
    Branch {
        bit: u16,
        prefix: [u8; 32],
        left: [u8; 32],
        right: [u8; 32],
    },
}

#[derive(Clone, Debug)]
struct ValidatedRow {
    node: ValidatedNode,
    value: Value,
}

fn invalid(detail: impl Into<String>) -> String {
    format!("J_CLAIM_PATH_KEY:{}", detail.into())
}

pub(crate) fn unpack_radix16_path(encoded: &[u8]) -> Result<Vec<u8>, String> {
    let [high, low, packed @ ..] = encoded else {
        return Err(invalid("RADIX_PATH_TRUNCATED"));
    };
    let length = usize::from(u16::from_be_bytes([*high, *low]));
    let packed_length = length.div_ceil(2);
    if packed.len() != packed_length {
        return Err(invalid("RADIX_PATH_LENGTH"));
    }
    if length % 2 == 1 && packed.last().is_some_and(|byte| byte & 0x0f != 0) {
        return Err(invalid("RADIX_PATH_PADDING"));
    }
    let mut path = Vec::with_capacity(length);
    for index in 0..length {
        let byte = packed[index / 2];
        path.push(if index % 2 == 0 {
            byte >> 4
        } else {
            byte & 0x0f
        });
    }
    Ok(path)
}

pub(crate) fn pack_radix16_path(path: &[u8]) -> Result<Vec<u8>, String> {
    if path.iter().any(|slot| *slot > 0x0f) {
        return Err(invalid("RADIX_PATH_SLOT"));
    }
    let length = u16::try_from(path.len()).map_err(|_| invalid("RADIX_PATH_LENGTH"))?;
    let mut encoded = Vec::with_capacity(2 + path.len().div_ceil(2));
    encoded.extend_from_slice(&length.to_be_bytes());
    for pair in path.chunks(2) {
        encoded.push((pair[0] << 4) | pair.get(1).copied().unwrap_or(0));
    }
    Ok(encoded)
}

fn array<'a>(value: &'a Value, length: usize, path: &str) -> Result<&'a [Value], String> {
    value
        .as_array()
        .filter(|values| values.len() == length)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("ARRAY:{path}:{length}")))
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn bytes<const N: usize>(value: &Value, path: &str) -> Result<[u8; N], String> {
    variable_bytes(value, path)?
        .try_into()
        .map_err(|_| invalid(format!("BYTES_LENGTH:{path}:{N}")))
}

fn variable_bytes(value: &Value, path: &str) -> Result<Vec<u8>, String> {
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

fn integer(value: &Value, path: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| invalid(format!("INTEGER:{path}")))
}

fn record(value: &Value) -> Result<JClaimRecord, String> {
    let fields = array(value, 5, "record")?;
    let side = match integer(&fields[1], "record.side")? {
        0 => JClaimSide::Left,
        1 => JClaimSide::Right,
        side => return Err(invalid(format!("SIDE:{side}"))),
    };
    Ok(JClaimRecord {
        account_key: bytes(&fields[0], "record.accountKey")?,
        side,
        j_height: integer(&fields[2], "record.jHeight")?,
        j_block_hash: bytes(&fields[3], "record.jBlockHash")?,
        events_hash: bytes(&fields[4], "record.eventsHash")?,
    })
}

fn node(value: &Value) -> Result<JClaimNode, String> {
    let fields = value.as_array().ok_or_else(|| invalid("NODE_ARRAY"))?;
    match fields.first().and_then(Value::as_u64) {
        Some(0) => {
            let fields = array(value, 3, "leaf")?;
            Ok(JClaimNode::Leaf {
                key: bytes(&fields[1], "leaf.key")?,
                record: record(&fields[2])?,
            })
        }
        Some(1) => {
            let fields = array(value, 4, "branch")?;
            let bit = u16::try_from(integer(&fields[1], "branch.bit")?)
                .map_err(|_| invalid("BRANCH_BIT"))?;
            Ok(JClaimNode::Branch {
                bit,
                left: bytes(&fields[2], "branch.left")?,
                right: bytes(&fields[3], "branch.right")?,
            })
        }
        tag => Err(invalid(format!("NODE_TAG:{tag:?}"))),
    }
}

fn canonical_prefix(bit: u16, prefix: &[u8; 32]) -> bool {
    if bit > 255 {
        return false;
    }
    let byte = usize::from(bit / 8);
    let retained = u8::try_from(bit % 8).unwrap_or(0);
    if retained == 0 {
        prefix[byte..].iter().all(|value| *value == 0)
    } else {
        let unused_mask = (1_u8 << (8 - retained)) - 1;
        prefix[byte] & unused_mask == 0 && prefix[byte + 1..].iter().all(|value| *value == 0)
    }
}

fn prefix_at(key: &[u8; 32], bit: u16) -> [u8; 32] {
    let mut prefix = *key;
    let byte = usize::from(bit / 8);
    let retained = u8::try_from(bit % 8).unwrap_or(0);
    if retained == 0 {
        prefix[byte..].fill(0);
    } else {
        let unused_mask = (1_u8 << (8 - retained)) - 1;
        prefix[byte] &= !unused_mask;
        prefix[byte + 1..].fill(0);
    }
    prefix
}

fn key_bit(key: &[u8; 32], bit: u16) -> u8 {
    let byte = key[usize::from(bit / 8)];
    (byte >> (7 - (bit % 8))) & 1
}

fn validate_row(row: JClaimPhysicalRow) -> Result<([u8; 32], ValidatedRow), String> {
    let fields = array(&row.value, 2, "entry")?;
    let stored_hash = bytes(&fields[0], "entry.hash")?;
    let node = node(&fields[1])?;
    let actual_hash = hash_j_claim_node(&node).map_err(|error| invalid(format!("HASH:{error}")))?;
    if stored_hash != actual_hash {
        return Err(invalid("HASH_MISMATCH"));
    }
    let node = match node {
        JClaimNode::Leaf { key, .. } => {
            if row.kind != 1 || row.path.as_slice() != key {
                return Err(invalid("LEAF_PHYSICAL_KEY"));
            }
            ValidatedNode::Leaf { key }
        }
        JClaimNode::Branch { bit, left, right } => {
            if row.kind != 0 || row.path.len() != J_CLAIM_BRANCH_PATH_BYTES {
                return Err(invalid("BRANCH_PHYSICAL_KEY"));
            }
            let encoded_bit = u16::from_be_bytes([row.path[0], row.path[1]]);
            let prefix: [u8; 32] = row.path[2..]
                .try_into()
                .map_err(|_| invalid("BRANCH_PREFIX"))?;
            if bit != encoded_bit || !canonical_prefix(bit, &prefix) {
                return Err(invalid("BRANCH_PREFIX"));
            }
            ValidatedNode::Branch {
                bit,
                prefix,
                left,
                right,
            }
        }
    };
    Ok((
        stored_hash,
        ValidatedRow {
            node,
            value: row.value,
        },
    ))
}

fn child_position(
    parent_bit: u16,
    parent_prefix: &[u8; 32],
    direction: u8,
    child: &ValidatedNode,
) -> bool {
    match child {
        ValidatedNode::Leaf { key } => {
            prefix_at(key, parent_bit) == *parent_prefix && key_bit(key, parent_bit) == direction
        }
        ValidatedNode::Branch { bit, prefix, .. } => {
            *bit > parent_bit
                && prefix_at(prefix, parent_bit) == *parent_prefix
                && key_bit(prefix, parent_bit) == direction
        }
    }
}

fn visit(
    hash: [u8; 32],
    rows: &BTreeMap<[u8; 32], ValidatedRow>,
    active: &mut BTreeSet<[u8; 32]>,
    reached: &mut BTreeSet<[u8; 32]>,
    leaves: &mut u64,
) -> Result<(), String> {
    if reached.contains(&hash) {
        return Ok(());
    }
    if !active.insert(hash) {
        return Err(invalid("CYCLE"));
    }
    let row = rows.get(&hash).ok_or_else(|| invalid("CHILD_MISSING"))?;
    match &row.node {
        ValidatedNode::Leaf { .. } => {
            *leaves = leaves
                .checked_add(1)
                .ok_or_else(|| invalid("COUNT_OVERFLOW"))?;
        }
        ValidatedNode::Branch {
            bit,
            prefix,
            left,
            right,
        } => {
            let left_row = rows.get(left).ok_or_else(|| invalid("LEFT_MISSING"))?;
            let right_row = rows.get(right).ok_or_else(|| invalid("RIGHT_MISSING"))?;
            if !child_position(*bit, prefix, 0, &left_row.node)
                || !child_position(*bit, prefix, 1, &right_row.node)
            {
                return Err(invalid("CHILD_PATH"));
            }
            visit(*left, rows, active, reached, leaves)?;
            visit(*right, rows, active, reached, leaves)?;
        }
    }
    active.remove(&hash);
    reached.insert(hash);
    Ok(())
}

/// Validate and order the complete physical J-claim store for RestoreExact.
pub(crate) fn restore_j_claim_rows(
    physical: Vec<JClaimPhysicalRow>,
    roots: &[JClaimAccumulatorRef; 2],
) -> Result<Vec<Value>, String> {
    let mut side_rows = [BTreeMap::new(), BTreeMap::new()];
    for row in physical {
        let side = usize::from(row.side);
        if side >= side_rows.len() {
            return Err(invalid(format!("SIDE:{}", row.side)));
        }
        let (hash, row) = validate_row(row)?;
        if side_rows[side].insert(hash, row).is_some() {
            return Err(invalid("HASH_DUPLICATE"));
        }
    }
    let mut exact_rows = BTreeMap::new();
    for (side, root) in roots.iter().enumerate() {
        let rows = &side_rows[side];
        if root.root == EMPTY_J_CLAIM_ROOT {
            if root.count != 0 {
                return Err(invalid("EMPTY_ROOT_COUNT"));
            }
            if !rows.is_empty() {
                return Err(invalid(format!("EMPTY_ROOT_ROWS:{side}:{}", rows.len())));
            }
            continue;
        }
        let mut reached = BTreeSet::new();
        let mut leaves = 0_u64;
        visit(
            root.root,
            rows,
            &mut BTreeSet::new(),
            &mut reached,
            &mut leaves,
        )?;
        if leaves != root.count {
            return Err(invalid(format!("LEAF_COUNT:{}:{leaves}", root.count)));
        }
        let expected_nodes = root
            .count
            .checked_mul(2)
            .and_then(|count| count.checked_sub(1))
            .ok_or_else(|| invalid("NODE_COUNT_OVERFLOW"))?;
        if u64::try_from(reached.len()).ok() != Some(expected_nodes) {
            return Err(invalid(format!(
                "NODE_COUNT:{expected_nodes}:{}",
                reached.len()
            )));
        }
        if reached.len() != rows.len() {
            return Err(invalid(format!(
                "ORPHAN:{side}:{}",
                rows.len() - reached.len()
            )));
        }
        for (hash, row) in rows {
            if let Some(previous) = exact_rows.insert(*hash, row.value.clone())
                && previous != row.value
            {
                return Err(invalid("CROSS_SIDE_HASH_CONFLICT"));
            }
        }
    }
    Ok(exact_rows.into_values().collect())
}

/// Re-key one complete hash-authenticated J-claim graph by its permanent
/// logical Patricia paths. Hashes authenticate values only; they never become
/// physical LevelDB suffixes.
pub(crate) fn project_j_claim_rows(
    values: Vec<Value>,
    roots: &[JClaimAccumulatorRef; 2],
) -> Result<Vec<JClaimPhysicalRow>, String> {
    let mut nodes = BTreeMap::<[u8; 32], (JClaimNode, Value)>::new();
    for value in values {
        let fields = array(&value, 2, "entry")?;
        let stored_hash = bytes(&fields[0], "entry.hash")?;
        let node = node(&fields[1])?;
        let actual_hash =
            hash_j_claim_node(&node).map_err(|error| invalid(format!("HASH:{error}")))?;
        if stored_hash != actual_hash {
            return Err(invalid("HASH_MISMATCH"));
        }
        if nodes.insert(stored_hash, (node, value)).is_some() {
            return Err(invalid("HASH_DUPLICATE"));
        }
    }

    fn visit_project(
        hash: [u8; 32],
        position: (u8, Option<u16>),
        nodes: &BTreeMap<[u8; 32], (JClaimNode, Value)>,
        active: &mut BTreeSet<[u8; 32]>,
        reached: &mut BTreeSet<[u8; 32]>,
        rows: &mut BTreeMap<(u8, u8, Vec<u8>), Value>,
        leaves: &mut u64,
    ) -> Result<[u8; 32], String> {
        if !active.insert(hash) {
            return Err(invalid("CYCLE"));
        }
        let (node, value) = nodes.get(&hash).ok_or_else(|| invalid("CHILD_MISSING"))?;
        let representative = match node {
            JClaimNode::Leaf { key, .. } => {
                *leaves = leaves
                    .checked_add(1)
                    .ok_or_else(|| invalid("COUNT_OVERFLOW"))?;
                let path = key.to_vec();
                if rows
                    .insert((position.0, 1, path.clone()), value.clone())
                    .is_some()
                {
                    return Err(invalid("PHYSICAL_PATH_DUPLICATE"));
                }
                *key
            }
            JClaimNode::Branch { bit, left, right } => {
                if position.1.is_some_and(|previous| *bit <= previous) {
                    return Err(invalid("BRANCH_ORDER"));
                }
                let left_key = visit_project(
                    *left,
                    (position.0, Some(*bit)),
                    nodes,
                    active,
                    reached,
                    rows,
                    leaves,
                )?;
                let right_key = visit_project(
                    *right,
                    (position.0, Some(*bit)),
                    nodes,
                    active,
                    reached,
                    rows,
                    leaves,
                )?;
                if key_bit(&left_key, *bit) != 0 || key_bit(&right_key, *bit) != 1 {
                    return Err(invalid("BRANCH_DIRECTION"));
                }
                let prefix = prefix_at(&left_key, *bit);
                if prefix_at(&right_key, *bit) != prefix {
                    return Err(invalid("BRANCH_PREFIX"));
                }
                let mut path = bit.to_be_bytes().to_vec();
                path.extend_from_slice(&prefix);
                if rows.insert((position.0, 0, path), value.clone()).is_some() {
                    return Err(invalid("PHYSICAL_PATH_DUPLICATE"));
                }
                left_key
            }
        };
        active.remove(&hash);
        reached.insert(hash);
        Ok(representative)
    }

    let mut reached = BTreeSet::new();
    let mut physical = BTreeMap::new();
    for (side, root) in roots.iter().enumerate() {
        if root.root == EMPTY_J_CLAIM_ROOT {
            if root.count != 0 {
                return Err(invalid("EMPTY_ROOT_COUNT"));
            }
            continue;
        }
        let mut leaves = 0_u64;
        visit_project(
            root.root,
            (u8::try_from(side).map_err(|_| invalid("SIDE"))?, None),
            &nodes,
            &mut BTreeSet::new(),
            &mut reached,
            &mut physical,
            &mut leaves,
        )?;
        if leaves != root.count {
            return Err(invalid(format!("LEAF_COUNT:{}:{leaves}", root.count)));
        }
    }
    if reached.len() != nodes.len() {
        return Err(invalid(format!("ORPHAN:{}", nodes.len() - reached.len())));
    }
    Ok(physical
        .into_iter()
        .map(|((side, kind, path), value)| JClaimPhysicalRow {
            kind,
            side,
            path,
            value,
        })
        .collect())
}

pub(crate) fn j_claim_accumulators(header: &Value) -> Result<[JClaimAccumulatorRef; 2], String> {
    let header = array(header, 9, "header")?;
    let carried = array(&header[6], 6, "carried")?;
    let decode = |value: &Value, path: &str| -> Result<JClaimAccumulatorRef, String> {
        let fields = array(value, 2, path)?;
        Ok(JClaimAccumulatorRef {
            root: bytes(&fields[0], &format!("{path}.root"))?,
            count: integer(&fields[1], &format!("{path}.count"))?,
        })
    };
    Ok([
        decode(&carried[4], "leftClaims")?,
        decode(&carried[5], "rightClaims")?,
    ])
}

#[derive(Clone, Debug)]
struct ExpectedRadixChild {
    slot: u8,
    kind: u8,
    path: Vec<u8>,
}

fn child_rows(value: &Value) -> Result<Vec<ExpectedRadixChild>, String> {
    let values = value.as_array().ok_or_else(|| invalid("RADIX_CHILDREN"))?;
    values
        .iter()
        .map(|value| {
            let fields = array(value, 4, "radixChild")?;
            let slot = u8::try_from(integer(&fields[0], "radixChild.slot")?)
                .map_err(|_| invalid("RADIX_CHILD_SLOT"))?;
            let kind = u8::try_from(integer(&fields[1], "radixChild.kind")?)
                .map_err(|_| invalid("RADIX_CHILD_KIND"))?;
            if slot > 15 || !matches!(kind, 0 | 1) {
                return Err(invalid("RADIX_CHILD_DESCRIPTOR"));
            }
            let path = variable_bytes(&fields[2], "radixChild.path")?;
            let _: [u8; 32] = bytes(&fields[3], "radixChild.edgeHash")?;
            Ok(ExpectedRadixChild { slot, kind, path })
        })
        .collect()
}

/// Validate optional cached branch rows against the one canonical topology
/// rebuilt from logical leaf keys. Branch values never select restore state;
/// they are accepted only when they describe a real canonical branch.
pub(crate) fn restore_radix_leaf_rows(
    physical: Vec<RadixPhysicalRow>,
) -> Result<Vec<Value>, String> {
    let mut leaves = BTreeMap::<Vec<u8>, (Vec<u8>, Value)>::new();
    let mut branches = BTreeMap::<Vec<u8>, Vec<ExpectedRadixChild>>::new();
    for row in physical {
        match row.kind {
            0 => {
                let fields = array(&row.value, 3, "radixBranch")?;
                if fields[0].as_u64() != Some(0)
                    || variable_bytes(&fields[1], "radixBranch.path")? != row.path
                {
                    return Err(invalid("RADIX_BRANCH_KEY"));
                }
                if branches.insert(row.path, child_rows(&fields[2])?).is_some() {
                    return Err(invalid("RADIX_BRANCH_DUPLICATE"));
                }
            }
            1 => {
                let fields = array(&row.value, 4, "radixLeaf")?;
                if fields[0].as_u64() != Some(1) {
                    return Err(invalid("RADIX_LEAF_TAG"));
                }
                let logical_path = variable_bytes(&fields[1], "radixLeaf.path")?;
                let key = variable_bytes(&fields[2], "radixLeaf.key")?;
                if key.is_empty() || key != row.path {
                    return Err(invalid("RADIX_LEAF_KEY"));
                }
                if leaves.insert(key, (logical_path, row.value)).is_some() {
                    return Err(invalid("RADIX_LEAF_DUPLICATE"));
                }
            }
            kind => return Err(invalid(format!("RADIX_KIND:{kind}"))),
        }
    }

    let mut map = PersistentRadixMap::empty();
    for key in leaves.keys() {
        map = map
            .updated(key.clone(), (), [0_u8; 32])
            .map_err(|error| invalid(format!("RADIX_KEY:{error}")))?;
    }
    let mut expected_branches = BTreeMap::new();
    let mut expected_leaf_paths = BTreeMap::new();
    for record in map.node_records() {
        match record {
            PersistentNodeRecord::Branch { path, children } => {
                expected_branches.insert(
                    path,
                    children
                        .into_iter()
                        .map(|child| ExpectedRadixChild {
                            slot: child.slot,
                            kind: if child.kind == "branch" { 0 } else { 1 },
                            path: child.path,
                        })
                        .collect::<Vec<_>>(),
                );
            }
            PersistentNodeRecord::Leaf { path, key, .. } => {
                expected_leaf_paths.insert(key, path);
            }
        }
    }
    for (key, (stored_path, _)) in &leaves {
        if expected_leaf_paths.get(key) != Some(stored_path) {
            return Err(invalid("RADIX_LEAF_PATH"));
        }
    }
    for (path, children) in branches {
        let expected = expected_branches
            .get(&path)
            .ok_or_else(|| invalid("RADIX_BRANCH_ORPHAN"))?;
        if children.len() != expected.len()
            || children.iter().zip(expected).any(|(actual, expected)| {
                actual.slot != expected.slot
                    || actual.kind != expected.kind
                    || actual.path != expected.path
            })
        {
            return Err(invalid("RADIX_BRANCH_CHILDREN"));
        }
    }
    Ok(leaves.into_values().map(|(_, value)| value).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{JClaimSide, j_claim_key};

    fn tagged(bytes: &[u8]) -> Value {
        Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("TypedArray".into())),
            ("kind".into(), Value::String("Uint8Array".into())),
            ("value".into(), Value::String(BASE64.encode(bytes))),
        ]))
    }

    fn record(height: u64, marker: u8) -> JClaimRecord {
        JClaimRecord {
            account_key: [0x11; 32],
            side: JClaimSide::Left,
            j_height: height,
            j_block_hash: [marker; 32],
            events_hash: [marker.wrapping_add(1); 32],
        }
    }

    fn node_value(node: &JClaimNode) -> Value {
        match node {
            JClaimNode::Leaf { key, record } => Value::Array(vec![
                Value::Number(0_u64.into()),
                tagged(key),
                Value::Array(vec![
                    tagged(&record.account_key),
                    Value::Number(u64::from(record.side.index()).into()),
                    Value::Number(record.j_height.into()),
                    tagged(&record.j_block_hash),
                    tagged(&record.events_hash),
                ]),
            ]),
            JClaimNode::Branch { bit, left, right } => Value::Array(vec![
                Value::Number(1_u64.into()),
                Value::Number(u64::from(*bit).into()),
                tagged(left),
                tagged(right),
            ]),
        }
    }

    fn physical(node: JClaimNode) -> JClaimPhysicalRow {
        let hash = hash_j_claim_node(&node).expect("valid node");
        let (kind, path) = match &node {
            JClaimNode::Leaf { key, .. } => (1, key.to_vec()),
            JClaimNode::Branch { bit, .. } => {
                let mut path = bit.to_be_bytes().to_vec();
                path.extend_from_slice(&[0_u8; 32]);
                (0, path)
            }
        };
        JClaimPhysicalRow {
            kind,
            side: 0,
            path,
            value: Value::Array(vec![tagged(&hash), node_value(&node)]),
        }
    }

    fn leaf(height: u64, marker: u8) -> (JClaimNode, [u8; 32]) {
        let record = record(height, marker);
        let key = j_claim_key(&record).expect("valid record");
        let node = JClaimNode::Leaf { key, record };
        let hash = hash_j_claim_node(&node).expect("valid leaf");
        (node, hash)
    }

    fn first_different_bit(left: &[u8; 32], right: &[u8; 32]) -> u16 {
        (0..256)
            .find(|bit| key_bit(left, *bit) != key_bit(right, *bit))
            .expect("distinct fixture keys")
    }

    fn roots(root: [u8; 32], count: u64) -> [JClaimAccumulatorRef; 2] {
        [
            JClaimAccumulatorRef { root, count },
            JClaimAccumulatorRef {
                root: EMPTY_J_CLAIM_ROOT,
                count: 0,
            },
        ]
    }

    fn radix_leaf(key: &[u8], value: u8) -> RadixPhysicalRow {
        let path = key
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0x0f])
            .collect::<Vec<_>>();
        RadixPhysicalRow {
            kind: 1,
            path: key.to_vec(),
            value: Value::Array(vec![
                Value::Number(1_u64.into()),
                tagged(&path),
                tagged(key),
                Value::Number(u64::from(value).into()),
            ]),
        }
    }

    #[test]
    fn packed_radix_path_is_exact_and_rejects_padding() {
        assert_eq!(unpack_radix16_path(&[0, 3, 0x12, 0x30]), Ok(vec![1, 2, 3]));
        assert_eq!(pack_radix16_path(&[1, 2, 3]), Ok(vec![0, 3, 0x12, 0x30]));
        assert!(unpack_radix16_path(&[0, 3, 0x12, 0x31]).is_err());
        assert!(unpack_radix16_path(&[0, 4, 0x12]).is_err());
        assert!(pack_radix16_path(&[16]).is_err());
    }

    #[test]
    fn exact_restore_uses_leaf_protocol_key_and_authenticates_value() {
        let (node, hash) = leaf(7, 0x22);
        let rows =
            restore_j_claim_rows(vec![physical(node)], &roots(hash, 1)).expect("exact restore");
        assert_eq!(rows.len(), 1);

        let mut corrupt = rows[0].clone();
        corrupt.as_array_mut().expect("entry")[0] = tagged(&[0x99; 32]);
        let error = restore_j_claim_rows(
            vec![JClaimPhysicalRow {
                kind: 1,
                side: 0,
                path: match &rows[0].as_array().expect("entry")[1] {
                    Value::Array(node) => bytes::<32>(&node[1], "test").expect("leaf key").to_vec(),
                    _ => unreachable!("node fixture"),
                },
                value: corrupt,
            }],
            &roots(hash, 1),
        )
        .expect_err("corruption must fail");
        assert!(error.contains("HASH_MISMATCH"));
    }

    #[test]
    fn exact_restore_rejects_orphan_rows() {
        let (first, first_hash) = leaf(7, 0x22);
        let (orphan, _) = leaf(8, 0x44);
        let error = restore_j_claim_rows(
            vec![physical(first), physical(orphan)],
            &roots(first_hash, 1),
        )
        .expect_err("orphan must fail");
        assert!(error.contains("ORPHAN:0:1"));
    }

    #[test]
    fn exact_restore_checks_branch_prefix_and_both_children() {
        let (first, first_hash) = leaf(7, 0x22);
        let (second, second_hash) = leaf(8, 0x44);
        let (first_key, second_key) = match (&first, &second) {
            (JClaimNode::Leaf { key: first, .. }, JClaimNode::Leaf { key: second, .. }) => {
                (*first, *second)
            }
            _ => unreachable!("leaf fixtures"),
        };
        let bit = first_different_bit(&first_key, &second_key);
        let (left, right) = if key_bit(&first_key, bit) == 0 {
            (first_hash, second_hash)
        } else {
            (second_hash, first_hash)
        };
        let branch = JClaimNode::Branch { bit, left, right };
        let branch_hash = hash_j_claim_node(&branch).expect("branch hash");
        let mut branch_row = physical(branch);
        branch_row.path = bit.to_be_bytes().to_vec();
        branch_row
            .path
            .extend_from_slice(&prefix_at(&first_key, bit));
        let restored = restore_j_claim_rows(
            vec![physical(first), physical(second), branch_row],
            &roots(branch_hash, 2),
        )
        .expect("branch restore");
        assert_eq!(restored.len(), 3);
    }

    #[test]
    fn exact_projection_rekeys_hash_nodes_by_logical_paths() {
        let (first, first_hash) = leaf(7, 0x22);
        let (second, second_hash) = leaf(8, 0x44);
        let (first_key, second_key) = match (&first, &second) {
            (JClaimNode::Leaf { key: first, .. }, JClaimNode::Leaf { key: second, .. }) => {
                (*first, *second)
            }
            _ => unreachable!("leaf fixtures"),
        };
        let bit = first_different_bit(&first_key, &second_key);
        let (left, right) = if key_bit(&first_key, bit) == 0 {
            (first_hash, second_hash)
        } else {
            (second_hash, first_hash)
        };
        let branch = JClaimNode::Branch { bit, left, right };
        let branch_hash = hash_j_claim_node(&branch).expect("branch hash");
        let values = [first, second, branch]
            .into_iter()
            .map(|node| {
                let hash = hash_j_claim_node(&node).expect("node hash");
                Value::Array(vec![tagged(&hash), node_value(&node)])
            })
            .collect();
        let projected = project_j_claim_rows(values, &roots(branch_hash, 2)).expect("project");
        assert_eq!(projected.len(), 3);
        assert!(projected.iter().all(|row| row.path != branch_hash));
        assert_eq!(
            restore_j_claim_rows(projected, &roots(branch_hash, 2))
                .expect("restore")
                .len(),
            3,
        );
    }

    #[test]
    fn one_logical_leaf_path_overwrites_and_prunes_without_a_dag() {
        let (old, _) = leaf(7, 0x22);
        let JClaimNode::Leaf { key, record } = old.clone() else {
            unreachable!("leaf fixture")
        };
        let replacement = JClaimNode::Leaf {
            key,
            record: JClaimRecord {
                j_block_hash: [0x66; 32],
                events_hash: [0x77; 32],
                ..record
            },
        };
        let replacement_hash = hash_j_claim_node(&replacement).expect("replacement hash");
        let mut physical_rows = BTreeMap::new();
        physical_rows.insert(key.to_vec(), physical(old));
        assert!(
            physical_rows
                .insert(key.to_vec(), physical(replacement))
                .is_some()
        );
        let restored = restore_j_claim_rows(
            physical_rows.into_values().collect(),
            &roots(replacement_hash, 1),
        )
        .expect("replacement restore");
        assert_eq!(restored.len(), 1);

        let pruned = restore_j_claim_rows(Vec::new(), &roots(EMPTY_J_CLAIM_ROOT, 0))
            .expect("pruned restore");
        assert!(pruned.is_empty());
    }

    #[test]
    fn radix_restore_rejects_an_orphan_cached_branch() {
        let orphan = RadixPhysicalRow {
            kind: 0,
            path: vec![15],
            value: Value::Array(vec![
                Value::Number(0_u64.into()),
                tagged(&[15]),
                Value::Array(Vec::new()),
            ]),
        };
        let error = restore_radix_leaf_rows(vec![radix_leaf(&[0x12], 7), orphan])
            .expect_err("orphan branch must fail");
        assert!(error.contains("RADIX_BRANCH_ORPHAN"));
    }
}
