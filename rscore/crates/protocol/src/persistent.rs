use std::sync::Arc;

use thiserror::Error;

use crate::EMPTY_RADIX_ROOT;
use crate::persistent_node::{
    Node, NodeRef, delete_node, ensure_root_branch, make_leaf, node_hash, node_path, path_slots,
    put_node,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistentChildRecord {
    pub slot: u8,
    pub kind: &'static str,
    pub path: Vec<u8>,
    pub edge_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PersistentNodeRecord<V> {
    Branch {
        path: Vec<u8>,
        children: Vec<PersistentChildRecord>,
    },
    Leaf {
        path: Vec<u8>,
        key: Vec<u8>,
        value: V,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PersistentNodeRef {
    Branch { path: Vec<u8> },
    Leaf { path: Vec<u8>, key: Vec<u8> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistentNodeChanges<V> {
    pub puts: Vec<PersistentNodeRecord<V>>,
    pub dels: Vec<PersistentNodeRef>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PersistentRadixMapError {
    #[error("PERSISTENT_RADIX_KEY_EMPTY")]
    EmptyKey,
    #[error("PERSISTENT_RADIX_KEY_PREFIX_COLLISION")]
    KeyPrefixCollision,
}

#[derive(Clone)]
pub struct PersistentRadixMap<V> {
    pub(super) root: Option<NodeRef<V>>,
    len: usize,
}

impl<V: Clone> PersistentRadixMap<V> {
    pub fn empty() -> Self {
        Self { root: None, len: 0 }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn get(&self, key: &[u8]) -> Option<&V> {
        let key_path = path_slots(key);
        let mut node = self.root.as_deref();
        while let Some(current) = node {
            if !key_path.starts_with(node_path(current)) {
                return None;
            }
            match current {
                Node::Leaf {
                    key: stored, value, ..
                } => return (stored == key).then_some(value),
                Node::Branch { path, children, .. } => {
                    node = key_path
                        .get(path.len())
                        .copied()
                        .and_then(|slot| children[slot as usize].as_deref());
                }
            }
        }
        None
    }

    pub fn updated(
        &self,
        key: Vec<u8>,
        value: V,
        value_digest: [u8; 32],
    ) -> Result<Self, PersistentRadixMapError> {
        if key.is_empty() {
            return Err(PersistentRadixMapError::EmptyKey);
        }
        let (node, inserted) = put_node(self.root.as_ref(), make_leaf(key, value, value_digest))?;
        if self
            .root
            .as_ref()
            .is_some_and(|root| Arc::ptr_eq(root, &node))
        {
            return Ok(self.clone());
        }
        Ok(Self {
            root: ensure_root_branch(Some(node)),
            len: self.len + usize::from(inserted),
        })
    }

    pub fn removed(&self, key: &[u8]) -> Self {
        let Some(root) = &self.root else {
            return self.clone();
        };
        let (node, deleted) = delete_node(root, &path_slots(key), key);
        if !deleted {
            return self.clone();
        }
        Self {
            root: ensure_root_branch(node),
            len: self.len - 1,
        }
    }

    pub fn root_hash(&self) -> [u8; 32] {
        self.root.as_ref().map_or(EMPTY_RADIX_ROOT, node_hash)
    }

    /// Structural statistics: (branch nodes, leaves, max branch depth from the
    /// root). Extension compression means depth counts actual branch hops, not
    /// nibbles — long shared prefixes collapse into single edges.
    pub fn node_stats(&self) -> (usize, usize, usize) {
        fn walk<V>(node: &Node<V>, depth: usize, stats: &mut (usize, usize, usize)) {
            match node {
                Node::Leaf { .. } => stats.1 += 1,
                Node::Branch { children, .. } => {
                    stats.0 += 1;
                    stats.2 = stats.2.max(depth);
                    for child in children.iter().flatten() {
                        walk(child, depth + 1, stats);
                    }
                }
            }
        }
        let mut stats = (0, 0, 0);
        if let Some(root) = &self.root {
            walk(root, 1, &mut stats);
        }
        stats
    }

    /// Ordered traversal (lexicographic by key bytes — nibble slot order).
    pub fn iter(&self) -> PersistentRadixIter<'_, V> {
        PersistentRadixIter {
            stack: self.root.iter().map(Arc::as_ref).collect(),
        }
    }
}

/// Depth-first walk pushing branch children in reverse slot order, so leaves
/// surface in ascending key order — the canonical iteration the engine and
/// paging reads rely on.
pub struct PersistentRadixIter<'a, V> {
    stack: Vec<&'a Node<V>>,
}

impl<'a, V> Iterator for PersistentRadixIter<'a, V> {
    type Item = (&'a [u8], &'a V);

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(node) = self.stack.pop() {
            match node {
                Node::Leaf { key, value, .. } => return Some((key.as_slice(), value)),
                Node::Branch { children, .. } => {
                    for child in children.iter().rev().flatten() {
                        self.stack.push(child);
                    }
                }
            }
        }
        None
    }
}
