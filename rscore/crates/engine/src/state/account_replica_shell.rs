//! The replica shell around the financial state: mempool, frame bindings,
//! hankos, acks — everything the Entity commits in its account leaf but no
//! account transaction touches.
//!
//! Parity target: `projectAccountConsensusState` +
//! `computeEntityAccountLeafDigest` in `core/entity/consensus/state-root.ts`.
//! The engine derives the two roots it owns (the account state root and the
//! mempool root) and commits the rest of the projection as the authority
//! handed it over, so its account tree leaf is the very digest the Entity
//! machine puts in its accounts map.

use sha2::{Digest, Sha256};
use xln_rscore_protocol::{
    CanonicalValue, ValueEncodingError, compute_flat_integrity_root, encode_account_state_value,
};

const ENTITY_ACCOUNT_LEAF_DOMAIN: &[u8] = b"xln.entity.account-leaf.v3";
const MEMPOOL_NAMESPACE: &str = "entity.account-mempool";
/// Empty mempool commits the zero root, not the root of an empty list.
const EMPTY_ROOT: [u8; 32] = [0; 32];

/// Field names the engine derives itself. The authority must not send them:
/// carrying a derived value would make the comparison agree by construction.
const DERIVED_FIELDS: [&str; 2] = ["accountStateRoot", "mempoolRoot"];

/// Every field the Entity's account leaf may contain.
///
/// Parity target: `ENTITY_ACCOUNT_LEAF_FIELDS`
/// (core/entity/consensus/state-root.ts) — the committed replica fields that
/// are not carried as bodies, plus the derived ones. It is an allowlist on
/// both sides for the same reason: a field nobody classified would otherwise
/// drop silently out of the commitment, and two replicas that differ only in
/// that field would hash identically.
const ENTITY_ACCOUNT_LEAF_FIELDS: [&str; 30] = [
    "status",
    "publicPinned",
    "currentHeight",
    "rollbackCount",
    "lastRollbackFrameHash",
    "proofHeader",
    "boardHankoRefreshMigration",
    "counterpartyBoardHankoRefresh",
    "counterpartyFrameHanko",
    "counterpartyDisputeProofHanko",
    "counterpartySettlementHanko",
    "currentDisputeProofNonce",
    "currentDisputeProofProposerIsLeft",
    "currentDisputeProofBodyHash",
    "currentDisputeHash",
    "counterpartyDisputeProofNonce",
    "counterpartyDisputeProofProposerIsLeft",
    "counterpartyDisputeProofBodyHash",
    "counterpartyDisputeHash",
    "disputePrepare",
    "activeDispute",
    "accountStateRoot",
    "mempoolRoot",
    "currentFrameHash",
    "pendingFrameHash",
    "counterpartySettlementHankos",
    "pendingWithdrawals",
    "shadow",
    "pendingAccountInput",
    "lastOutboundFrameAck",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountEnvelope {
    /// The Entity's account-leaf projection minus the derived fields.
    fields: Vec<(String, CanonicalValue)>,
    /// Canonical frame-hash form of each queued account tx, in mempool order.
    mempool: Vec<CanonicalValue>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EnvelopeError {
    #[error("ENTITY_ACCOUNT_LEAF_FIELD_DERIVED:{0}")]
    DerivedField(String),
    #[error("ENTITY_ACCOUNT_LEAF_FIELD_UNCLASSIFIED:{0}")]
    UnclassifiedField(String),
    #[error(transparent)]
    Encoding(#[from] ValueEncodingError),
}

fn hex_32(bytes: &[u8; 32]) -> String {
    crate::state::identity::render_hex(bytes)
}

impl AccountEnvelope {
    pub fn new(
        fields: Vec<(String, CanonicalValue)>,
        mempool: Vec<CanonicalValue>,
    ) -> Result<Self, EnvelopeError> {
        for (name, _) in &fields {
            if DERIVED_FIELDS.contains(&name.as_str()) {
                return Err(EnvelopeError::DerivedField(name.clone()));
            }
            if !ENTITY_ACCOUNT_LEAF_FIELDS.contains(&name.as_str()) {
                return Err(EnvelopeError::UnclassifiedField(name.clone()));
            }
        }
        Ok(Self { fields, mempool })
    }

    /// The carried projection fields, so a caller that owns part of the
    /// projection can replace exactly those.
    /// Drop one carried field. Used when the engine takes ownership of a
    /// field it used to carry — a certificate over a proof that no longer
    /// stands, for instance.
    pub fn forget_field(&mut self, name: &str) {
        self.fields.retain(|(field, _)| field != name);
    }

    /// Whether the shell still carries a field the engine does not own.
    pub fn has_field(&self, name: &str) -> bool {
        self.fields.iter().any(|(field, _)| field == name)
    }

    pub fn fields(&self) -> &[(String, CanonicalValue)] {
        &self.fields
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.mempool.is_empty()
    }

    pub fn mempool_len(&self) -> usize {
        self.mempool.len()
    }

    /// Flat integrity root over the queued txs, keyed by their index — the
    /// same shape `mempoolRoot` builds on the TypeScript side.
    pub fn mempool_root(&self) -> Result<[u8; 32], EnvelopeError> {
        if self.mempool.is_empty() {
            return Ok(EMPTY_ROOT);
        }
        let entries: Vec<(String, CanonicalValue)> = self
            .mempool
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect();
        Ok(compute_flat_integrity_root(MEMPOOL_NAMESPACE, &entries)?)
    }

    /// The Entity's account leaf: one encode of the sorted projection, one
    /// hash. `account_state_root` is the engine's own financial root.
    pub fn entity_account_leaf(
        &self,
        account_state_root: &[u8; 32],
    ) -> Result<[u8; 32], EnvelopeError> {
        let mempool_root = self.mempool_root()?;
        let mut entries = Vec::with_capacity(self.fields.len() + 2);
        entries.extend(self.fields.iter().cloned());
        entries.push((
            "accountStateRoot".into(),
            CanonicalValue::String(hex_32(account_state_root)),
        ));
        entries.push((
            "mempoolRoot".into(),
            CanonicalValue::String(hex_32(&mempool_root)),
        ));
        // encode_account_state_value sorts object keys itself (UTF-16 order),
        // exactly as the TypeScript projection does before hashing.
        let encoded = encode_account_state_value(&CanonicalValue::Object(entries))?;
        let mut digest = Sha256::new();
        digest.update(ENTITY_ACCOUNT_LEAF_DOMAIN);
        digest.update(&encoded);
        Ok(digest.finalize().into())
    }
}
