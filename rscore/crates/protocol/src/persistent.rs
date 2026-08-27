use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use thiserror::Error;

use crate::persistent_node::{
    Node, NodeRef, delete_node, ensure_root_branch, make_branch, make_leaf, node_hash, node_path,
    path_slots, put_node, validate_child_edge,
};
use crate::{EMPTY_RADIX_ROOT, hash_branch16, hash_extension16};

pub const PERSISTENT_RADIX_SHARD_DEPTH: usize = 3;
pub const PERSISTENT_RADIX_SHARD_COUNT: usize = 4096;

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
    #[error("PERSISTENT_RADIX_KEY_PATH_TOO_LONG:{actual}:max={maximum}")]
    KeyPathTooLong { actual: usize, maximum: usize },
    #[error("PERSISTENT_RADIX_EXTENSION_PATH_TOO_LONG:{actual}:max={maximum}")]
    ExtensionPathTooLong { actual: usize, maximum: usize },
    #[error("PERSISTENT_RADIX_BRANCH_SLOT_COLLISION:{slot}")]
    BranchSlotCollision { slot: usize },
    #[error("PERSISTENT_RADIX_KEY_DEPTH:{actual}:required={required}")]
    KeyDepth { actual: usize, required: usize },
    #[error("PERSISTENT_RADIX_SLOT_COUNT:{actual}:expected={expected}")]
    SlotCount { actual: usize, expected: usize },
    #[error("PERSISTENT_RADIX_SHARD_INDEX:{actual}:max={max}")]
    ShardIndex { actual: usize, max: usize },
    #[error("PERSISTENT_RADIX_SHARD_KEY:{actual}:expected={expected}")]
    ShardKey { actual: usize, expected: usize },
    #[error("PERSISTENT_RADIX_SHARD_DUPLICATE:{index}")]
    DuplicateShard { index: usize },
    #[error("PERSISTENT_RADIX_SHARD_EMPTY_LENGTH:{index}:len={len}")]
    EmptyShardLength { index: usize, len: usize },
    #[error("PERSISTENT_RADIX_SHARD_LENGTH:{actual}:expected={expected}")]
    ShardLength { actual: usize, expected: usize },
    #[error("PERSISTENT_RADIX_OVERLAY_BASE:{actual:?}:expected={expected:?}")]
    OverlayBase {
        actual: [u8; 32],
        expected: [u8; 32],
    },
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

/// The canonical Patricia subtree for one exact three-nibble prefix.
///
/// A resident worker keeps this value between waves. Its nodes retain their
/// absolute Patricia paths, so updates need neither a copy of the whole map nor
/// any synthetic per-shard hashing domain. The coordinator only receives an
/// opaque descriptor after this shard changes.
#[derive(Clone)]
pub struct PersistentRadixShard<V> {
    index: usize,
    child: Option<NodeRef<V>>,
    len: usize,
}

/// The value-free commitment of one changed subtree.
///
/// It contains only the canonical Patricia kind, absolute path and hash. No
/// value-bearing node pointer crosses from a resident worker to the
/// coordinator, and the hash is a commitment rather than a storage address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PersistentRadixSubtreeKind {
    Branch,
    Leaf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistentRadixSubtreeRoot {
    kind: PersistentRadixSubtreeKind,
    path: Vec<u8>,
    hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistentRadixShardDescriptor {
    index: usize,
    root: Option<PersistentRadixSubtreeRoot>,
    len: usize,
}

/// Cached canonical tree above the fixed three-nibble shard boundary.
///
/// `with_dirty_descriptors` consumes and returns this value so no 4096-entry
/// array is cloned per wave. Only the compact ancestors of dirty shard roots
/// are rebuilt; untouched value-free commitments are retained verbatim.
#[cfg_attr(test, derive(Clone))]
pub struct PersistentRadixShardCoordinator {
    shards: Vec<Option<PersistentRadixSubtreeRoot>>,
    shard_lens: Vec<usize>,
    second_level: Vec<Option<PersistentRadixSubtreeRoot>>,
    root_children: [Option<PersistentRadixSubtreeRoot>; 16],
    root_hash: [u8; 32],
    len: usize,
}

/// Sparse, value-free change set above a resident shard forest.
///
/// The base coordinator owns the one 4096-entry descriptor table. An overlay
/// retains only descriptors changed since that base plus the affected 256-way,
/// 16-way and root commitments. Chaining an outbound overlay over an inbound
/// overlay is therefore O(changed shards), never O(all shards).
#[derive(Clone)]
pub struct PersistentRadixShardOverlay {
    base_root: [u8; 32],
    dirty: BTreeMap<usize, PersistentRadixShardDescriptor>,
    second_level: BTreeMap<usize, Option<PersistentRadixSubtreeRoot>>,
    root_children: BTreeMap<usize, Option<PersistentRadixSubtreeRoot>>,
    root_hash: [u8; 32],
    len: usize,
    work: PersistentRadixOverlayWork,
}

/// Exact amount of coordinator work used to construct one sparse overlay.
/// These counters are deterministic diagnostics and never affect scheduling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PersistentRadixOverlayWork {
    pub dirty_descriptors: usize,
    pub second_level_folds: usize,
    pub first_level_folds: usize,
    pub root_folds: usize,
}

impl<V: Clone> SlotWork<V> {
    /// Whether this slot has leaves to fold. A slot with none still has to be
    /// handed back, but it is not work worth a thread hop; the caller decides
    /// where to run the batch and needs to see how much of it is real.
    pub fn has_work(&self) -> bool {
        !self.leaves.is_empty()
    }

