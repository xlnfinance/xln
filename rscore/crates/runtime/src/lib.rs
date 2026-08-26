#![forbid(unsafe_code)]

//! Canonical sovereign Runtime state and WAL commitments.
//!
//! This crate deliberately starts at the durable consensus boundary. A Rust
//! Runtime frame is valid only when its storage commitments reproduce the
//! canonical TypeScript bytes; fixture-specific root hooks are not accepted.

mod commitment;
mod recording;
mod tagged_json;

pub use commitment::{
    RuntimeCommitmentError, RuntimeComponentDigest, RuntimePostStateCommitment,
    StorageReplicaMetaEntry, compute_runtime_component_digest, compute_storage_post_state_hash,
    compute_storage_replica_meta_digest, encode_storage_payload,
};
pub use recording::{
    RecordingPostStateCheck, RuntimeRecordingError, verify_recording_post_state_hashes,
};
pub use tagged_json::{TaggedJsonError, canonical_value_from_tagged_json};
