use std::sync::{Arc, OnceLock};

use crate::persistent::PersistentRadixMapError;
use crate::{hash_branch16, hash_extension16, hash_leaf};

pub(super) type NodeRef<V> = Arc<Node<V>>;

pub(super) enum Node<V> {
    Leaf {
        key: Vec<u8>,
        path: Vec<u8>,
        value: V,
        value_digest: [u8; 32],
        hash: OnceLock<[u8; 32]>,
    },
    Branch {
        path: Vec<u8>,
        children: [Option<NodeRef<V>>; 16],
        hash: OnceLock<[u8; 32]>,
    },
}

pub(super) fn path_slots(key: &[u8]) -> Vec<u8> {
    let mut path = Vec::with_capacity(key.len() * 2);
    for byte in key {
        path.push(byte >> 4);
        path.push(byte & 0x0f);
    }
    path
}

pub(super) fn node_path<V>(node: &Node<V>) -> &[u8] {
    match node {
        Node::Leaf { path, .. } | Node::Branch { path, .. } => path,
    }
}

pub(super) fn node_kind<V>(node: &Node<V>) -> &'static str {
    match node {
        Node::Leaf { .. } => "leaf",
        Node::Branch { .. } => "branch",
    }
}

fn common_prefix(left: &[u8], right: &[u8]) -> usize {
    left.iter()
        .zip(right)
        .take_while(|(left, right)| left == right)
        .count()
}

pub(super) fn make_leaf<V>(key: Vec<u8>, value: V, value_digest: [u8; 32]) -> NodeRef<V> {
    Arc::new(Node::Leaf {
        path: path_slots(&key),
        key,
        value,
        value_digest,
        hash: OnceLock::new(),
    })
}

fn make_branch<V>(path: Vec<u8>, nodes: &[NodeRef<V>]) -> NodeRef<V> {
    let mut children = std::array::from_fn(|_| None);
    for node in nodes {
        let slot = node_path(node)[path.len()] as usize;
        assert!(
            children[slot].is_none(),
            "PERSISTENT_RADIX_BRANCH_SLOT_COLLISION"
        );
        children[slot] = Some(Arc::clone(node));
    }
    Arc::new(Node::Branch {
        path,
        children,
        hash: OnceLock::new(),
    })
}

pub(super) fn ensure_root_branch<V>(node: Option<NodeRef<V>>) -> Option<NodeRef<V>> {
    match node {
        Some(node) if matches!(&*node, Node::Branch { path, .. } if path.is_empty()) => Some(node),
        Some(node) => Some(make_branch(Vec::new(), &[node])),
        None => None,
    }
}

pub(super) fn node_hash<V>(node: &NodeRef<V>) -> [u8; 32] {
    match &**node {
        Node::Leaf {
            key,
            value_digest,
            hash,
            ..
        } => *hash.get_or_init(|| hash_leaf(key, value_digest)),
        Node::Branch {
            path,
            children,
            hash,
        } => *hash.get_or_init(|| {
            let child_hashes = children
                .iter()
                .enumerate()
                .filter_map(|(slot, child)| {
                    child
                        .as_ref()
                        .map(|child| (slot as u8, edge_hash(path, child)))
                })
                .collect::<Vec<_>>();
            hash_branch16(&child_hashes).expect("internal radix branch")
        }),
    }
}

pub(super) fn edge_hash<V>(parent_path: &[u8], child: &NodeRef<V>) -> [u8; 32] {
    let hash = node_hash(child);
    match &**child {
        Node::Leaf { .. } => hash,
        Node::Branch { path, .. } => {
            let segment = &path[parent_path.len() + 1..];
            if segment.is_empty() {
                hash
            } else {
                hash_extension16(segment, &hash).expect("internal radix extension")
            }
        }
    }
}