    pub fn work_len(&self) -> usize {
        self.leaves.len()
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

impl PersistentRadixSubtreeRoot {
    pub fn kind(&self) -> &PersistentRadixSubtreeKind {
        &self.kind
    }

    pub fn path(&self) -> &[u8] {
        &self.path
    }

    pub fn hash(&self) -> [u8; 32] {
        self.hash
    }
}

impl PersistentRadixShardDescriptor {
    pub fn index(&self) -> usize {
        self.index
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn root(&self) -> Option<&PersistentRadixSubtreeRoot> {
        self.root.as_ref()
    }
}

impl PersistentRadixShardOverlay {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn root_hash(&self) -> [u8; 32] {
        self.root_hash
    }

    pub fn dirty_len(&self) -> usize {
        self.dirty.len()
    }

    pub fn work(&self) -> PersistentRadixOverlayWork {
        self.work
    }

}

impl<V: Clone> PersistentRadixShard<V> {
    pub fn empty(index: usize) -> Result<Self, PersistentRadixMapError> {
        validate_shard_index(index)?;
        Ok(Self {
            index,
            child: None,
            len: 0,
        })
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn prefix(&self) -> [u8; PERSISTENT_RADIX_SHARD_DEPTH] {
        shard_prefix(self.index)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn root_hash(&self) -> Option<[u8; 32]> {
        self.child.as_ref().map(node_hash)
    }

    pub fn descriptor(&self) -> PersistentRadixShardDescriptor {
        PersistentRadixShardDescriptor {
            index: self.index,
            root: self.child.as_ref().map(subtree_root),
            len: self.len,
        }
    }

    pub fn get(&self, key: &[u8]) -> Result<Option<&V>, PersistentRadixMapError> {
        self.get_with_digest(key)
            .map(|entry| entry.map(|(value, _)| value))
    }

    pub fn get_with_digest(
        &self,
        key: &[u8],
    ) -> Result<Option<(&V, [u8; 32])>, PersistentRadixMapError> {
        let key_path = validate_shard_key(self.index, key)?;
        let mut node = self.child.as_deref();
        while let Some(current) = node {
            if !key_path.starts_with(node_path(current)) {
                return Ok(None);
            }
            match current {
                Node::Leaf {
                    key: stored,
                    value,
                    value_digest,
                    ..
                } => return Ok((stored == key).then_some((value, *value_digest))),
                Node::Branch { path, children, .. } => {
                    node = key_path
                        .get(path.len())
                        .and_then(|slot| children[*slot as usize].as_deref());
                }
            }
        }
        Ok(None)
    }

    pub fn updated(
        &self,
        key: Vec<u8>,
        value: V,
        value_digest: [u8; 32],
    ) -> Result<Self, PersistentRadixMapError> {
        validate_shard_key(self.index, &key)?;
        let (child, inserted) = put_node(self.child.as_ref(), make_leaf(key, value, value_digest))?;
        // A lone top-level shard is path-compressed directly under the root.
        // Validate against that worst-case parent, not merely depth two.
        validate_child_edge(&[], &child)?;
        if self
            .child
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, &child))
        {
            return Ok(self.clone());
        }
        Ok(Self {
            index: self.index,
            child: Some(child),
            len: self.len + usize::from(inserted),
        })
    }

    pub fn updated_batch(
        &self,
        entries: Vec<(Vec<u8>, V, [u8; 32])>,
    ) -> Result<Self, PersistentRadixMapError> {
        for (key, _, _) in &entries {
            validate_shard_key(self.index, key)?;
        }
        let mut shard = self.clone();
        for (key, value, value_digest) in entries {
            shard = shard.updated(key, value, value_digest)?;
        }
        Ok(shard)
    }

    pub fn removed(&self, key: &[u8]) -> Result<Self, PersistentRadixMapError> {
        let path = validate_shard_key(self.index, key)?;
        let Some(child) = self.child.as_ref() else {
            return Ok(self.clone());
        };
        let (child, deleted) = delete_node(child, &path, key)?;
        if !deleted {
            return Ok(self.clone());
        }
        if let Some(child) = &child {
            validate_child_edge(&[], child)?;
        }
        Ok(Self {
            index: self.index,
            child,
            len: self.len - 1,
        })
    }

    pub fn iter(&self) -> PersistentRadixIter<'_, V> {
        PersistentRadixIter {
            stack: self.child.iter().map(Arc::as_ref).collect(),
        }
    }

    pub fn node_records(&self) -> Vec<PersistentNodeRecord<V>> {
        self.as_subtree_map().node_records()
    }

    pub fn node_changes_since(
        &self,
        previous: &Self,
    ) -> Result<PersistentNodeChanges<V>, PersistentRadixMapError> {
        if self.index != previous.index {
            return Err(PersistentRadixMapError::ShardKey {
                actual: previous.index,
                expected: self.index,
            });
        }
        Ok(self
            .as_subtree_map()
            .node_changes_since(&previous.as_subtree_map()))
    }

    fn as_subtree_map(&self) -> PersistentRadixMap<V> {
        PersistentRadixMap {
            root: self.child.clone(),
            len: self.len,
        }
    }
}

impl PersistentRadixShardCoordinator {
    pub fn from_descriptors(
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) -> Result<Self, PersistentRadixMapError> {
        let (shards, shard_lens) = ordered_descriptor_parts(descriptors)?;
        Ok(Self::from_ordered_parts(shards, shard_lens))
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn root_hash(&self) -> [u8; 32] {
        self.root_hash
    }

    pub fn shard_root(
        &self,
        index: usize,
    ) -> Result<Option<&PersistentRadixSubtreeRoot>, PersistentRadixMapError> {
        validate_shard_index(index)?;
        Ok(self.shards[index].as_ref())
    }

    /// Canonical records for only the value-free branches above depth three.
    /// Concatenate these with every shard's `node_records()` and sort by
    /// `(path, branch-before-leaf)` to obtain the exact whole-map checkpoint.
    pub fn node_records(&self) -> Vec<PersistentNodeRecord<()>> {
        let mut records = Vec::new();
        if self.len == 0 {
            return records;
        }
        records.push(commitment_branch_record(Vec::new(), &self.root_children));
        for first in 0..16 {
            if self.root_children[first]
                .as_ref()
                .is_some_and(|root| is_top_branch(root, 1))
            {
                records.push(commitment_branch_record(
                    vec![first as u8],
                    &self.second_level[first * 16..(first + 1) * 16],
                ));
            }
            for second in first * 16..(first + 1) * 16 {
                if self.second_level[second]
                    .as_ref()
                    .is_some_and(|root| is_top_branch(root, 2))
                {
                    records.push(commitment_branch_record(
                        vec![(second / 16) as u8, (second % 16) as u8],
                        &self.shards[second * 16..(second + 1) * 16],
                    ));
                }
            }
        }
        records
    }

    pub fn node_changes_since(&self, previous: &Self) -> PersistentNodeChanges<()> {
        let records = self.node_records();
        let previous_records = previous.node_records();
        let puts = records
            .iter()
            .filter(|record| !has_equal_top_record(&previous_records, record))
            .cloned()
            .collect();
        let dels = previous_records
            .iter()
            .filter(|record| !has_top_path(&records, top_record_path(record)))
            .map(|record| PersistentNodeRef::Branch {
                path: top_record_path(record).to_vec(),
            })
            .collect();
        PersistentNodeChanges { puts, dels }
    }

    /// Fold only `descriptors` above this base, optionally composing them over
    /// an existing sparse overlay from the same base coordinator.
    pub fn sparse_overlay(
        &self,
        parent: Option<&PersistentRadixShardOverlay>,
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) -> Result<PersistentRadixShardOverlay, PersistentRadixMapError> {
        if let Some(parent) = parent {
            self.validate_overlay_base(parent)?;
        }
        let overlay = parent.cloned().unwrap_or_else(|| self.empty_overlay());
        self.extend_sparse_overlay(overlay, descriptors)
    }

    /// Extend an owned overlay without cloning any accumulated sparse maps.
    pub fn sparse_overlay_owned(
        &self,
        parent: PersistentRadixShardOverlay,
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) -> Result<PersistentRadixShardOverlay, PersistentRadixMapError> {
        self.validate_overlay_base(&parent)?;
        self.extend_sparse_overlay(parent, descriptors)
    }

    fn empty_overlay(&self) -> PersistentRadixShardOverlay {
        PersistentRadixShardOverlay {
            base_root: self.root_hash,
            dirty: BTreeMap::new(),
            second_level: BTreeMap::new(),
            root_children: BTreeMap::new(),
            root_hash: self.root_hash,
            len: self.len,
            work: PersistentRadixOverlayWork::default(),
        }
    }

    fn extend_sparse_overlay(
        &self,
        mut overlay: PersistentRadixShardOverlay,
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) -> Result<PersistentRadixShardOverlay, PersistentRadixMapError> {
        validate_dirty_descriptors(&descriptors)?;
        let dirty_second = descriptor_ancestors(&descriptors, 16);
        let dirty_first = descriptor_ancestors(&descriptors, 256);
        let descriptor_count = descriptors.len();
        self.merge_overlay_descriptors(&mut overlay, descriptors);
        self.fold_overlay_second(&mut overlay, &dirty_second);
        self.fold_overlay_first(&mut overlay, &dirty_first);
        self.finish_overlay(&mut overlay, descriptor_count, &dirty_second, &dirty_first);
        Ok(overlay)
    }

    fn merge_overlay_descriptors(
        &self,
        overlay: &mut PersistentRadixShardOverlay,
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) {
        for descriptor in descriptors {
            let index = descriptor.index;
            let previous = overlay
                .dirty
                .get(&index)
                .map_or(self.shard_lens[index], PersistentRadixShardDescriptor::len);
            overlay.len = overlay.len - previous + descriptor.len;
            overlay.dirty.insert(index, descriptor);
        }
    }

    fn fold_overlay_second(
        &self,
        overlay: &mut PersistentRadixShardOverlay,
        indexes: &BTreeSet<usize>,
    ) {
        for index in indexes {
            let children = ((*index * 16)..(*index * 16 + 16))
                .filter_map(|shard| overlay_shard_root(self, overlay, shard))
                .collect();
            let path = vec![(*index / 16) as u8, (*index % 16) as u8];
            overlay
                .second_level
                .insert(*index, compressed_commitment_parent(path, children));
        }
    }

    fn fold_overlay_first(
        &self,
        overlay: &mut PersistentRadixShardOverlay,
        indexes: &BTreeSet<usize>,
    ) {
        for index in indexes {
            let children = ((*index * 16)..(*index * 16 + 16))
                .filter_map(|second| overlay_second_root(self, overlay, second))
                .collect();
            overlay.root_children.insert(
                *index,
                compressed_commitment_parent(vec![*index as u8], children),
            );
        }
    }

    fn finish_overlay(
        &self,
        overlay: &mut PersistentRadixShardOverlay,
        count: usize,
        second: &BTreeSet<usize>,
        first: &BTreeSet<usize>,
    ) {
        let children = std::array::from_fn(|index| overlay_first_root(self, overlay, index));
        overlay.root_hash = top_root_hash(&children);
        overlay.work = PersistentRadixOverlayWork {
            dirty_descriptors: count,
            second_level_folds: second.len(),
            first_level_folds: first.len(),
            root_folds: usize::from(!second.is_empty()),
        };
    }

    /// Promote a sparse overlay into the sole base descriptor table.
    ///
    /// This updates only dirty shard slots and their cached ancestors. The
    /// overlay is value-free, so promotion cannot move Account values into the
    /// coordinator.
    pub fn apply_sparse_overlay(
        &mut self,
        overlay: &PersistentRadixShardOverlay,
    ) -> Result<(), PersistentRadixMapError> {
        self.validate_overlay_base(overlay)?;
        for (index, descriptor) in &overlay.dirty {
            self.shards[*index] = descriptor.root.clone();
            self.shard_lens[*index] = descriptor.len;
        }
        for (index, root) in &overlay.second_level {
            self.second_level[*index] = root.clone();
        }
        for (index, root) in &overlay.root_children {
            self.root_children[*index] = root.clone();
        }
        self.root_hash = overlay.root_hash;
        self.len = overlay.len;
        Ok(())
    }

    pub fn with_dirty_descriptors(
        mut self,
        descriptors: Vec<PersistentRadixShardDescriptor>,
    ) -> Result<Self, PersistentRadixMapError> {
        let overlay = self.sparse_overlay(None, descriptors)?;
        self.apply_sparse_overlay(&overlay)?;
        Ok(self)
    }

    fn validate_overlay_base(
        &self,
        overlay: &PersistentRadixShardOverlay,
    ) -> Result<(), PersistentRadixMapError> {
        if overlay.base_root != self.root_hash {
            return Err(PersistentRadixMapError::OverlayBase {
                actual: overlay.base_root,
                expected: self.root_hash,
            });
        }
        Ok(())
    }

    fn from_ordered_parts(
        shards: Vec<Option<PersistentRadixSubtreeRoot>>,
        shard_lens: Vec<usize>,
    ) -> Self {
        let second_level = build_second_level(&shards);
        let root_children = build_first_level(&second_level);
        let root_hash = top_root_hash(&root_children);
        let len = shard_lens.iter().sum();
        Self {
            shards,
            shard_lens,
            second_level,
            root_children,
            root_hash,
            len,
        }
    }
}

fn descriptor_ancestors(
    descriptors: &[PersistentRadixShardDescriptor],
    divisor: usize,
) -> BTreeSet<usize> {
    descriptors
        .iter()
        .map(|descriptor| descriptor.index / divisor)
        .collect()
}

fn overlay_shard_root(
    base: &PersistentRadixShardCoordinator,
    overlay: &PersistentRadixShardOverlay,
    index: usize,
) -> Option<PersistentRadixSubtreeRoot> {
    overlay
        .dirty
        .get(&index)
        .map(|descriptor| descriptor.root.clone())
        .unwrap_or_else(|| base.shards[index].clone())
}

fn overlay_second_root(
    base: &PersistentRadixShardCoordinator,
    overlay: &PersistentRadixShardOverlay,
    index: usize,
) -> Option<PersistentRadixSubtreeRoot> {
    overlay
        .second_level
        .get(&index)
        .cloned()
        .unwrap_or_else(|| base.second_level[index].clone())
}

fn overlay_first_root(
    base: &PersistentRadixShardCoordinator,
    overlay: &PersistentRadixShardOverlay,
    index: usize,
) -> Option<PersistentRadixSubtreeRoot> {
    overlay
        .root_children
        .get(&index)
        .cloned()
        .unwrap_or_else(|| base.root_children[index].clone())
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

    /// Transfer the map below the exact three-nibble boundary into 4096
    /// independently-owned shard states plus a value-free top coordinator.
    ///
    /// This consumes the source map. After it returns and the old top nodes are
    /// dropped, only the shard states retain Account values; the coordinator
    /// retains compact `(kind, absolute path, hash, len)` commitments.
    pub fn into_three_nibble_shards(
        self,
    ) -> Result<
        (
            Vec<PersistentRadixShard<V>>,
            PersistentRadixShardCoordinator,
        ),
        PersistentRadixMapError,
    > {
        let mut children = empty_shard_nodes();
        if let Some(root) = self.root.as_ref() {
            let Node::Branch { path, .. } = &**root else {
                return Err(PersistentRadixMapError::KeyPrefixCollision);
            };
            if !path.is_empty() {
                return Err(PersistentRadixMapError::KeyPrefixCollision);
            }
            collect_prefix_subtrees(root, PERSISTENT_RADIX_SHARD_DEPTH, &mut children)?;
        }
        let lengths = children
            .iter()
            .map(|child| child.as_ref().map_or(0, subtree_len))
            .collect::<Vec<_>>();
        let total = lengths.iter().sum();
        if total != self.len {
            return Err(PersistentRadixMapError::ShardLength {
                actual: total,
                expected: self.len,
            });
        }
        let descriptors = children
            .iter()
            .zip(&lengths)
            .enumerate()
            .map(|(index, (child, len))| PersistentRadixShardDescriptor {
                index,
                root: child.as_ref().map(subtree_root),
                len: *len,
            })
            .collect::<Vec<_>>();
        let coordinator = PersistentRadixShardCoordinator::from_descriptors(descriptors)?;
        let shards = children
            .into_iter()
            .zip(lengths)
            .enumerate()
            .map(|(index, (child, len))| PersistentRadixShard { index, child, len })
            .collect();
        Ok((shards, coordinator))
    }

    /// Reconstruct the exact canonical map by consuming all 4096 shard states.
    ///
    /// This is a restore/test boundary, not the hot coordinator path. A live
    /// coordinator never calls it and never receives the value-bearing nodes.
    pub fn from_three_nibble_shards(
        shards: Vec<PersistentRadixShard<V>>,
    ) -> Result<Self, PersistentRadixMapError> {
        let (children, lengths) = ordered_shard_parts(shards)?;
        let len = lengths.iter().sum();
        Ok(Self {
            root: build_node_root(&children)?,
            len,
        })
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
        if validate_key_path(key).is_err() {
            return None;
        }
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
        validate_key_path(&key)?;
        let (node, inserted) = put_node(self.root.as_ref(), make_leaf(key, value, value_digest))?;
        if self
            .root
            .as_ref()
            .is_some_and(|root| Arc::ptr_eq(root, &node))
        {
            return Ok(self.clone());
        }
        Ok(Self {
            root: ensure_root_branch(Some(node))?,
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
            validate_key_path(key)?;
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
            )?),
            len: self.len + inserted,
        })
    }

    /// Apply a large batch as 256 independent two-nibble Patricia prefixes.
    ///
    /// `updated_batch` deliberately exposes only the root's sixteen children,
    /// which is the cheapest shape for ordinary waves. A large hub wave on a
    /// pool wider than sixteen cores would otherwise leave every extra core
    /// idle while one worker folds all leaves under each root child. This
    /// variant decomposes an existing compressed child at the next canonical
    /// nibble, lets the caller schedule those 256 subtrees, then reconnects
    /// them at sixteen prefix branches and one root. No Account work crosses a
    /// prefix and only completed subtree roots meet above that boundary.
    pub fn updated_batch_two_levels(
        &self,
        entries: Vec<(Vec<u8>, V, [u8; 32])>,
        map_slots: impl Fn([SlotWork<V>; 256]) -> [Result<SlotOutcome<V>, PersistentRadixMapError>; 256],
    ) -> Result<Self, PersistentRadixMapError>
    where
        V: Send + Sync,
    {
        if entries.is_empty() {
            return Ok(self.clone());
        }
        for (key, _, _) in &entries {
            validate_key_path(key)?;
        }
        let Some(root) = self.root.as_ref() else {
            return self.fold_updates(entries);
        };
        let Node::Branch { path, children, .. } = &**root else {
            return self.fold_updates(entries);
        };
        if !path.is_empty() {
            return self.fold_updates(entries);
        }

        let mut existing: [Option<NodeRef<V>>; 256] = std::array::from_fn(|_| None);
        for (root_slot, child) in children.iter().enumerate() {
            let Some(child) = child else { continue };
            match &**child {
                Node::Branch {
                    path,
                    children: grandchildren,
                    ..
                } if path.len() == 1 => {
                    for (second_slot, grandchild) in grandchildren.iter().enumerate() {
                        if let Some(grandchild) = grandchild {
                            existing[root_slot * 16 + second_slot] = Some(Arc::clone(grandchild));
                        }
                    }
                }
                _ => {
                    let child_path = node_path(child);
                    let second_slot = usize::from(
                        *child_path
                            .get(1)
                            .ok_or(PersistentRadixMapError::KeyPrefixCollision)?,
                    );
                    existing[root_slot * 16 + second_slot] = Some(Arc::clone(child));
                }
            }
        }

        let mut buckets: [Vec<NodeRef<V>>; 256] = std::array::from_fn(|_| Vec::new());
        for (key, value, digest) in entries {
            let path = path_slots(&key);
            let slot = usize::from(path[0]) * 16 + usize::from(path[1]);
            buckets[slot].push(make_leaf(key, value, digest));
        }
        let mut existing = existing.into_iter();
        let mut buckets = buckets.into_iter();
        let work: [SlotWork<V>; 256] = std::array::from_fn(|_| SlotWork {
            child: existing.next().flatten(),
            leaves: buckets.next().unwrap_or_default(),
        });
        let updated = map_slots(work);
        let mut outcomes = updated.into_iter();
        let mut root_children: [Option<NodeRef<V>>; 16] = std::array::from_fn(|_| None);
        let mut inserted = 0;
        for (root_slot, root_child) in root_children.iter_mut().enumerate() {
            let mut children = Vec::new();
            for _ in 0..16 {
                let outcome = outcomes.next().ok_or(PersistentRadixMapError::EmptyKey)??;
                inserted += outcome.inserted;
                if let Some(child) = outcome.child {
                    children.push(child);
                }
            }
            *root_child = match children.len() {
                0 => None,
                1 => children.into_iter().next(),
                _ => Some(make_branch(vec![root_slot as u8], &children)?),
            };
        }
        Ok(Self {
            root: Some(make_branch(
                Vec::new(),
                &root_children.iter().flatten().cloned().collect::<Vec<_>>(),
            )?),
            len: self.len + inserted,
        })
    }

    /// Apply a large Account batch as 4096 independent three-nibble prefixes.
    ///
    /// The caller owns scheduling only. This map still owns the canonical
    /// Patricia representation: it decomposes compressed branches at the
    /// three-nibble boundary, accepts rebuilt subtree roots, and reconnects
    /// exactly two parent levels plus the root. Values are ordinary keyed
    /// leaves, not content-addressed nodes; unchanged branches are shared by
    /// `Arc` only for in-memory path-copy efficiency.
    pub fn updated_batch_three_levels(
        &self,
        entries: Vec<(Vec<u8>, V, [u8; 32])>,
        map_slots: impl Fn(Vec<SlotWork<V>>) -> Vec<Result<SlotOutcome<V>, PersistentRadixMapError>>,
    ) -> Result<Self, PersistentRadixMapError>
    where
        V: Send + Sync,
    {
        if entries.is_empty() {
            return Ok(self.clone());
        }
        for (key, _, _) in &entries {
            let depth = validate_key_path(key)?;
            if depth < PERSISTENT_RADIX_SHARD_DEPTH {
                return Err(PersistentRadixMapError::KeyDepth {
                    actual: depth,
                    required: PERSISTENT_RADIX_SHARD_DEPTH,
                });
            }
        }
        let mut existing = (0..PERSISTENT_RADIX_SHARD_COUNT)
            .map(|_| None)
            .collect::<Vec<_>>();
        if let Some(root) = self.root.as_ref() {
            let Node::Branch { path, .. } = &**root else {
                return self.fold_updates(entries);
            };
            if !path.is_empty() {
                return self.fold_updates(entries);
            }
            collect_prefix_subtrees(root, PERSISTENT_RADIX_SHARD_DEPTH, &mut existing)?;
        }
        let mut buckets = (0..PERSISTENT_RADIX_SHARD_COUNT)
            .map(|_| Vec::new())
            .collect::<Vec<_>>();
        for (key, value, digest) in entries {
            let path = path_slots(&key);
            buckets[prefix_index(&path, PERSISTENT_RADIX_SHARD_DEPTH)?]
                .push(make_leaf(key, value, digest));
        }
        let work = existing
            .into_iter()
            .zip(buckets)
            .map(|(child, leaves)| SlotWork { child, leaves })
            .collect::<Vec<_>>();
        let updated = map_slots(work);
        if updated.len() != PERSISTENT_RADIX_SHARD_COUNT {
            return Err(PersistentRadixMapError::SlotCount {
                actual: updated.len(),
                expected: PERSISTENT_RADIX_SHARD_COUNT,
            });
        }

        let mut outcomes = updated.into_iter();
        let mut second_level = (0..256).map(|_| None).collect::<Vec<_>>();
        let mut inserted = 0;
        for (prefix, parent) in second_level.iter_mut().enumerate() {
            let mut children = Vec::new();
            for _ in 0..16 {
                let outcome = outcomes.next().ok_or(PersistentRadixMapError::SlotCount {
                    actual: PERSISTENT_RADIX_SHARD_COUNT - outcomes.len(),
                    expected: PERSISTENT_RADIX_SHARD_COUNT,
                })??;
                inserted += outcome.inserted;
                if let Some(child) = outcome.child {
                    children.push(child);
                }
            }
            *parent = compressed_parent(vec![(prefix / 16) as u8, (prefix % 16) as u8], children)?;
        }

        let mut root_children: [Option<NodeRef<V>>; 16] = std::array::from_fn(|_| None);
        for (root_slot, root_child) in root_children.iter_mut().enumerate() {
            let children = second_level[root_slot * 16..(root_slot + 1) * 16]
                .iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>();
            *root_child = compressed_parent(vec![root_slot as u8], children)?;
        }
        Ok(Self {
            root: Some(make_branch(
                Vec::new(),
                &root_children.iter().flatten().cloned().collect::<Vec<_>>(),
            )?),
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

    pub fn removed(&self, key: &[u8]) -> Result<Self, PersistentRadixMapError> {
        validate_key_path(key)?;
        let Some(root) = &self.root else {
            return Ok(self.clone());
        };
        let (node, deleted) = delete_node(root, &path_slots(key), key)?;
        if !deleted {
            return Ok(self.clone());
        }
        Ok(Self {
            root: ensure_root_branch(node)?,
            len: self.len - 1,
        })
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

    /// Return the lexicographically last entry whose key starts with `prefix`.
    ///
    /// A Patricia seek follows the one edge selected by each prefix nibble and
    /// then the right-most edge below that subtree. It therefore does not scan
    /// unrelated leaves, which matters for append-only page families sharing
    /// one map. An empty prefix intentionally selects the map's final entry.
    pub fn last_with_prefix(&self, prefix: &[u8]) -> Option<(&[u8], &V)> {
        let mut visited = 0;
        self.last_with_prefix_internal(prefix, &mut visited)
    }

    fn last_with_prefix_internal<'a>(
        &'a self,
        prefix: &[u8],
        visited: &mut usize,
    ) -> Option<(&'a [u8], &'a V)> {
        let prefix_path = path_slots(prefix);
        let mut node = self.root.as_deref()?;
        loop {
            *visited += 1;
            match node {
                Node::Leaf { key, value, .. } => {
                    return key.starts_with(prefix).then_some((key.as_slice(), value));
                }
                Node::Branch { path, children, .. } => {
                    if path.starts_with(&prefix_path) {
                        return rightmost_leaf(node, visited);
                    }
                    if !prefix_path.starts_with(path) {
                        return None;
                    }
                    let slot = usize::from(*prefix_path.get(path.len())?);
                    node = children[slot].as_deref()?;
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn last_with_prefix_node_visits(&self, prefix: &[u8]) -> usize {
        let mut visited = 0;
        let _ = self.last_with_prefix_internal(prefix, &mut visited);
        visited
    }
}

fn rightmost_leaf<'a, V>(mut node: &'a Node<V>, visited: &mut usize) -> Option<(&'a [u8], &'a V)> {
    loop {
        match node {
            Node::Leaf { key, value, .. } => return Some((key.as_slice(), value)),
            Node::Branch { children, .. } => {
                node = children.iter().rev().flatten().next()?.as_ref();
                *visited += 1;
            }
        }
    }
}

fn validate_key_path(key: &[u8]) -> Result<usize, PersistentRadixMapError> {
    if key.is_empty() {
        return Err(PersistentRadixMapError::EmptyKey);
    }
    let actual = key
        .len()
        .checked_mul(2)
        .ok_or(PersistentRadixMapError::KeyPathTooLong {
            actual: usize::MAX,
            maximum: usize::MAX / 2,
        })?;
    Ok(actual)
}

fn validate_shard_index(index: usize) -> Result<(), PersistentRadixMapError> {
    if index >= PERSISTENT_RADIX_SHARD_COUNT {
        return Err(PersistentRadixMapError::ShardIndex {
            actual: index,
            max: PERSISTENT_RADIX_SHARD_COUNT - 1,
        });
    }
    Ok(())
}

fn shard_prefix(index: usize) -> [u8; PERSISTENT_RADIX_SHARD_DEPTH] {
    [
        ((index >> 8) & 0x0f) as u8,
        ((index >> 4) & 0x0f) as u8,
        (index & 0x0f) as u8,
    ]
}

fn validate_shard_key(index: usize, key: &[u8]) -> Result<Vec<u8>, PersistentRadixMapError> {
    validate_shard_index(index)?;
    validate_key_path(key)?;
    let path = path_slots(key);
    let actual = prefix_index(&path, PERSISTENT_RADIX_SHARD_DEPTH)?;
    if actual != index {
        return Err(PersistentRadixMapError::ShardKey {
            actual,
            expected: index,
        });
    }
    Ok(path)
}

fn validate_subtree_root(
    index: usize,
    root: &PersistentRadixSubtreeRoot,
) -> Result<(), PersistentRadixMapError> {
    let actual = prefix_index(&root.path, PERSISTENT_RADIX_SHARD_DEPTH)?;
    if actual != index {
        return Err(PersistentRadixMapError::ShardKey {
            actual,
            expected: index,
        });
    }
    validate_commitment_shard_edge(root)?;
    Ok(())
}

fn validate_commitment_shard_edge(
    root: &PersistentRadixSubtreeRoot,
) -> Result<(), PersistentRadixMapError> {
    if root.kind == PersistentRadixSubtreeKind::Leaf {
        return Ok(());
    }
    let actual = root.path.len() - 1;
    if actual > u16::MAX as usize {
        return Err(PersistentRadixMapError::ExtensionPathTooLong {
            actual,
            maximum: u16::MAX as usize,
        });
    }
    Ok(())
}

fn validate_descriptor(
    descriptor: &PersistentRadixShardDescriptor,
) -> Result<(), PersistentRadixMapError> {
    validate_shard_index(descriptor.index)?;
    match (&descriptor.root, descriptor.len) {
        (None, 0) => Ok(()),
        (Some(root), len) if len > 0 => validate_subtree_root(descriptor.index, root),
        _ => Err(PersistentRadixMapError::EmptyShardLength {
            index: descriptor.index,
            len: descriptor.len,
        }),
    }
}

fn validate_dirty_descriptors(
    descriptors: &[PersistentRadixShardDescriptor],
) -> Result<(), PersistentRadixMapError> {
    let mut seen = [false; PERSISTENT_RADIX_SHARD_COUNT];
    for descriptor in descriptors {
        validate_descriptor(descriptor)?;
        if std::mem::replace(&mut seen[descriptor.index], true) {
            return Err(PersistentRadixMapError::DuplicateShard {
                index: descriptor.index,
            });
        }
    }
    Ok(())
}

fn ordered_descriptor_parts(
    descriptors: Vec<PersistentRadixShardDescriptor>,
) -> Result<(Vec<Option<PersistentRadixSubtreeRoot>>, Vec<usize>), PersistentRadixMapError> {
    if descriptors.len() != PERSISTENT_RADIX_SHARD_COUNT {
        return Err(PersistentRadixMapError::SlotCount {
            actual: descriptors.len(),
            expected: PERSISTENT_RADIX_SHARD_COUNT,
        });
    }
    validate_dirty_descriptors(&descriptors)?;
    let mut roots = vec![None; PERSISTENT_RADIX_SHARD_COUNT];
    let mut lengths = vec![0; PERSISTENT_RADIX_SHARD_COUNT];
    for descriptor in descriptors {
        roots[descriptor.index] = descriptor.root;
        lengths[descriptor.index] = descriptor.len;
    }
    Ok((roots, lengths))
}

type OrderedShardParts<V> = (Vec<Option<NodeRef<V>>>, Vec<usize>);

fn ordered_shard_parts<V>(
    shards: Vec<PersistentRadixShard<V>>,
) -> Result<OrderedShardParts<V>, PersistentRadixMapError> {
    if shards.len() != PERSISTENT_RADIX_SHARD_COUNT {
        return Err(PersistentRadixMapError::SlotCount {
            actual: shards.len(),
            expected: PERSISTENT_RADIX_SHARD_COUNT,
        });
    }
    let mut children = empty_shard_nodes();
    let mut lengths = vec![0; PERSISTENT_RADIX_SHARD_COUNT];
    let mut seen = [false; PERSISTENT_RADIX_SHARD_COUNT];
    for shard in shards {
        validate_shard_index(shard.index)?;
        if std::mem::replace(&mut seen[shard.index], true) {
            return Err(PersistentRadixMapError::DuplicateShard { index: shard.index });
        }
        validate_shard_state(&shard)?;
        children[shard.index] = shard.child;
        lengths[shard.index] = shard.len;
    }
    Ok((children, lengths))
}

fn validate_shard_state<V>(shard: &PersistentRadixShard<V>) -> Result<(), PersistentRadixMapError> {
    match (&shard.child, shard.len) {
        (None, 0) => Ok(()),
        (Some(child), len) if len > 0 => {
            let actual = prefix_index(node_path(child), PERSISTENT_RADIX_SHARD_DEPTH)?;
            if actual != shard.index {
                return Err(PersistentRadixMapError::ShardKey {
                    actual,
                    expected: shard.index,
                });
            }
            validate_child_edge(&[], child)?;
            let actual_len = subtree_len(child);
            if actual_len != len {
                return Err(PersistentRadixMapError::ShardLength {
                    actual: actual_len,
                    expected: len,
                });
            }
            Ok(())
        }
        _ => Err(PersistentRadixMapError::EmptyShardLength {
            index: shard.index,
            len: shard.len,
        }),
    }
}

fn empty_shard_nodes<V>() -> Vec<Option<NodeRef<V>>> {
    (0..PERSISTENT_RADIX_SHARD_COUNT).map(|_| None).collect()
}

fn subtree_len<V>(node: &NodeRef<V>) -> usize {
    match &**node {
        Node::Leaf { .. } => 1,
        Node::Branch { children, .. } => children.iter().flatten().map(subtree_len).sum(),
    }
}

fn subtree_root<V>(node: &NodeRef<V>) -> PersistentRadixSubtreeRoot {
    let kind = match &**node {
        Node::Branch { .. } => PersistentRadixSubtreeKind::Branch,
        Node::Leaf { .. } => PersistentRadixSubtreeKind::Leaf,
    };
    PersistentRadixSubtreeRoot {
        kind,
        path: node_path(node).to_vec(),
        hash: node_hash(node),
    }
}

fn commitment_edge_hash(parent_path: &[u8], child: &PersistentRadixSubtreeRoot) -> [u8; 32] {
    if child.kind == PersistentRadixSubtreeKind::Leaf {
        return child.hash;
    }
    let segment = &child.path[parent_path.len() + 1..];
    if segment.is_empty() {
        child.hash
    } else {
        hash_extension16(segment, &child.hash).expect("internal radix commitment extension")
    }
}

fn commitment_kind_name(kind: &PersistentRadixSubtreeKind) -> &'static str {
    match kind {
        PersistentRadixSubtreeKind::Branch => "branch",
        PersistentRadixSubtreeKind::Leaf => "leaf",
    }
}

fn commitment_branch_record(
    path: Vec<u8>,
    children: &[Option<PersistentRadixSubtreeRoot>],
) -> PersistentNodeRecord<()> {
    PersistentNodeRecord::Branch {
        children: children
            .iter()
            .flatten()
            .map(|child| PersistentChildRecord {
                slot: child.path[path.len()],
                kind: commitment_kind_name(&child.kind),
                path: child.path.clone(),
                edge_hash: commitment_edge_hash(&path, child),
            })
            .collect(),
        path,
    }
}

fn is_top_branch(root: &PersistentRadixSubtreeRoot, depth: usize) -> bool {
    root.kind == PersistentRadixSubtreeKind::Branch && root.path.len() == depth
}

fn top_record_path(record: &PersistentNodeRecord<()>) -> &[u8] {
    match record {
        PersistentNodeRecord::Branch { path, .. } => path,
        PersistentNodeRecord::Leaf { .. } => unreachable!("top tree contains no values"),
    }
}

fn has_top_path(records: &[PersistentNodeRecord<()>], path: &[u8]) -> bool {
    records.iter().any(|record| top_record_path(record) == path)
}

fn has_equal_top_record(
    records: &[PersistentNodeRecord<()>],
    expected: &PersistentNodeRecord<()>,
) -> bool {
    records.iter().any(|record| record == expected)
}

fn make_commitment_branch(
    path: Vec<u8>,
    children: &[PersistentRadixSubtreeRoot],
) -> PersistentRadixSubtreeRoot {
    let child_hashes = children
        .iter()
        .map(|child| {
            let slot = child.path[path.len()];
            (slot, commitment_edge_hash(&path, child))
        })
        .collect::<Vec<_>>();
    PersistentRadixSubtreeRoot {
        kind: PersistentRadixSubtreeKind::Branch,
        path,
        hash: hash_branch16(&child_hashes).expect("internal radix commitment branch"),
    }
}

fn compressed_commitment_parent(
    path: Vec<u8>,
    mut children: Vec<PersistentRadixSubtreeRoot>,
) -> Option<PersistentRadixSubtreeRoot> {
    match children.len() {
        0 => None,
        1 => children.pop(),
        _ => Some(make_commitment_branch(path, &children)),
    }
}

fn build_second_parent(
    index: usize,
    shards: &[Option<PersistentRadixSubtreeRoot>],
) -> Option<PersistentRadixSubtreeRoot> {
    let children = shards[index * 16..(index + 1) * 16]
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    compressed_commitment_parent(vec![(index / 16) as u8, (index % 16) as u8], children)
}

fn build_second_level(
    shards: &[Option<PersistentRadixSubtreeRoot>],
) -> Vec<Option<PersistentRadixSubtreeRoot>> {
    (0..256)
        .map(|index| build_second_parent(index, shards))
        .collect()
}

fn build_first_parent(
    index: usize,
    second_level: &[Option<PersistentRadixSubtreeRoot>],
) -> Option<PersistentRadixSubtreeRoot> {
    let children = second_level[index * 16..(index + 1) * 16]
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    compressed_commitment_parent(vec![index as u8], children)
}

fn build_first_level(
    second_level: &[Option<PersistentRadixSubtreeRoot>],
) -> [Option<PersistentRadixSubtreeRoot>; 16] {
    std::array::from_fn(|index| build_first_parent(index, second_level))
}

fn top_root_hash(children: &[Option<PersistentRadixSubtreeRoot>; 16]) -> [u8; 32] {
    let children = children.iter().flatten().cloned().collect::<Vec<_>>();
    if children.is_empty() {
        EMPTY_RADIX_ROOT
    } else {
        make_commitment_branch(Vec::new(), &children).hash
    }
}

fn build_node_root<V>(
    shards: &[Option<NodeRef<V>>],
) -> Result<Option<NodeRef<V>>, PersistentRadixMapError> {
    let second_level = (0..256)
        .map(|index| {
            let children = shards[index * 16..(index + 1) * 16]
                .iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>();
            compressed_parent(vec![(index / 16) as u8, (index % 16) as u8], children)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let root_children = (0..16)
        .map(|index| {
            let children = second_level[index * 16..(index + 1) * 16]
                .iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>();
            compressed_parent(vec![index as u8], children)
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if root_children.is_empty() {
        Ok(None)
    } else {
        Ok(Some(make_branch(Vec::new(), &root_children)?))
    }
}

fn prefix_index(path: &[u8], depth: usize) -> Result<usize, PersistentRadixMapError> {
    if path.len() < depth {
        return Err(PersistentRadixMapError::KeyDepth {
            actual: path.len(),
            required: depth,
        });
    }
    Ok(path[..depth]
        .iter()
        .fold(0_usize, |index, nibble| index * 16 + usize::from(*nibble)))
}

fn collect_prefix_subtrees<V>(
    node: &NodeRef<V>,
    depth: usize,
    slots: &mut [Option<NodeRef<V>>],
) -> Result<(), PersistentRadixMapError> {
    let path = node_path(node);
    if path.len() >= depth {
        let index = prefix_index(path, depth)?;
        if slots[index].replace(Arc::clone(node)).is_some() {
            return Err(PersistentRadixMapError::KeyPrefixCollision);
        }
        return Ok(());
    }
    let Node::Branch { children, .. } = &**node else {
        return Err(PersistentRadixMapError::KeyDepth {
            actual: path.len(),
            required: depth,
        });
    };
    for child in children.iter().flatten() {
        collect_prefix_subtrees(child, depth, slots)?;
    }
    Ok(())
}

fn compressed_parent<V>(
    path: Vec<u8>,
    mut children: Vec<NodeRef<V>>,
) -> Result<Option<NodeRef<V>>, PersistentRadixMapError> {
    Ok(match children.len() {
        0 => None,
        1 => children.pop(),
        _ => Some(make_branch(path, &children)?),
    })
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
