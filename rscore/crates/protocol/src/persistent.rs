use std::sync::Arc;

use thiserror::Error;

use crate::EMPTY_RADIX_ROOT;
use crate::persistent_node::{
    Node, NodeRef, delete_node, ensure_root_branch, make_branch, make_leaf, node_hash, node_path,
    path_slots, put_node,
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

/// One top-level slot handed to the caller's mapper: the subtree that lives
/// there today and the leaves that belong in it. Opaque on purpose — the
/// caller decides only *where* each slot runs, never what a node looks like.
pub struct SlotWork<V> {
    child: Option<NodeRef<V>>,
    leaves: Vec<NodeRef<V>>,
}

/// The rebuilt subtree of one slot, ready to be hung back under the root.
pub struct SlotOutcome<V> {
    child: Option<NodeRef<V>>,
    inserted: usize,
}

impl<V: Clone> SlotWork<V> {
    /// Whether this slot has leaves to fold. A slot with none still has to be
    /// handed back, but it is not work worth a thread hop; the caller decides
    /// where to run the batch and needs to see how much of it is real.
    pub fn has_work(&self) -> bool {
        !self.leaves.is_empty()
    }

    /// Fold this slot's leaves into its subtree, and hash the result while it
    /// is still on this core — hashing is the expensive half.
    pub fn apply(self) -> Result<SlotOutcome<V>, PersistentRadixMapError> {
        let mut child = self.child;
        let mut inserted = 0;
        for leaf in self.leaves {
            let (node, added) = put_node(child.as_ref(), leaf)?;
            child = Some(node);
            inserted += usize::from(added);
        }
        if let Some(node) = child.as_ref() {
            node_hash(node);
        }
        Ok(SlotOutcome { child, inserted })
    }
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
        self.get_with_digest(key).map(|(value, _)| value)
    }

    /// Return the stored value and its canonical value digest in one walk.
    ///
    /// Callers that need the digest must reuse this byte string: recomputing
    /// it from `V` repeats canonical projection work and risks introducing a
    /// second encoder beside the tree's own committed value.
    pub fn get_with_digest(&self, key: &[u8]) -> Option<(&V, [u8; 32])> {
        let key_path = path_slots(key);
        let mut node = self.root.as_deref();
        while let Some(current) = node {
            if !key_path.starts_with(node_path(current)) {
                return None;
            }
            match current {
                Node::Leaf {
                    key: stored,
                    value,
                    value_digest,
                    ..
                } => return (stored == key).then_some((value, *value_digest)),
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

    /// Apply many updates at once, sharded by the tree's top-level nibble.
    ///
    /// Nodes carry absolute paths, so the sixteen subtrees under the root
    /// branch are independent: each one can be rebuilt — and hashed — on its
    /// own core, and only the root branch is left for the caller. Sequential
    /// path-copy was the part of a commit that no worker count could shrink.
    ///
    /// Same result as folding `updated()` over the entries in order, including
    /// repeated keys (the last write wins), so a caller may choose either.
    pub fn updated_batch(
        &self,
        entries: Vec<(Vec<u8>, V, [u8; 32])>,
        map_slots: impl Fn([SlotWork<V>; 16]) -> [Result<SlotOutcome<V>, PersistentRadixMapError>; 16],
    ) -> Result<Self, PersistentRadixMapError>
    where
        V: Send + Sync,
    {
        if entries.is_empty() {
            return Ok(self.clone());
        }
        for (key, _, _) in &entries {
            if key.is_empty() {
                return Err(PersistentRadixMapError::EmptyKey);
            }
        }
        // The fast path needs the canonical root branch to shard against; a
        // tree of one leaf (or none) has no branch and is folded directly.
        let Some(root) = self.root.as_ref() else {
            return self.fold_updates(entries);
        };
        let Node::Branch { path, children, .. } = &**root else {
            return self.fold_updates(entries);
        };
        if !path.is_empty() {
            return self.fold_updates(entries);
        }
        let mut buckets: [Vec<NodeRef<V>>; 16] = std::array::from_fn(|_| Vec::new());
        for (key, value, digest) in entries {
            let slot = usize::from(path_slots(&key)[0]);
            buckets[slot].push(make_leaf(key, value, digest));
        }
        let mut bucket_iter = buckets.into_iter();
        let mut child_iter = children.iter();
        let work: [SlotWork<V>; 16] = std::array::from_fn(|_| SlotWork {
            child: child_iter.next().and_then(Option::as_ref).map(Arc::clone),
            leaves: bucket_iter.next().unwrap_or_default(),
        });
        let updated = map_slots(work);
        let mut next: [Option<NodeRef<V>>; 16] = std::array::from_fn(|_| None);
        let mut inserted = 0;
        for (slot, result) in updated.into_iter().enumerate() {
            let outcome = result?;
            next[slot] = outcome.child;
            inserted += outcome.inserted;
        }
        Ok(Self {
            root: Some(make_branch(
                Vec::new(),
                &next.iter().flatten().cloned().collect::<Vec<_>>(),
            )),
            len: self.len + inserted,
        })
    }

    fn fold_updates(
        &self,
        entries: Vec<(Vec<u8>, V, [u8; 32])>,
    ) -> Result<Self, PersistentRadixMapError> {
        let mut map = self.clone();
        for (key, value, digest) in entries {
            map = map.updated(key, value, digest)?;
        }
        Ok(map)
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
