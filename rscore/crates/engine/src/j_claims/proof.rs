use std::collections::BTreeSet;

use crate::StateError;
use crate::j_claims::codec::{
    EMPTY_J_CLAIM_ROOT, JClaimNode, JClaimProof, JClaimRecord, claim_key, hash_node, j_error,
    key_bit,
};

const MAX_PROOF_NODES: usize = 257;
const MAX_PROOF_BYTES: usize = 3 + 256 * 68 + 140;

#[derive(Clone, Debug)]
pub(crate) struct PathEntry {
    pub hash: [u8; 32],
    pub node: JClaimNode,
    pub direction: u8,
}

#[derive(Clone, Debug)]
pub(crate) enum ProofResult {
    Member(JClaimRecord),
    Absent,
}

#[derive(Clone, Debug)]
pub(crate) struct ProofInspection {
    pub result: ProofResult,
    pub path: Vec<PathEntry>,
    pub terminal: Option<JClaimNode>,
    pub terminal_hash: Option<[u8; 32]>,
}

pub(crate) fn inspect(
    root: [u8; 32],
    record: &JClaimRecord,
    proof: &JClaimProof,
) -> Result<ProofInspection, StateError> {
    validate_proof_size(proof)?;
    if root == EMPTY_J_CLAIM_ROOT {
        if !proof.nodes.is_empty() {
            return Err(j_error("ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES"));
        }
        return Ok(ProofInspection {
            result: ProofResult::Absent,
            path: Vec::new(),
            terminal: None,
            terminal_hash: None,
        });
    }
    if proof.nodes.is_empty() {
        return Err(j_error("ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID"));
    }
    inspect_nonempty(root, record, proof)
}

pub(crate) fn create(
    store: &super::JClaimStore,
    root: [u8; 32],
    record: &JClaimRecord,
) -> Result<JClaimProof, StateError> {
    if root == EMPTY_J_CLAIM_ROOT {
        return Ok(JClaimProof::empty());
    }
    let key = claim_key(record)?;
    let mut nodes = Vec::new();
    let mut seen = BTreeSet::new();
    let mut hash = root;
    let mut previous_bit: Option<u16> = None;
    loop {
        if !seen.insert(hash) {
            return Err(j_error(format!(
                "ACCOUNT_J_CLAIM_NODE_CYCLE:{}",
                hex(&hash)
            )));
        }
        if nodes.len() >= MAX_PROOF_NODES {
            return Err(j_error("ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID"));
        }
        let node = store
            .get(&hash)
            .ok_or_else(|| j_error(format!("ACCOUNT_J_CLAIM_NODE_MISSING:{}", hex(&hash))))?
            .clone();
        assert_hash(&node, hash)?;
        nodes.push(node.clone());
        match node {
            JClaimNode::Leaf { .. } => return Ok(JClaimProof { nodes }),
            JClaimNode::Branch {
                bit, left, right, ..
            } => {
                assert_bit_order(previous_bit, bit)?;
                previous_bit = Some(bit);
                hash = if key_bit(&key, bit) == 0 { left } else { right };
            }
        }
    }
}

fn inspect_nonempty(
    root: [u8; 32],
    record: &JClaimRecord,
    proof: &JClaimProof,
) -> Result<ProofInspection, StateError> {
    let key = claim_key(record)?;
    let mut expected_hash = root;
    let mut previous_bit = None;
    let mut path = Vec::new();
    for (index, node) in proof.nodes.iter().enumerate() {
        assert_hash(node, expected_hash)
            .map_err(|_| j_error(format!("ACCOUNT_J_CLAIM_PROOF_LINK_INVALID:{index}")))?;
        match node {
            JClaimNode::Leaf {
                key: terminal_key,
                record: terminal_record,
            } => {
                if index + 1 != proof.nodes.len() {
                    return Err(j_error("ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES"));
                }
                validate_terminal_path(terminal_key, &path)?;
                let result = if terminal_key == &key {
                    ProofResult::Member(terminal_record.clone())
                } else {
                    ProofResult::Absent
                };
                return Ok(ProofInspection {
                    result,
                    path,
                    terminal: Some(node.clone()),
                    terminal_hash: Some(expected_hash),
                });
            }
            JClaimNode::Branch {
                bit, left, right, ..
            } => {
                assert_bit_order(previous_bit, *bit)?;
                previous_bit = Some(*bit);
                let direction = key_bit(&key, *bit);
                path.push(PathEntry {
                    hash: expected_hash,
                    node: node.clone(),
                    direction,
                });
                expected_hash = if direction == 0 { *left } else { *right };
            }
        }
    }
    Err(j_error("ACCOUNT_J_CLAIM_PROOF_TERMINAL_LEAF_MISSING"))
}

fn validate_terminal_path(key: &[u8; 32], path: &[PathEntry]) -> Result<(), StateError> {
    for entry in path {
        let JClaimNode::Branch { bit, .. } = entry.node else {
            return Err(j_error("ACCOUNT_J_CLAIM_PATH_BRANCH_REQUIRED"));
        };
        if key_bit(key, bit) != entry.direction {
            return Err(j_error(format!(
                "ACCOUNT_J_CLAIM_PROOF_NON_CANONICAL_PATH:{bit}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_proof_size(proof: &JClaimProof) -> Result<(), StateError> {
    if proof.nodes.len() > MAX_PROOF_NODES {
        return Err(j_error("ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID"));
    }
    let bytes = proof.nodes.iter().try_fold(3_usize, |total, node| {
        total.checked_add(match node {
            JClaimNode::Branch { .. } => 68,
            JClaimNode::Leaf { .. } => 140,
        })
    });
    if bytes.is_none_or(|bytes| bytes > MAX_PROOF_BYTES) {
        return Err(j_error("ACCOUNT_J_CLAIM_PROOF_BYTES_INVALID"));
    }
    Ok(())
}

fn assert_hash(node: &JClaimNode, expected: [u8; 32]) -> Result<(), StateError> {
    let actual = hash_node(node)?;
    if actual != expected {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_NODE_CORRUPT:{}:{}",
            hex(&expected),
            hex(&actual)
        )));
    }
    Ok(())
}

fn assert_bit_order(previous: Option<u16>, bit: u16) -> Result<(), StateError> {
    if previous.is_some_and(|previous| bit <= previous) {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_BRANCH_ORDER_INVALID:{}:{bit}",
            previous.unwrap_or_default()
        )));
    }
    Ok(())
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
