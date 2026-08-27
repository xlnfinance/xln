//! Parsed canonical Entity storage manifest retained by the live Runtime.
//!
//! This is bounded projection metadata, not a second state copy. Canonical
//! values remain in the one path-keyed LevelDB graph; only their authenticated
//! descriptors are retained so cadence projection can replace E+A-owned rows
//! without guessing carried values from irreversible section digests.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityFieldProjectionDescriptor {
    pub tag: u8,
    pub value_hash: [u8; 32],
    pub byte_length: usize,
    pub chunk_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityTreeProjectionDescriptor {
    pub namespace: String,
    pub namespace_tag: u8,
    pub root: [u8; 32],
    pub leaf_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityCheckpointProjectionMetadata {
    entity_id: [u8; 32],
    account_owner: Option<[u8; 32]>,
    protocol_fingerprint: Option<[u8; 32]>,
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
            account_owner: None,
            protocol_fingerprint: None,
            fields: fields.into_iter().map(|row| (row.tag, row)).collect(),
            trees: trees
                .into_iter()
                .map(|row| (row.namespace_tag, row))
                .collect(),
        }
    }

    pub fn entity_id(&self) -> &[u8; 32] {
        &self.entity_id
    }

    pub(crate) fn bind_account_authority(
        &mut self,
        owner: [u8; 32],
        protocol_fingerprint: [u8; 32],
    ) -> bool {
        if owner != self.entity_id {
            return false;
        }
        self.account_owner = Some(owner);
        self.protocol_fingerprint = Some(protocol_fingerprint);
        true
    }

    pub fn account_authority(&self) -> Option<([u8; 32], [u8; 32])> {
        Some((self.account_owner?, self.protocol_fingerprint?))
    }

    pub fn fields(&self) -> &BTreeMap<u8, EntityFieldProjectionDescriptor> {
        &self.fields
    }

    pub fn trees(&self) -> &BTreeMap<u8, EntityTreeProjectionDescriptor> {
        &self.trees
    }
}
