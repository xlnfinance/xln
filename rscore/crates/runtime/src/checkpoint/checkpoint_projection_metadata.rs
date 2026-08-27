//! Parsed canonical Entity storage manifest retained by the live Runtime.
//!
//! This is bounded projection metadata, not a second state copy. Canonical
//! values remain in the one path-keyed LevelDB graph; only their authenticated
//! descriptors are retained so cadence projection can replace E+A-owned rows
//! without guessing carried values from irreversible section digests.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntityFieldProjectionDescriptor {
    pub(crate) tag: u8,
    pub(crate) value_hash: [u8; 32],
    pub(crate) byte_length: usize,
    pub(crate) chunk_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntityTreeProjectionDescriptor {
    pub(crate) namespace: String,
    pub(crate) namespace_tag: u8,
    pub(crate) root: [u8; 32],
    pub(crate) leaf_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntityCheckpointProjectionMetadata {
    entity_id: [u8; 32],
    fields: BTreeMap<u8, EntityFieldProjectionDescriptor>,
    trees: BTreeMap<u8, EntityTreeProjectionDescriptor>,
}

impl EntityCheckpointProjectionMetadata {
    pub(crate) fn new(
        entity_id: [u8; 32],
        fields: Vec<EntityFieldProjectionDescriptor>,
        trees: Vec<EntityTreeProjectionDescriptor>,
    ) -> Self {
        Self {
            entity_id,
            fields: fields.into_iter().map(|row| (row.tag, row)).collect(),
            trees: trees
                .into_iter()
                .map(|row| (row.namespace_tag, row))
                .collect(),
        }
    }

    pub(crate) fn entity_id(&self) -> &[u8; 32] {
        &self.entity_id
    }

    pub(crate) fn fields(&self) -> &BTreeMap<u8, EntityFieldProjectionDescriptor> {
        &self.fields
    }

    pub(crate) fn trees(&self) -> &BTreeMap<u8, EntityTreeProjectionDescriptor> {
        &self.trees
    }
}
