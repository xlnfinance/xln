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

impl<V: Clone + PartialEq> PersistentRadixMap<V> {
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
}
