#![forbid(unsafe_code)]

//! Byte-exact protocol primitives shared by the Rust Account engine.

mod consensus_msgpack;
mod flat;
mod persistent;
#[path = "persistent/node.rs"]
mod persistent_node;
#[path = "persistent/records.rs"]
mod persistent_records;
mod radix;
mod rlp;
mod tokens;
mod value;
pub use tokens::{
    CREDIT_REQUEST_CAP_USD, DEFAULT_REBALANCE_POLICY_USD, REBALANCE_BASE_FEE_USD_MICROS,
    USD_MICROS_PER_DOLLAR, UsdAmountError, canonical_reference_mid_price_ticks,
    canonical_token_decimals, canonical_token_metadata, canonical_token_usd_micros,
    rebalance_base_fee, usd_micros_to_token_amount, whole_usd_to_token_amount,
};

#[cfg(test)]
#[path = "persistent/tests.rs"]
mod persistent_tests;

pub use consensus_msgpack::{ConsensusMessagePackError, encode_canonical_consensus_bytes};
pub use flat::compute_flat_integrity_root;
pub use persistent::{
    PERSISTENT_RADIX_SHARD_COUNT, PERSISTENT_RADIX_SHARD_DEPTH, PersistentChildRecord,
    PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef, PersistentRadixBatchError,
    PersistentRadixMap, PersistentRadixMapError, PersistentRadixMutation,
    PersistentRadixOverlayWork, PersistentRadixShard, PersistentRadixShardCoordinator,
    PersistentRadixShardDescriptor, PersistentRadixShardOverlay, PersistentRadixSubtreeKind,
    PersistentRadixSubtreeRoot, SlotOutcome, SlotWork,
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