pub(super) fn put_node<V: PartialEq>(
    node: Option<&NodeRef<V>>,
    leaf: NodeRef<V>,
) -> Result<(NodeRef<V>, bool), PersistentRadixMapError> {
    let Some(node) = node else {
        return Ok((leaf, true));
    };
    match &**node {
        Node::Leaf {
            key,
            path,
            value,
            value_digest,
            ..
        } => put_against_leaf(node, leaf, key, path, value, value_digest),
        Node::Branch { path, children, .. } => {
            let leaf_path = node_path(&leaf);
            let shared = common_prefix(path, leaf_path);
            if shared < path.len() {
                return Ok((
                    make_branch(path[..shared].to_vec(), &[Arc::clone(node), leaf]),
                    true,
                ));
            }
            let slot = *leaf_path
                .get(path.len())
                .ok_or(PersistentRadixMapError::KeyPrefixCollision)?
                as usize;
            let (updated, inserted) = put_node(children[slot].as_ref(), leaf)?;
            if children[slot]
                .as_ref()
                .is_some_and(|previous| Arc::ptr_eq(previous, &updated))
            {
                return Ok((Arc::clone(node), inserted));
            }
            let mut next = children.clone();
            next[slot] = Some(updated);
            Ok((
                make_branch(
                    path.clone(),
                    &next.iter().flatten().cloned().collect::<Vec<_>>(),
                ),
                inserted,
            ))
        }
    }
}

fn put_against_leaf<V: PartialEq>(
    node: &NodeRef<V>,
    leaf: NodeRef<V>,
    key: &[u8],
    path: &[u8],
    value: &V,
    value_digest: &[u8; 32],
) -> Result<(NodeRef<V>, bool), PersistentRadixMapError> {
    let Node::Leaf {
        key: leaf_key,
        path: leaf_path,
        value: leaf_value,
        value_digest: leaf_digest,
        ..
    } = &*leaf
    else {
        unreachable!()
    };
    if key == leaf_key {
        return if value_digest == leaf_digest && value == leaf_value {
            Ok((Arc::clone(node), false))
        } else {
            Ok((leaf, false))
        };
    }
    let shared = common_prefix(path, leaf_path);
    if shared >= path.len() || shared >= leaf_path.len() {
        return Err(PersistentRadixMapError::KeyPrefixCollision);
    }
    Ok((
        make_branch(path[..shared].to_vec(), &[Arc::clone(node), leaf]),
        true,
    ))
}

pub(super) fn delete_node<V>(
    node: &NodeRef<V>,
    path: &[u8],
    key: &[u8],
) -> (Option<NodeRef<V>>, bool) {
    if !path.starts_with(node_path(node)) {
        return (Some(Arc::clone(node)), false);
    }
    match &**node {
        Node::Leaf { key: stored, .. } => {
            if stored == key {
                (None, true)
            } else {
                (Some(Arc::clone(node)), false)
            }
        }
        Node::Branch {
            path: branch_path,
            children,
            ..
        } => delete_from_branch(node, path, key, branch_path, children),
    }
}

fn delete_from_branch<V>(
    node: &NodeRef<V>,
    path: &[u8],
    key: &[u8],
    branch_path: &[u8],
    children: &[Option<NodeRef<V>>; 16],
) -> (Option<NodeRef<V>>, bool) {
    let Some(slot) = path.get(branch_path.len()).map(|slot| *slot as usize) else {
        return (Some(Arc::clone(node)), false);
    };
    let Some(child) = &children[slot] else {
        return (Some(Arc::clone(node)), false);
    };
    let (updated, deleted) = delete_node(child, path, key);
    if !deleted {
        return (Some(Arc::clone(node)), false);
    }
    let mut next = children.clone();
    next[slot] = updated;
    let remaining = next.iter().flatten().cloned().collect::<Vec<_>>();
    match remaining.len() {
        0 => (None, true),
        1 => (remaining.into_iter().next(), true),
        _ => (Some(make_branch(branch_path.to_vec(), &remaining)), true),
    }
}
