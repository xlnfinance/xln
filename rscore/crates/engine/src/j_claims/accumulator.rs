use std::collections::BTreeMap;

use crate::StateError;
use crate::commitment::JClaimAccumulator;
use crate::j_claims::codec::{
    EMPTY_J_CLAIM_ROOT, JClaimNode, JClaimProof, JClaimRecord, JClaimSide, claim_key,
    first_different_bit, hash_node, j_error, key_bit, same_record,
};
use crate::j_claims::proof::{ProofResult, create, inspect};
use crate::j_claims::store::{apply_changes, collect_tree};

pub type JClaimStore = BTreeMap<[u8; 32], JClaimNode>;
type NewNodes = Vec<([u8; 32], JClaimNode)>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JClaimNodeChanges {
    pub new_nodes: Vec<([u8; 32], JClaimNode)>,
    pub replaced_node_hashes: Vec<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JClaimMutation {
    Inserted,
    Idempotent,
    Deleted,
}

pub(crate) fn insert(
    state: &JClaimAccumulator,
    record: &JClaimRecord,
    proof: &JClaimProof,
) -> Result<(JClaimMutation, JClaimAccumulator, JClaimNodeChanges), StateError> {
    validate_state(state)?;
    let key = claim_key(record)?;
    let inspected = inspect(state.root, record, proof)?;
    if let ProofResult::Member(existing) = inspected.result {
        if !same_record(&existing, record) {
            return Err(j_error(format!(
                "ACCOUNT_J_CLAIM_EQUIVOCATION:{}",
                hex(&key)
            )));
        }
        return Ok((
            JClaimMutation::Idempotent,
            state.clone(),
            JClaimNodeChanges::default(),
        ));
    }
    let count = state
        .count
        .checked_add(1)
        .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_COUNT_OVERFLOW"))?;
    let mut nodes = NewNodes::new();
    let leaf = JClaimNode::Leaf {
        key,
        record: record.clone(),
    };
    let mut child_hash = put_node(&mut nodes, leaf)?;
    let mut replaced = Vec::new();
    if let Some(JClaimNode::Leaf {
        key: terminal_key, ..
    }) = inspected.terminal
    {
        let differing_bit = first_different_bit(&key, &terminal_key)
            .ok_or_else(|| j_error(format!("ACCOUNT_J_CLAIM_KEY_COLLISION:{}", hex(&key))))?;
        let prefix_len = inspected
            .path
            .iter()
            .position(|entry| branch_bit(&entry.node).is_some_and(|bit| bit >= differing_bit))
            .unwrap_or(inspected.path.len());
        replaced.extend(inspected.path[..prefix_len].iter().map(|entry| entry.hash));
        let subtree_hash = if prefix_len < inspected.path.len() {
            inspected.path[prefix_len].hash
        } else {
            inspected
                .terminal_hash
                .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_TERMINAL_HASH_MISSING"))?
        };
        child_hash = put_node(
            &mut nodes,
            branch_with_children(
                differing_bit,
                key_bit(&key, differing_bit),
                child_hash,
                subtree_hash,
            ),
        )?;
        child_hash = rebuild_prefix(&mut nodes, &inspected.path[..prefix_len], child_hash)?;
    }
    Ok((
        JClaimMutation::Inserted,
        JClaimAccumulator {
            root: child_hash,
            count,
        },
        JClaimNodeChanges {
            new_nodes: nodes,
            replaced_node_hashes: replaced,
        },
    ))
}

pub(crate) fn delete(
    state: &JClaimAccumulator,
    record: &JClaimRecord,
    proof: &JClaimProof,
) -> Result<(JClaimMutation, JClaimAccumulator, JClaimNodeChanges), StateError> {
    validate_state(state)?;
    let key = claim_key(record)?;
    let inspected = inspect(state.root, record, proof)?;
    let ProofResult::Member(existing) = inspected.result else {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_DELETE_ABSENT:{}",
            hex(&key)
        )));
    };
    if !same_record(&existing, record) {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_EQUIVOCATION:{}",
            hex(&key)
        )));
    }
    let terminal_hash = inspected
        .terminal_hash
        .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_TERMINAL_HASH_MISSING"))?;
    let mut replaced = vec![terminal_hash];
    replaced.extend(inspected.path.iter().map(|entry| entry.hash));
    if state.count == 1 {
        return Ok((
            JClaimMutation::Deleted,
            JClaimAccumulator::default(),
            JClaimNodeChanges {
                new_nodes: Vec::new(),
                replaced_node_hashes: replaced,
            },
        ));
    }
    let parent = inspected
        .path
        .last()
        .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_DELETE_PARENT_MISSING"))?;
    let mut child_hash = sibling_hash(&parent.node, parent.direction)?;
    let mut nodes = NewNodes::new();
    child_hash = rebuild_prefix(
        &mut nodes,
        &inspected.path[..inspected.path.len() - 1],
        child_hash,
    )?;
    let count = state
        .count
        .checked_sub(1)
        .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_COUNT_UNDERFLOW"))?;
    Ok((
        JClaimMutation::Deleted,
        JClaimAccumulator {
            root: child_hash,
            count,
        },
        JClaimNodeChanges {
            new_nodes: nodes,
            replaced_node_hashes: replaced,
        },
    ))
}

