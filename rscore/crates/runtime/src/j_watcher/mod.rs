//! Authenticated finalized-J observation for the native Runtime.
//!
//! This boundary deliberately does not trust `eth_getLogs`.  It reconstructs
//! the complete ordered receipt set, verifies the EIP-2718 receipt trie root,
//! fences the exact block range before and after the read, and only then turns
//! `AccountSettled` logs into typed Account claims.  The caller commits the
//! returned cursor in the same Runtime WAL frame as the generated ingress.

mod abi;
mod http;
mod receipt;
mod types;
mod watcher;

pub use http::HttpJsonRpc;
pub use types::{FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc};
pub use watcher::poll_finalized_j_events;
pub use xln_rscore_entity_kernel::{FinalizedJEventBatch, JClaimIngress, JReserveUpdate};

#[cfg(test)]
mod tests;
