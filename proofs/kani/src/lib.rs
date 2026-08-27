//! Standalone Kani verification crate for proofs C5 (delta math mirror) and
//! C6 (bounded radix universe). See `proofs/readme.md` and `report.md`.
//!
//! Kani cannot execute the production BigInt/String/BTreeMap/Arc stack in
//! full generality, so:
//! - C5 verifies a bounded i128/u128 mirror whose logical ranges are the
//!   production ranges scaled by 1/16 (256→16 bit fields, 128→8 bit payments).
//!   Equivalence between the mirror and a width-parameterized BigInt
//!   transcription of `rscore/crates/engine/src/state/delta.rs` is established
//!   by an ordinary randomized test (`tests/equivalence.rs`), including a
//!   cross-check of the transcription against the real engine crate at the
//!   production width 256/128.
//! - C6 verifies the REAL radix implementation: the rscore source files are
//!   included by #[path] (byte-identical, hashes in report.md) and compiled
//!   here with `sha2` WITHOUT the `asm` feature, which the Kani toolchain
//!   cannot link. Hash behavior of the pure-Rust sha2 backend is identical.

// The rscore sources are pinned to an immutable committed SHA by
// pin-rscore.sh (see pinned-rscore/ and pinned-hashes.txt). #[path] resolves
// relative to src/. The persistent_node/persistent_records shims mirror the
// upstream module wiring after the protocol crate moved those files into
// persistent/ while keeping their crate paths stable.
#[path = "../pinned-rscore/rscore/crates/protocol/src/radix.rs"]
pub mod radix;
#[path = "../pinned-rscore/rscore/crates/protocol/src/persistent.rs"]
pub mod persistent;
#[path = "../pinned-rscore/rscore/crates/protocol/src/persistent/node.rs"]
mod persistent_node;
#[path = "../pinned-rscore/rscore/crates/protocol/src/persistent/records.rs"]
mod persistent_records;

pub use radix::{EMPTY_RADIX_ROOT, hash_branch16, hash_extension16, hash_leaf};

pub mod delta_mirror;
pub mod radix_universe;

#[cfg(kani)]
pub mod delta_proofs;

#[cfg(kani)]
pub mod radix_proofs;

#[cfg(test)]
pub mod radix_concrete;
