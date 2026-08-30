use serde_json::Value;
use thiserror::Error;

use crate::RuntimeComponentDigest;

use super::super::RuntimeFrameCommit;

pub type Digest = [u8; 32];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFrameEntityHash {
    pub entity_id: String,
    pub hash: Digest,
    pub cell_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalStateCommitment {
    pub state_hash: Digest,
    pub entity_hashes: Vec<RuntimeFrameEntityHash>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeMachineGraphRoot {
    pub root_hash: Digest,
    pub leaf_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAuthorityCheckpointRef {
    pub owner_entity_id: Digest,
    pub protocol_fingerprint: Digest,
    pub base_revision: String,
    pub revision: String,
    pub accounts_root: Digest,
    pub signer_digest: Digest,
    pub account_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TouchedAccount {
    pub entity_id: String,
    pub counterparty_id: String,
}

/// Every value needed to create the canonical TS RuntimeFrame. No digest or
/// count derived from the outbox is accepted from a caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalRuntimeFrameDraft {
    pub height: u64,
    pub timestamp: u64,
    pub prev_frame_hash: Digest,
    pub replica_meta_digest: Digest,
    pub runtime_component_digests: Vec<RuntimeComponentDigest>,
    pub materialized_state: bool,
    pub canonical_state: Option<CanonicalStateCommitment>,
    pub runtime_input: Value,
    pub runtime_machine_root: Option<RuntimeMachineGraphRoot>,
    pub account_authority_checkpoints: Vec<AccountAuthorityCheckpointRef>,
    pub touched_entities: Vec<String>,
    pub touched_accounts: Vec<TouchedAccount>,
    pub touched_book_entities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedRuntimeFrame {
    pub(crate) frame_hash: Digest,
    pub(crate) post_state_hash: Digest,
    pub(crate) output_digest: Digest,
    pub(crate) validated: ValidatedRuntimeFrame,
    pub(crate) commit: RuntimeFrameCommit,
    /// Transient values that produced `commit.outputs`. They cross the fsync
    /// boundary only in RAM so immediate publication does not decode the WAL
    /// bytes it just encoded. They are never persisted or reconstructed.
    pub(crate) resident_output_values: Option<Vec<Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedRuntimeFrame {
    pub height: u64,
    pub timestamp: u64,
    pub prev_frame_hash: Digest,
    pub frame_hash: Digest,
    pub materialized_state: bool,
    pub output_count: usize,
    pub output_digest: Digest,
    pub canonical_state_hash: Option<Digest>,
    pub runtime_machine_root: Option<RuntimeMachineGraphRoot>,
}

#[derive(Debug, Error)]
pub enum RuntimeFrameCodecError {
    #[error("RRS_RUNTIME_FRAME_NUMBER_UNSAFE:{field}:{value}")]
    UnsafeNumber { field: &'static str, value: u64 },
    #[error("RRS_RUNTIME_FRAME_INPUT_NOT_OBJECT:{0}")]
    RuntimeInputObject(&'static str),
    #[error("RRS_RUNTIME_FRAME_MATERIALIZED_ROOTS_REQUIRED")]
    MaterializedRootsRequired,
    #[error("RRS_RUNTIME_FRAME_MACHINE_ROOT_REQUIRED")]
    MachineRootRequired,
    #[error("RRS_RUNTIME_FRAME_CHECKPOINT_OWNER_ORDER")]
    CheckpointOwnerOrder,
    #[error("RRS_RUNTIME_FRAME_CHECKPOINT_REVISION:{0}")]
    CheckpointRevision(String),
    #[error("RRS_RUNTIME_FRAME_CHECKPOINT_ACCOUNT_COUNT:{0}")]
    CheckpointAccountCount(u64),
    #[error("RRS_RUNTIME_FRAME_ENTITY_HASH_ORDER")]
    EntityHashOrder,
    #[error("RRS_RUNTIME_FRAME_DUPLICATE_CONTEXT:{0}")]
    DuplicateContext(String),
    #[error("RRS_RUNTIME_FRAME_FIELD:{0}")]
    Field(&'static str),
    #[error("RRS_RUNTIME_FRAME_FIELDS")]
    Fields,
    #[error("RRS_RUNTIME_FRAME_HASH")]
    FrameHash,
    #[error(
        "RRS_RUNTIME_FRAME_BYTES_NOT_CANONICAL:offset={offset}:stored={stored}:canonical={canonical}:storedLen={stored_len}:canonicalLen={canonical_len}:storedWindow={stored_window}:canonicalWindow={canonical_window}"
    )]
    NonCanonicalBytes {
        offset: usize,
        stored: String,
        canonical: String,
        stored_len: usize,
        canonical_len: usize,
        stored_window: String,
        canonical_window: String,
    },
    #[error("RRS_RUNTIME_FRAME_ENCODING:{0}")]
    Encoding(String),
    #[error(transparent)]
    Commitment(#[from] crate::RuntimeCommitmentError),
    #[error(transparent)]
    MessagePack(#[from] crate::StorageMessagePackError),
}
