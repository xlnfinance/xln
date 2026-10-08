//! Authenticated finalized-J observation for the native Runtime.
//!
//! Ethereum reconstructs the complete ordered receipt set and verifies the
//! EIP-2718 receipt trie root. Committed native TRON policy instead binds the
//! SolidityNode head and cross-checks complete receipts against `eth_getLogs`.
//! Both fence the exact block range before and after the read, and only then turn
//! the full canonical contract-event catalog into typed Entity ingress. The
//! caller commits the returned cursor in the same Runtime WAL frame as the
//! generated ingress.

mod abi;
mod calldata;
mod http;
mod observation;
mod receipt;
mod token_registry;
mod tron;
mod types;
#[path = "read/wallet_snapshot.rs"]
mod wallet_snapshot;
mod watcher;
pub use wallet_snapshot::{WalletSnapshotError, read_wallet_snapshot};

pub use http::HttpJsonRpc;
pub use observation::{
    ObserveJRange, decode_observe_j_range, encode_observe_j_range, observation_from_poll,
};
pub(crate) use token_registry::{hydrate_live_catalogs, read_erc20_token_registry};
pub use types::{
    FinalizedJHeader, FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc,
    WatchedExternalWallet, WatchedHashLadder,
};
pub use watcher::poll_finalized_j_events;
pub(crate) use watcher::{capture_startup_target, read_initial_watcher_anchor};
pub use xln_rscore_entity_kernel::{FinalizedJEventBatch, JClaimIngress, JReserveUpdate};

#[cfg(test)]
mod tests;
