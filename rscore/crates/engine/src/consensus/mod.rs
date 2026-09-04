//! Account consensus: the frame a proposer builds and its peer verifies.
//!
//! Mirrors `core/account/consensus` — same directory names, same file names,
//! so a reviewer can read the two implementations side by side.

pub(crate) mod context;
pub(crate) mod frame;
pub(crate) mod incoming;
pub(crate) mod proposal;
pub(crate) mod rebalance;
pub(crate) mod replica;
pub(crate) mod signing;
