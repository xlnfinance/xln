//! Byte-exact protocol primitives shared by the Rust Account engine.

mod flat;
mod persistent;
mod persistent_node;
mod persistent_records;
mod radix;
mod rlp;
mod value;

#[cfg(test)]
mod persistent_tests;

pub use flat::compute_flat_integrity_root;
pub use persistent::{
    PersistentChildRecord, PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef,
    PersistentRadixMap, PersistentRadixMapError,
};
pub use radix::{
    EMPTY_RADIX_ROOT, RadixLeaf, RadixMerkleError, RadixMerkleResult, build_radix16_merkle,
    encode_raw_text_key, hash_branch16, hash_extension16, hash_leaf, pack_path16,
};
pub use rlp::RlpWriter;
pub use value::{
    CanonicalValue, ValueEncodingError, encode_account_state_value, write_account_state_value,
};
