use std::collections::{BTreeMap, HashSet};

use sha2::{Digest, Sha256};
use thiserror::Error;

pub const EMPTY_RADIX_ROOT: [u8; 32] = [0; 32];
const RADIX: u8 = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RadixLeaf {
    pub key: Vec<u8>,
    pub value_digest: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RadixMerkleResult {
    pub depth: usize,
    pub leaf_count: usize,
    pub branch_count: usize,
    pub extension_count: usize,
    pub max_depth: usize,
    pub root: [u8; 32],
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RadixMerkleError {
    #[error("RADIX_MERKLE_DUPLICATE_KEY")]
    DuplicateKey,
    #[error("RADIX_MERKLE_MIXED_KEY_LENGTHS:expected={expected}:actual={actual}")]
    MixedKeyLengths { expected: usize, actual: usize },
    #[error("RADIX_MERKLE_TEXT_KEY_TOO_LONG:{0}")]
    TextKeyTooLong(usize),
    #[error("RADIX_MERKLE_PATH_TOO_LONG:{0}")]
    PathTooLong(usize),
    #[error("RADIX_MERKLE_INVALID_SLOT:{0}")]
    InvalidSlot(u8),
    #[error("RADIX_MERKLE_EMPTY_GROUP")]
    EmptyGroup,
}

#[derive(Clone)]
struct Item {
    key: Vec<u8>,
    path: Vec<u8>,
    hash: [u8; 32],
}

#[derive(Clone)]
struct Node {
    leaf: bool,
    path: Vec<u8>,
    hash: [u8; 32],
}

#[derive(Default)]
struct Counters {
    branches: usize,
    extensions: usize,
    max_depth: usize,
}

fn domain(tag: &str) -> Vec<u8> {
    let length = u16::try_from(tag.len()).expect("static Merkle domain length");
    let mut encoded = Vec::with_capacity(tag.len() + 2);
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(tag.as_bytes());
    encoded
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

pub fn encode_raw_text_key(value: &str) -> Result<Vec<u8>, RadixMerkleError> {
    let length =
        u16::try_from(value.len()).map_err(|_| RadixMerkleError::TextKeyTooLong(value.len()))?;
    let mut encoded = Vec::with_capacity(value.len() + 2);
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(value.as_bytes());
    Ok(encoded)
}

pub fn pack_path16(path: &[u8]) -> Result<Vec<u8>, RadixMerkleError> {
    let length =
        u16::try_from(path.len()).map_err(|_| RadixMerkleError::PathTooLong(path.len()))?;
    let mut encoded = Vec::with_capacity(2 + path.len().div_ceil(2));
    encoded.extend_from_slice(&length.to_be_bytes());
    for pair in path.chunks(2) {
        let high = pair[0];
        if high >= RADIX {
            return Err(RadixMerkleError::InvalidSlot(high));
        }
        let low = pair.get(1).copied().unwrap_or(0);
        if low >= RADIX {
            return Err(RadixMerkleError::InvalidSlot(low));
        }
        encoded.push((high << 4) | low);
    }
    Ok(encoded)
}

fn path_slots(key: &[u8]) -> Vec<u8> {
    let mut path = Vec::with_capacity(key.len() * 2);
    for byte in key {
        path.push(byte >> 4);
        path.push(byte & 0x0f);
    }
    path
}

pub fn hash_leaf(key: &[u8], value_digest: &[u8; 32]) -> [u8; 32] {
    sha256(&[&domain("xln.storage.merkle.leaf.v1"), key, value_digest])
}

pub fn hash_branch16(children: &[(u8, [u8; 32])]) -> Result<[u8; 32], RadixMerkleError> {
    if children.is_empty() {
        return Ok(EMPTY_RADIX_ROOT);
    }
    let mut ordered = children.to_vec();
    ordered.sort_unstable_by_key(|(slot, _)| *slot);
    let mut seen = [false; RADIX as usize];
    let mut payload = domain("xln.storage.merkle.branch.v1");
    payload.push(RADIX);
    for (slot, hash) in ordered {
        if slot >= RADIX || seen[slot as usize] {
            return Err(RadixMerkleError::InvalidSlot(slot));
        }
        seen[slot as usize] = true;
        payload.push(slot);
        payload.extend_from_slice(&hash);
    }
    Ok(sha256(&[&payload]))
}

pub fn hash_extension16(path: &[u8], child_hash: &[u8; 32]) -> Result<[u8; 32], RadixMerkleError> {
    let encoded_path = pack_path16(path)?;
    Ok(sha256(&[
        &domain("xln.storage.merkle.extension.v1"),
        &[RADIX],
        &encoded_path,
        child_hash,
    ]))
}

fn common_prefix(items: &[Item], offset: usize, depth: usize) -> usize {
    let mut length = 0;
    while offset + length < depth {
        let slot = items[0].path[offset + length];
        if items[1..]
            .iter()
            .any(|item| item.path[offset + length] != slot)
        {
            break;
        }
        length += 1;
    }
    length
}

fn edge_hash(parent_path: &[u8], child: &Node) -> Result<[u8; 32], RadixMerkleError> {
    if child.leaf {
        return Ok(child.hash);
    }
    let segment_start = parent_path.len() + 1;
    if child.path.len() <= segment_start {
        Ok(child.hash)
    } else {
        hash_extension16(&child.path[segment_start..], &child.hash)
    }
}

fn build_node(
    offset: usize,
    depth: usize,
    group: &[Item],
    counters: &mut Counters,
) -> Result<Node, RadixMerkleError> {
    if group.is_empty() {
        return Err(RadixMerkleError::EmptyGroup);
    }
    if group.len() == 1 || offset >= depth {
        counters.max_depth = counters.max_depth.max(offset);
        return Ok(Node {
            leaf: true,
            path: group[0].path.clone(),
            hash: group[0].hash,
        });
    }
    let shared = common_prefix(group, offset, depth);
    counters.branches += 1;
    counters.extensions += usize::from(shared > 0);
    let branch_offset = offset + shared;
    let branch_path = group[0].path[..branch_offset].to_vec();
    let mut buckets = BTreeMap::<u8, Vec<Item>>::new();
    for item in group {
        buckets
            .entry(item.path[branch_offset])
            .or_default()
            .push(item.clone());
    }
    let mut child_hashes = Vec::with_capacity(buckets.len());
    for (slot, bucket) in buckets {
        let child = build_node(branch_offset + 1, depth, &bucket, counters)?;
        child_hashes.push((slot, edge_hash(&branch_path, &child)?));
    }
    Ok(Node {
        leaf: false,
        path: branch_path,
        hash: hash_branch16(&child_hashes)?,
    })
}

pub fn build_radix16_merkle(leaves: &[RadixLeaf]) -> Result<RadixMerkleResult, RadixMerkleError> {
    if leaves.is_empty() {
        return Ok(RadixMerkleResult {
            depth: 0,
            leaf_count: 0,
            branch_count: 0,
            extension_count: 0,
            max_depth: 0,
            root: EMPTY_RADIX_ROOT,
        });
    }
    let mut seen = HashSet::with_capacity(leaves.len());
    let mut items = Vec::with_capacity(leaves.len());
    for leaf in leaves {
        if !seen.insert(leaf.key.clone()) {
            return Err(RadixMerkleError::DuplicateKey);
        }
        items.push(Item {
            key: leaf.key.clone(),
            path: path_slots(&leaf.key),
            hash: hash_leaf(&leaf.key, &leaf.value_digest),
        });
    }
    let depth = items[0].path.len();
    for item in &items {
        if item.path.len() != depth {
            return Err(RadixMerkleError::MixedKeyLengths {
                expected: depth,
                actual: item.path.len(),
            });
        }
    }
    items.sort_unstable_by(|left, right| left.key.cmp(&right.key));
    let mut counters = Counters::default();
    let node = build_node(0, depth, &items, &mut counters)?;
    let root = if node.leaf || node.path.is_empty() {
        node.hash
    } else {
        hash_extension16(&node.path, &node.hash)?
    };
    Ok(RadixMerkleResult {
        depth,
        leaf_count: leaves.len(),
        branch_count: counters.branches,
        extension_count: counters.extensions,
        max_depth: counters.max_depth,
        root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes32(value: &str) -> [u8; 32] {
        hex::decode(value)
            .expect("hex")
            .try_into()
            .expect("bytes32")
    }

    #[test]
    fn matches_typescript_node_vectors() {
        let key = encode_raw_text_key("alice").expect("key");
        assert_eq!(hex::encode(&key), "0005616c696365");
        assert_eq!(
            hex::encode(pack_path16(&[2, 10, 11]).expect("path")),
            "00032ab0"
        );
        let digest = [1, 2, 3]
            .into_iter()
            .chain(std::iter::repeat_n(0, 29))
            .collect::<Vec<_>>()
            .try_into()
            .expect("bytes32");
        let leaf = hash_leaf(&key, &digest);
        assert_eq!(
            hex::encode(leaf),
            "5d2e8bd92c1cee8fa3362c214a509ad5e334537b30741ff4582b9cdc8dcca83b",
        );
    }

    #[test]
    fn matches_typescript_branch_and_extension_vectors() {
        let leaf = bytes32("27accec6b6720dd397ccace4805e8290858574a31cfbfece36a7875c5d6b7b82");
        let branch = hash_branch16(&[(2, leaf)]).expect("branch");
        assert_eq!(
            hex::encode(branch),
            "af678743f107ab1ab4fb2d004ac1c56b27b92baa03f0b2197ca202b0eb17ca60",
        );
        let edge = hash_extension16(&[10, 11], &branch).expect("extension");
        assert_eq!(
            hex::encode(edge),
            "f787c5dc713bb121a3597ec22439899d63ce94d97f5dd7c18422c2923a0d8f87",
        );
    }
}
