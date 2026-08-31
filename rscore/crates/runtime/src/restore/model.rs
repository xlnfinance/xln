//! Typed inputs and observable commitments for exact Runtime restoration.

/// Every digest is stored as its raw 32-byte value. The digest's algorithm is
/// fixed by the owning protocol domain; restore must compare bytes and must not
/// reinterpret one domain as another.
pub type RestoreDigest = [u8; 32];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableRuntimeIdentity {
    pub runtime_id: String,
    pub owner_entity_id: RestoreDigest,
    pub signer_id: String,
    pub protocol_fingerprint: RestoreDigest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreCommitments {
    /// Root of the path-keyed physical Runtime checkpoint graph.
    pub runtime_machine_root: Option<RestoreDigest>,
    /// Independent canonical hash over the full Runtime replica.
    pub canonical_state_hash: Option<RestoreDigest>,
    pub post_state_hash: Option<RestoreDigest>,
    pub entity_state_root: Option<RestoreDigest>,
    pub accounts_root: Option<RestoreDigest>,
    pub paybook_root: Option<RestoreDigest>,
    pub orderbook_root: Option<RestoreDigest>,
    pub output_count: Option<u64>,
    pub outputs_digest: Option<RestoreDigest>,
    pub event_count: Option<u64>,
    pub events_digest: Option<RestoreDigest>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreBoundary {
    RuntimeMachineRoot,
    CanonicalStateHash,
    PostStateHash,
    EntityStateRoot,
    AccountsRoot,
    PaybookRoot,
    OrderbookRoot,
    OutputCount,
    OutputsDigest,
    EventCount,
    EventsDigest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreHead {
    pub height: u64,
    pub timestamp: u64,
    pub commitments: RestoreCommitments,
}

#[derive(Clone, Debug)]
pub struct ExactRuntimeCheckpoint<P> {
    pub height: u64,
    pub timestamp: u64,
    pub account_count: usize,
    /// Required for an empty Account forest. A non-empty legacy checkpoint may
    /// recover the signer from its authenticated Account rows, but guessing an
    /// empty forest's signer would create authority after a crash.
    pub identity: Option<DurableRuntimeIdentity>,
    pub expected: RestoreCommitments,
    pub payload: P,
}

#[derive(Clone, Debug)]
pub struct ExactRuntimeWalFrame<I> {
    pub height: u64,
    pub timestamp: u64,
    pub input: I,
    pub expected: RestoreCommitments,
}
