//! Native Runtime durability and recovery.

pub mod native;

/// Current disposable-testnet database format, shared by HEAD and Entity manifests.
pub(crate) const STORAGE_SCHEMA_VERSION: u64 = 6;
