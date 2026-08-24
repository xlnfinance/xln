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
        }
        Ok(Self { fields, mempool })
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
