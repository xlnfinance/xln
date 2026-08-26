#![forbid(unsafe_code)]

//! Byte-exact protocol primitives shared by the Rust Account engine.

mod consensus_msgpack;
mod flat;
mod persistent;
mod persistent_node;
mod persistent_records;
mod radix;
mod rlp;
mod value;

#[cfg(test)]
mod persistent_tests;

pub use consensus_msgpack::{ConsensusMessagePackError, encode_canonical_consensus_bytes};
pub use flat::compute_flat_integrity_root;
pub use persistent::{
    PERSISTENT_RADIX_SHARD_COUNT, PERSISTENT_RADIX_SHARD_DEPTH, PersistentChildRecord,
    PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef, PersistentRadixMap,
    PersistentRadixMapError, PersistentRadixOverlayWork, PersistentRadixShard,
    PersistentRadixShardCoordinator, PersistentRadixShardDescriptor, PersistentRadixShardOverlay,
    PersistentRadixSubtreeKind, PersistentRadixSubtreeRoot, SlotOutcome, SlotWork,
};
pub use radix::{
    EMPTY_RADIX_ROOT, RadixLeaf, RadixMerkleError, RadixMerkleResult, build_radix16_merkle,
    encode_raw_text_key, hash_branch16, hash_extension16, hash_leaf, pack_path16,
};
pub use rlp::RlpWriter;
pub use value::{
    CanonicalNumber, CanonicalNumberError, CanonicalValue, JS_MAX_SAFE_INTEGER, ValueEncodingError,
    encode_account_state_value, write_account_state_value,
};
