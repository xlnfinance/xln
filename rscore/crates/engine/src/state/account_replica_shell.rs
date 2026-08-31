//! The replica shell around the financial state. It retains the live/recovery
//! material an Account needs, but the Entity leaf commits only the classified
//! durable fields below.
//!
//! Parity target: `projectAccountConsensusState` +
//! `computeEntityAccountLeafDigest` in `core/entity/consensus/state-root.ts`.
//! The engine derives the bilateral account-state root. Mempool, proposal,
//! ACK and rollback coordination remain in the replica/checkpoint envelope;
//! committing them here would make one agreed Account state acquire different
//! parent roots solely because its two participants are at different delivery
//! phases.

use sha2::{Digest, Sha256};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, ValueEncodingError,
    encode_account_state_value,
};

const ENTITY_ACCOUNT_LEAF_DOMAIN: &[u8] = b"xln.entity.account-leaf.v3";
/// Field names the engine derives itself. The authority must not send them:
/// carrying a derived value would make the comparison agree by construction.
const DERIVED_FIELDS: [&str; 1] = ["accountStateRoot"];

/// Every field the Entity's account leaf may contain.
///
/// Parity target: `ENTITY_ACCOUNT_LEAF_FIELDS`
/// (core/entity/consensus/state-root.ts) — the committed replica fields that
/// are not carried as bodies, plus the derived ones. It is an allowlist on
/// both sides for the same reason: a field nobody classified would otherwise
/// drop silently out of the commitment, and two replicas that differ only in
/// that field would hash identically.
const ENTITY_ACCOUNT_LEAF_FIELDS: [&str; 24] = [
    "status",
    "publicPinned",
    "currentHeight",
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
    "currentFrameHash",
    "counterpartySettlementHankos",
    "pendingWithdrawals",
    "shadow",
];

/// The checkpoint envelope additionally carries local coordination needed to
/// resume delivery after a crash. These fields are valid durable payload, but
/// `entity_account_leaf` deliberately filters them out of the parent root.
const ACCOUNT_ENVELOPE_FIELDS: [&str; 28] = [
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
    "currentFrameHash",
    "pendingFrameHash",
    "counterpartySettlementHankos",
    "pendingWithdrawals",
    "shadow",
    "pendingAccountInput",
    "lastOutboundAckFrame",
];