pub(crate) fn prune(
    mut state: JClaimAccumulator,
    store: &mut JClaimStore,
    account_key: [u8; 32],
    side: JClaimSide,
    through_height: u64,
) -> Result<JClaimAccumulator, StateError> {
    let records = collect_tree(store, &state)?.1;
    if let Some(foreign) = records
        .iter()
        .find(|record| record.account_key != account_key || record.side != side)
    {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_ROOT_DOMAIN_MISMATCH:{}:{:?}",
            hex(&foreign.account_key),
            foreign.side
        )));
    }
    for record in records
        .into_iter()
        .filter(|record| record.j_height <= through_height)
    {
        let proof = create(store, state.root, &record)?;
        let (_, next, changes) = delete(&state, &record, &proof)?;
        apply_changes(store, &changes);
        state = next;
    }
    Ok(state)
}

pub(crate) fn validate_state(state: &JClaimAccumulator) -> Result<(), StateError> {
    if (state.root == EMPTY_J_CLAIM_ROOT) != (state.count == 0) {
        return Err(j_error("ACCOUNT_J_CLAIM_STATE_ROOT_COUNT_MISMATCH"));
    }
    Ok(())
}

fn put_node(store: &mut NewNodes, node: JClaimNode) -> Result<[u8; 32], StateError> {
    let hash = hash_node(&node)?;
    if let Some((_, existing)) = store.iter_mut().find(|(existing, _)| existing == &hash) {
        *existing = node;
    } else {
        store.push((hash, node));
    }
    Ok(hash)
}

fn rebuild_prefix(
    nodes: &mut NewNodes,
    path: &[crate::j_claims::proof::PathEntry],
    mut child_hash: [u8; 32],
) -> Result<[u8; 32], StateError> {
    for entry in path.iter().rev() {
        let JClaimNode::Branch { bit, left, right } = entry.node else {
            return Err(j_error("ACCOUNT_J_CLAIM_PATH_BRANCH_REQUIRED"));
        };
        child_hash = put_node(
            nodes,
            JClaimNode::Branch {
                bit,
                left: if entry.direction == 0 {
                    child_hash
                } else {
                    left
                },
                right: if entry.direction == 1 {
                    child_hash
                } else {
                    right
                },
            },
        )?;
    }
    Ok(child_hash)
}

fn branch_with_children(
    bit: u16,
    direction: u8,
    child_hash: [u8; 32],
    subtree_hash: [u8; 32],
) -> JClaimNode {
    JClaimNode::Branch {
        bit,
        left: if direction == 0 {
            child_hash
        } else {
            subtree_hash
        },
        right: if direction == 1 {
            child_hash
        } else {
            subtree_hash
        },
    }
}

fn sibling_hash(node: &JClaimNode, direction: u8) -> Result<[u8; 32], StateError> {
    let JClaimNode::Branch { left, right, .. } = node else {
        return Err(j_error("ACCOUNT_J_CLAIM_PATH_BRANCH_REQUIRED"));
    };
    Ok(if direction == 0 { *right } else { *left })
}

fn branch_bit(node: &JClaimNode) -> Option<u16> {
    match node {
        JClaimNode::Branch { bit, .. } => Some(*bit),
        JClaimNode::Leaf { .. } => None,
    }
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
