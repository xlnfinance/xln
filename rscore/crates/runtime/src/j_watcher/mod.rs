//! Authenticated finalized-J observation for the native Runtime.
//!
//! This boundary deliberately does not trust `eth_getLogs`.  It reconstructs
//! the complete ordered receipt set, verifies the EIP-2718 receipt trie root,
//! fences the exact block range before and after the read, and only then turns
//! the full canonical contract-event catalog into typed Entity ingress. The
//! caller commits the returned cursor in the same Runtime WAL frame as the
//! generated ingress.

mod abi;
mod calldata;
mod http;
mod observation;
mod receipt;
mod types;
mod watcher;

pub use http::HttpJsonRpc;
pub use observation::{
    ObserveJRange, decode_observe_j_range, encode_observe_j_range, observation_from_poll,
};
pub use types::{
    FinalizedJHeader, FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc,
    WatchedExternalWallet, WatchedHashLadder,
};
pub use watcher::poll_finalized_j_events;
pub use xln_rscore_entity_kernel::{FinalizedJEventBatch, JClaimIngress, JReserveUpdate};

#[cfg(test)]
mod tests;
