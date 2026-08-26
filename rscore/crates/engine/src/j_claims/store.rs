use std::collections::BTreeSet;

use crate::StateError;
use crate::commitment::JClaimAccumulator;
use crate::j_claims::accumulator::{JClaimNodeChanges, JClaimStore, validate_state};
use crate::j_claims::codec::{
    EMPTY_J_CLAIM_ROOT, JClaimNode, JClaimRecord, hash_node, j_error, key_bit,
};

type TreePath = Vec<(u16, u8)>;
type PendingNode = ([u8; 32], Option<u16>, TreePath);

pub(crate) fn apply_changes(store: &mut JClaimStore, changes: &JClaimNodeChanges) {
    for (hash, node) in &changes.new_nodes {
        store.insert(*hash, node.clone());
    }
    for hash in &changes.replaced_node_hashes {
        if !changes
            .new_nodes
            .iter()
            .any(|(new_hash, _)| new_hash == hash)
        {
            store.remove(hash);
        }
    }
}

pub(crate) fn validate_store_for_roots(
    store: &JClaimStore,
    roots: &[JClaimAccumulator],
) -> Result<(), StateError> {
    let mut reachable = BTreeSet::new();
    for state in roots {
        reachable.extend(collect_tree(store, state)?.0);
    }
    if store.keys().any(|hash| !reachable.contains(hash)) {
        return Err(j_error("ACCOUNT_J_CLAIM_STORE_UNREACHABLE_NODE"));
    }
    Ok(())
}

pub(crate) fn collect_tree(
    store: &JClaimStore,
    state: &JClaimAccumulator,
) -> Result<(BTreeSet<[u8; 32]>, Vec<JClaimRecord>), StateError> {
    validate_state(state)?;
    if state.root == EMPTY_J_CLAIM_ROOT {
        return Ok((BTreeSet::new(), Vec::new()));
    }
    let mut seen = BTreeSet::new();
    let mut records = Vec::new();
    let mut pending = vec![(state.root, None, TreePath::new())];
    while let Some((hash, previous_bit, path)) = pending.pop() {
        if !seen.insert(hash) {
            continue;
        }
        let node = store
            .get(&hash)
            .ok_or_else(|| j_error(format!("ACCOUNT_J_CLAIM_NODE_MISSING:{}", hex(&hash))))?;
        if hash_node(node)? != hash {
            return Err(j_error(format!(
                "ACCOUNT_J_CLAIM_NODE_CORRUPT:{}",
                hex(&hash)
            )));
        }
        collect_node(node, previous_bit, &path, &mut pending, &mut records)?;
    }
    validate_tree_counts(state, seen.len(), records.len())?;
    records.sort_by_key(|record| (record.j_height, record.side));
    Ok((seen, records))
}

fn collect_node(
    node: &JClaimNode,
    previous_bit: Option<u16>,
    path: &[(u16, u8)],
    pending: &mut Vec<PendingNode>,
    records: &mut Vec<JClaimRecord>,
) -> Result<(), StateError> {
    match node {
        JClaimNode::Branch { bit, left, right } => {
            if previous_bit.is_some_and(|previous| *bit <= previous) {
                return Err(j_error("ACCOUNT_J_CLAIM_BRANCH_ORDER_INVALID"));
            }
            let mut left_path = path.to_vec();
            left_path.push((*bit, 0));
            let mut right_path = path.to_vec();
            right_path.push((*bit, 1));
            pending.push((*left, Some(*bit), left_path));
            pending.push((*right, Some(*bit), right_path));
        }
        JClaimNode::Leaf { key, record } => {
            if path
                .iter()
                .any(|(bit, direction)| key_bit(key, *bit) != *direction)
            {
                return Err(j_error("ACCOUNT_J_CLAIM_TREE_NON_CANONICAL_PATH"));
            }
            records.push(record.clone());
        }
    }
    Ok(())
}

fn validate_tree_counts(
    state: &JClaimAccumulator,
    nodes: usize,
    records: usize,
) -> Result<(), StateError> {
    let expected = state
        .count
        .checked_mul(2)
        .and_then(|value| value.checked_sub(1))
        .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_TREE_COUNT_OVERFLOW"))?;
    if usize::try_from(expected).ok() != Some(nodes)
        || usize::try_from(state.count).ok() != Some(records)
    {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_TREE_COUNT_MISMATCH:{}:{nodes}:{records}",
            state.count
        )));
    }
    Ok(())
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