#[derive(Clone)]
pub struct AccountEnvelope {
    /// The Entity's account-leaf projection minus the derived fields.
    fields: Vec<(String, CanonicalValue)>,
    /// Canonical frame-hash form of each queued account tx, in mempool order.
    mempool: Vec<CanonicalValue>,
    /// Value-bearing body behind `shadow.rebalance.policyRoot`. The Entity
    /// account leaf commits only the root, but live execution and restart need
    /// the exact rows; keeping only the digest made setRebalancePolicy and
    /// quote admission impossible after native restore.
    rebalance_shadow_policy: PersistentRadixMap<CanonicalValue>,
    /// AccountReplica-owned rebalance submission markers.  The Entity leaf
    /// carries only this tree's root, while the one native body travels in the
    /// live seed/checkpoint envelope so J finality can delete one token path.
    rebalance_shadow_submitted: PersistentRadixMap<u64>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EnvelopeError {
    #[error("ENTITY_ACCOUNT_LEAF_FIELD_DERIVED:{0}")]
    DerivedField(String),
    #[error("ENTITY_ACCOUNT_LEAF_FIELD_UNCLASSIFIED:{0}")]
    UnclassifiedField(String),
    #[error(transparent)]
    Encoding(#[from] ValueEncodingError),
    #[error("REBALANCE_SHADOW_SUBMITTED_ROOT_INVALID")]
    RebalanceShadowSubmittedRootInvalid,
    #[error("REBALANCE_SHADOW_SUBMITTED_ROOT_MISMATCH")]
    RebalanceShadowSubmittedRootMismatch,
    #[error("REBALANCE_SHADOW_SUBMITTED_DUPLICATE:{0}")]
    RebalanceShadowSubmittedDuplicate(u32),
    #[error("REBALANCE_SHADOW_SUBMITTED_MAP:{0}")]
    RebalanceShadowSubmittedMap(String),
    #[error("REBALANCE_SHADOW_POLICY_ROOT_INVALID")]
    RebalanceShadowPolicyRootInvalid,
    #[error("REBALANCE_SHADOW_POLICY_ROOT_MISMATCH")]
    RebalanceShadowPolicyRootMismatch,
    #[error("REBALANCE_SHADOW_POLICY_DUPLICATE:{0}")]
    RebalanceShadowPolicyDuplicate(u32),
    #[error("REBALANCE_SHADOW_POLICY_MAP:{0}")]
    RebalanceShadowPolicyMap(String),
}

fn hex_32(bytes: &[u8; 32]) -> String {
    crate::state::identity::render_hex(bytes)
}

impl AccountEnvelope {
    pub fn new(
        fields: Vec<(String, CanonicalValue)>,
        mempool: Vec<CanonicalValue>,
    ) -> Result<Self, EnvelopeError> {
        Self::new_with_rebalance_shadow_rows(fields, mempool, Vec::new(), Vec::new())
    }

    pub fn new_with_rebalance_shadow_rows(
        fields: Vec<(String, CanonicalValue)>,
        mempool: Vec<CanonicalValue>,
        policy_rows: Vec<(u32, CanonicalValue)>,
        submitted_rows: Vec<(u32, u64)>,
    ) -> Result<Self, EnvelopeError> {
        for (name, _) in &fields {
            if DERIVED_FIELDS.contains(&name.as_str()) {
                return Err(EnvelopeError::DerivedField(name.clone()));
            }
            if !ACCOUNT_ENVELOPE_FIELDS.contains(&name.as_str()) {
                return Err(EnvelopeError::UnclassifiedField(name.clone()));
            }
        }
        let expected_policy_root =
            shadow_root(&fields, "policyRoot")?.unwrap_or(xln_rscore_protocol::EMPTY_RADIX_ROOT);
        let mut policy = PersistentRadixMap::empty();
        for (token_id, value) in policy_rows {
            let key = crate::TokenId::new(token_id)
                .map_err(|_| EnvelopeError::RebalanceShadowPolicyRootInvalid)?
                .radix_key();
            if policy.get(&key).is_some() {
                return Err(EnvelopeError::RebalanceShadowPolicyDuplicate(token_id));
            }
            let encoded = encode_account_state_value(&value)?;
            let digest: [u8; 32] = Sha256::digest(encoded).into();
            policy = policy
                .updated(key, value, digest)
                .map_err(|error| EnvelopeError::RebalanceShadowPolicyMap(error.to_string()))?;
        }
        if policy.root_hash() != expected_policy_root {
            return Err(EnvelopeError::RebalanceShadowPolicyRootMismatch);
        }
        let expected_root = submitted_root(&fields)?;
        let mut submitted = PersistentRadixMap::empty();
        for (token_id, timestamp) in submitted_rows {
            let key = crate::TokenId::new(token_id)
                .map_err(|_| EnvelopeError::RebalanceShadowSubmittedRootInvalid)?
                .radix_key();
            if submitted.get(&key).is_some() {
                return Err(EnvelopeError::RebalanceShadowSubmittedDuplicate(token_id));
            }
            let encoded = encode_account_state_value(&CanonicalValue::Number(
                CanonicalNumber::try_from_u64(timestamp)
                    .map_err(|_| EnvelopeError::RebalanceShadowSubmittedRootInvalid)?,
            ))?;
            let digest: [u8; 32] = Sha256::digest(encoded).into();
            submitted = submitted
                .updated(key, timestamp, digest)
                .map_err(|error| EnvelopeError::RebalanceShadowSubmittedMap(error.to_string()))?;
        }
        if submitted.root_hash() != expected_root {
            return Err(EnvelopeError::RebalanceShadowSubmittedRootMismatch);
        }
        Ok(Self {
            fields,
            mempool,
            rebalance_shadow_policy: policy,
            rebalance_shadow_submitted: submitted,
        })
    }

    pub fn reproject(
        &self,
        fields: Vec<(String, CanonicalValue)>,
        mempool: Vec<CanonicalValue>,
    ) -> Result<Self, EnvelopeError> {
        if shadow_root(&fields, "policyRoot")?.unwrap_or(xln_rscore_protocol::EMPTY_RADIX_ROOT)
            != self.rebalance_shadow_policy.root_hash()
        {
            return Err(EnvelopeError::RebalanceShadowPolicyRootMismatch);
        }
        if submitted_root(&fields)? != self.rebalance_shadow_submitted.root_hash() {
            return Err(EnvelopeError::RebalanceShadowSubmittedRootMismatch);
        }
        Ok(Self {
            fields,
            mempool,
            rebalance_shadow_policy: self.rebalance_shadow_policy.clone(),
            rebalance_shadow_submitted: self.rebalance_shadow_submitted.clone(),
        })
    }

    /// Replace one parent-shell field by name. Control inputs use this for
    /// consensus-visible metadata they own without rebuilding or copying the
    /// rest of the Entity projection.
    pub fn set_field(&mut self, name: String, value: CanonicalValue) -> Result<(), EnvelopeError> {
        if DERIVED_FIELDS.contains(&name.as_str()) {
            return Err(EnvelopeError::DerivedField(name));
        }
        if !ACCOUNT_ENVELOPE_FIELDS.contains(&name.as_str()) {
            return Err(EnvelopeError::UnclassifiedField(name));
        }
        self.fields.retain(|(field, _)| field != &name);
        self.fields.push((name, value));
        Ok(())
    }

    pub fn field(&self, name: &str) -> Option<&CanonicalValue> {
        self.fields
            .iter()
            .find_map(|(field, value)| (field == name).then_some(value))
    }

    pub fn rebalance_active_quote(&self) -> Result<Option<CanonicalValue>, EnvelopeError> {
        let Some(CanonicalValue::Object(shadow)) = self.field("shadow") else {
            return Ok(None);
        };
        let Some(CanonicalValue::Object(rebalance)) = shadow
            .iter()
            .find_map(|(name, value)| (name == "rebalance").then_some(value))
        else {
            return Ok(None);
        };
        Ok(rebalance
            .iter()
            .find_map(|(name, value)| (name == "activeQuote").then_some(value.clone())))
    }

    pub fn clear_rebalance_active_quote(&mut self) -> Result<(), EnvelopeError> {
        let Some(CanonicalValue::Object(mut shadow)) = self.field("shadow").cloned() else {
            return Ok(());
        };
        let Some((_, CanonicalValue::Object(rebalance))) =
            shadow.iter_mut().find(|(name, _)| name == "rebalance")
        else {
            return Ok(());
        };
        rebalance.retain(|(name, _)| name != "activeQuote");
        self.set_field("shadow".into(), CanonicalValue::Object(shadow))
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

    /// Canonical frame-hash values in queue order. Checkpoint transport needs
    /// the exact values, not only their root, so a restored replica can
    /// reproduce the Entity account leaf byte for byte.
    pub fn mempool(&self) -> &[CanonicalValue] {
        &self.mempool
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.mempool.is_empty()
    }

    pub fn mempool_len(&self) -> usize {
        self.mempool.len()
    }

    pub fn rebalance_shadow_policy_rows(&self) -> Vec<(u32, CanonicalValue)> {
        self.rebalance_shadow_policy
            .iter()
            .map(|(key, value)| {
                let token = u32::from_be_bytes([key[28], key[29], key[30], key[31]]);
                (token, value.clone())
            })
            .collect()
    }

    pub fn rebalance_shadow_policy_root(&self) -> [u8; 32] {
        self.rebalance_shadow_policy.root_hash()
    }

    pub fn rebalance_shadow_policy(&self, token_id: crate::TokenId) -> Option<&CanonicalValue> {
        self.rebalance_shadow_policy.get(&token_id.radix_key())
    }

    pub fn set_rebalance_shadow_policy(
        &mut self,
        token_id: crate::TokenId,
        policy: CanonicalValue,
    ) -> Result<(), EnvelopeError> {
        let encoded = encode_account_state_value(&policy)?;
        let digest: [u8; 32] = Sha256::digest(encoded).into();
        self.rebalance_shadow_policy = self
            .rebalance_shadow_policy
            .updated(token_id.radix_key(), policy, digest)
            .map_err(|error| EnvelopeError::RebalanceShadowPolicyMap(error.to_string()))?;
        set_shadow_root(
            &mut self.fields,
            "policyRoot",
            self.rebalance_shadow_policy.root_hash(),
        )
    }

    pub fn rebalance_shadow_submitted_rows(&self) -> Vec<(u32, u64)> {
        self.rebalance_shadow_submitted
            .iter()
            .map(|(key, value)| {
                let token = u32::from_be_bytes([key[28], key[29], key[30], key[31]]);
                (token, *value)
            })
            .collect()
    }

    pub fn clear_rebalance_shadow_submitted(
        &mut self,
        token_id: crate::TokenId,
    ) -> Result<(), EnvelopeError> {
        let prior_root = self.rebalance_shadow_submitted.root_hash();
        self.rebalance_shadow_submitted = self
            .rebalance_shadow_submitted
            .removed(&token_id.radix_key())
            .map_err(|error| EnvelopeError::RebalanceShadowSubmittedMap(error.to_string()))?;
        let next_root = self.rebalance_shadow_submitted.root_hash();
        if prior_root != next_root || self.fields.iter().any(|(name, _)| name == "shadow") {
            set_submitted_root(&mut self.fields, next_root)?;
        }
        Ok(())
    }

    /// Diagnostic/recovery root over queued txs. It is deliberately not part
    /// of the Entity leaf: the queue is local coordination, not committed
    /// bilateral Account state.
    pub fn mempool_root(&self) -> Result<[u8; 32], EnvelopeError> {
        if self.mempool.is_empty() {
            return Ok([0; 32]);
        }
        let entries: Vec<(String, CanonicalValue)> = self
            .mempool
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect();
        Ok(xln_rscore_protocol::compute_flat_integrity_root(
            "entity.account-mempool",
            &entries,
        )?)
    }

    /// The Entity's account leaf: one encode of the sorted projection, one
    /// hash. `account_state_root` is the engine's own financial root.
    pub fn entity_account_leaf(
        &self,
        account_state_root: &[u8; 32],
    ) -> Result<[u8; 32], EnvelopeError> {
        let mut entries = Vec::with_capacity(self.fields.len() + 1);
        entries.extend(
            self.fields
                .iter()
                .filter(|(name, _)| ENTITY_ACCOUNT_LEAF_FIELDS.contains(&name.as_str()))
                .cloned(),
        );
        entries.push((
            "accountStateRoot".into(),
            CanonicalValue::String(hex_32(account_state_root)),
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

impl Default for AccountEnvelope {
    fn default() -> Self {
        Self {
            fields: Vec::new(),
            mempool: Vec::new(),
            rebalance_shadow_policy: PersistentRadixMap::empty(),
            rebalance_shadow_submitted: PersistentRadixMap::empty(),
        }
    }
}

impl std::fmt::Debug for AccountEnvelope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountEnvelope")
            .field("fields", &self.fields)
            .field("mempool", &self.mempool)
            .field(
                "rebalance_shadow_policy",
                &self.rebalance_shadow_policy_rows(),
            )
            .field(
                "rebalance_shadow_submitted",
                &self.rebalance_shadow_submitted_rows(),
            )
            .finish()
    }
}

impl PartialEq for AccountEnvelope {
    fn eq(&self, other: &Self) -> bool {
        self.fields == other.fields
            && self.mempool == other.mempool
            && self.rebalance_shadow_policy_rows() == other.rebalance_shadow_policy_rows()
            && self.rebalance_shadow_submitted_rows() == other.rebalance_shadow_submitted_rows()
    }
}

fn shadow_root(
    fields: &[(String, CanonicalValue)],
    field: &str,
) -> Result<Option<[u8; 32]>, EnvelopeError> {
    let Some(shadow_value) = fields
        .iter()
        .find_map(|(name, value)| (name == "shadow").then_some(value))
    else {
        return Ok(None);
    };
    let CanonicalValue::Object(shadow) = shadow_value else {
        return Err(EnvelopeError::RebalanceShadowPolicyRootInvalid);
    };
    let Some(CanonicalValue::Object(rebalance)) = shadow
        .iter()
        .find_map(|(name, value)| (name == "rebalance").then_some(value))
    else {
        return Err(EnvelopeError::RebalanceShadowPolicyRootInvalid);
    };
    let Some(CanonicalValue::String(root)) = rebalance
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
    else {
        return Err(EnvelopeError::RebalanceShadowPolicyRootInvalid);
    };
    crate::parse_root_hex(root)
        .map(Some)
        .ok_or(EnvelopeError::RebalanceShadowPolicyRootInvalid)
}

fn submitted_root(fields: &[(String, CanonicalValue)]) -> Result<[u8; 32], EnvelopeError> {
    shadow_root(fields, "submittedAtByTokenRoot")
        .map_err(|_| EnvelopeError::RebalanceShadowSubmittedRootInvalid)
        .map(|root| root.unwrap_or(xln_rscore_protocol::EMPTY_RADIX_ROOT))
}

fn set_submitted_root(
    fields: &mut [(String, CanonicalValue)],
    root: [u8; 32],
) -> Result<(), EnvelopeError> {
    let CanonicalValue::Object(shadow) = fields
        .iter_mut()
        .find_map(|(name, value)| (name == "shadow").then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowSubmittedRootInvalid)?
    else {
        return Err(EnvelopeError::RebalanceShadowSubmittedRootInvalid);
    };
    let CanonicalValue::Object(rebalance) = shadow
        .iter_mut()
        .find_map(|(name, value)| (name == "rebalance").then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowSubmittedRootInvalid)?
    else {
        return Err(EnvelopeError::RebalanceShadowSubmittedRootInvalid);
    };
    let value = rebalance
        .iter_mut()
        .find_map(|(name, value)| (name == "submittedAtByTokenRoot").then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowSubmittedRootInvalid)?;
    *value = CanonicalValue::String(hex_32(&root));
    Ok(())
}

fn set_shadow_root(
    fields: &mut [(String, CanonicalValue)],
    field: &str,
    root: [u8; 32],
) -> Result<(), EnvelopeError> {
    let CanonicalValue::Object(shadow) = fields
        .iter_mut()
        .find_map(|(name, value)| (name == "shadow").then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowPolicyRootInvalid)?
    else {
        return Err(EnvelopeError::RebalanceShadowPolicyRootInvalid);
    };
    let CanonicalValue::Object(rebalance) = shadow
        .iter_mut()
        .find_map(|(name, value)| (name == "rebalance").then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowPolicyRootInvalid)?
    else {
        return Err(EnvelopeError::RebalanceShadowPolicyRootInvalid);
    };
    let value = rebalance
        .iter_mut()
        .find_map(|(name, value)| (name == field).then_some(value))
        .ok_or(EnvelopeError::RebalanceShadowPolicyRootInvalid)?;
    *value = CanonicalValue::String(hex_32(&root));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shadow(root: &str) -> Vec<(String, CanonicalValue)> {
        vec![(
            "shadow".into(),
            CanonicalValue::Object(vec![(
                "rebalance".into(),
                CanonicalValue::Object(vec![
                    (
                        "policyRoot".into(),
                        CanonicalValue::String(hex_32(&xln_rscore_protocol::EMPTY_RADIX_ROOT)),
                    ),
                    (
                        "submittedAtByTokenRoot".into(),
                        CanonicalValue::String(root.into()),
                    ),
                ]),
            )]),
        )]
    }

    #[test]
    fn submitted_shadow_rows_match_typescript_root_and_delete_one_path() {
        let ts_root = "0x2568e862c4db2466a46f6963d78be727cce6690769d58c1a40a120f6a11ff4bd";
        let mut envelope = AccountEnvelope::new_with_rebalance_shadow_rows(
            shadow(ts_root),
            Vec::new(),
            Vec::new(),
            vec![(1, 123)],
        )
        .expect("TS root");
        assert_eq!(envelope.rebalance_shadow_submitted_rows(), [(1, 123)]);
        envelope
            .clear_rebalance_shadow_submitted(crate::TokenId::new(1).expect("token"))
            .expect("delete");
        assert!(envelope.rebalance_shadow_submitted_rows().is_empty());
        assert_eq!(
            submitted_root(envelope.fields()).expect("root"),
            xln_rscore_protocol::EMPTY_RADIX_ROOT
        );
    }

    #[test]
    fn policy_body_moves_the_committed_root_and_restores_without_prior_state() {
        let empty = hex_32(&xln_rscore_protocol::EMPTY_RADIX_ROOT);
        let mut envelope = AccountEnvelope::new_with_rebalance_shadow_rows(
            shadow(&empty),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
        .expect("empty envelope");
        let policy = CanonicalValue::Object(vec![
            (
                "r2cRequestSoftLimit".into(),
                CanonicalValue::BigInt(10_u8.into()),
            ),
            ("hardLimit".into(), CanonicalValue::BigInt(20_u8.into())),
            (
                "maxAcceptableFee".into(),
                CanonicalValue::BigInt(1_u8.into()),
            ),
        ]);
        envelope
            .set_rebalance_shadow_policy(crate::TokenId::new(1).expect("token"), policy.clone())
            .expect("set policy");
        let rows = envelope.rebalance_shadow_policy_rows();
        assert_eq!(rows, [(1, policy)]);
        let restored = AccountEnvelope::new_with_rebalance_shadow_rows(
            envelope.fields().to_vec(),
            Vec::new(),
            rows,
            Vec::new(),
        )
        .expect("restore policy body");
        assert_eq!(restored, envelope);
    }
}
