//! Deterministic Entity frame body and hash.
//!
//! The preimage is the exact MessagePack shape in
//! `core/entity/consensus/frame.ts`: each canonical tx is a magic-prefixed
//! binary payload, the ordered set is SHA-256 committed with u32 lengths, and
//! the header (which commits the Entity context by digest) is Keccak-256.

use std::collections::BTreeMap;

use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use super::catalog::{EntityTxCatalogError, EntityTxKind};
use super::encoding::{
    EntityEncodingError, binary_payload, hex_digest, keccak_bytes, number, object, parse_digest,
    text,
};

const ENTITY_FRAME_TXS_DOMAIN: &[u8] = b"xln:entity-frame-txs:binary";
const ENTITY_FRAME_DOMAIN: &str = "xln:entity-frame:binary-context-digest";
const ENTITY_EVENTS_PARITY_DOMAIN: &[u8] = b"xln.rscore.events-parity.v1";
const MAX_ENTITY_FRAME_BYTES: usize = 10_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalEntityTx {
    pub kind: EntityTxKind,
    /// Exact TS `canonicalEntityTxForFrameHash(tx).data` projection.
    /// AccountInput and J-event wire decoders must perform their specialized
    /// projection before constructing this trusted type.
    pub data: CanonicalValue,
    /// Exact transaction data retained in the certified Entity frame. TS
    /// hashes a smaller projection for AccountInput, but persists the complete
    /// child frame so either engine can resume from the same path-keyed DB.
    pub wire_data: CanonicalValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityFrameEvent {
    Status {
        message: String,
    },
    Text {
        validator_id: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HashType {
    EntityFrame,
    EntityOutput,
    AccountFrame,
    Dispute,
    Settlement,
    Profile,
    JBatch,
    EntityProviderAction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashToSign {
    pub hash: String,
    pub kind: HashType,
    pub context: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityFrameLeader {
    pub proposer_signer_id: String,
    pub view: u64,
    /// Multi-validator certificates remain an explicit extension point. They
    /// are not interpreted by the single-signer MVP.
    pub certificate: Option<CanonicalValue>,
    pub relay_certificate: Option<CanonicalValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityFrame {
    pub height: u64,
    pub parent_frame_hash: String,
    pub state_root: String,
    pub authority_root: String,
    pub timestamp: u64,
    pub entity_context: CanonicalValue,
    pub txs: Vec<CanonicalEntityTx>,
    pub events: Vec<EntityFrameEvent>,
    pub hash: String,
    pub leader: EntityFrameLeader,
    pub j_prefix_certificate: Option<CanonicalValue>,
    pub hashes_to_sign: Vec<HashToSign>,
    /// Raw 65-byte ECDSA signatures, recovery byte 0/1, indexed exactly like
    /// `hashes_to_sign`.
    pub collected_sigs: BTreeMap<String, Vec<Vec<u8>>>,
    /// Only the Entity-frame quorum Hanko is retained in certified lineage.
    pub hankos: Vec<Vec<u8>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityFrameError {
    #[error(transparent)]
    Encoding(#[from] EntityEncodingError),
    #[error(transparent)]
    Catalog(#[from] EntityTxCatalogError),
    #[error("ENTITY_FRAME_DIGEST_INVALID:{field}:{value}")]
    InvalidDigest { field: &'static str, value: String },
    #[error("ENTITY_FRAME_TX_TOO_LARGE:{0}")]
    TxTooLarge(usize),
    #[error("ENTITY_FRAME_TX_PREIMAGE_TOO_LARGE")]
    TxPreimageTooLarge,
    #[error("ENTITY_FRAME_EVENT_BYTE_LIMIT_EXCEEDED:{actual}:{limit}")]
    EventByteLimitExceeded { actual: usize, limit: usize },
    #[error("ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED:{actual}:{limit}")]
    TotalByteLimitExceeded { actual: usize, limit: usize },
    #[error("HTLC_PAYMENT_SECRET_CONSENSUS_FORBIDDEN")]
    HtlcSecretForbidden,
    #[error("ENTITY_FRAME_CERTIFIED_PROOF_SHAPE_INVALID:{0}")]
    CertifiedProofShapeInvalid(String),
}

fn contains_secret_field(value: &CanonicalValue) -> bool {
    match value {
        CanonicalValue::Array(entries) | CanonicalValue::Set(entries) => {
            entries.iter().any(contains_secret_field)
        }
        CanonicalValue::Map(entries) => entries.iter().any(|(key, value)| {
            matches!(key, CanonicalValue::String(key) if key == "secret")
                || contains_secret_field(key)
                || contains_secret_field(value)
        }),
        CanonicalValue::Object(entries) => entries
            .iter()
            .any(|(key, value)| key == "secret" || contains_secret_field(value)),
        _ => false,
    }
}

impl CanonicalEntityTx {
    pub fn from_frame_projection(
        kind: EntityTxKind,
        data: CanonicalValue,
    ) -> Result<Self, EntityFrameError> {
        Self::from_wire_and_frame_projection(kind, data.clone(), data)
    }

    pub fn from_wire_and_frame_projection(
        kind: EntityTxKind,
        wire_data: CanonicalValue,
        data: CanonicalValue,
    ) -> Result<Self, EntityFrameError> {
        kind.require_native_mvp()?;
        if kind == EntityTxKind::HtlcPayment && contains_secret_field(&data) {
            return Err(EntityFrameError::HtlcSecretForbidden);
        }
        Ok(Self {
            kind,
            data,
            wire_data,
        })
    }

    pub(crate) fn canonical_value(&self) -> CanonicalValue {
        object(vec![
            ("type", text(self.kind.as_str())),
            ("data", self.data.clone()),
        ])
    }

    fn binary_payload(&self) -> Result<Vec<u8>, EntityFrameError> {
        Ok(binary_payload(&self.canonical_value())?)
    }
}

impl EntityFrameEvent {
    fn canonical_value(&self) -> CanonicalValue {
        match self {
            Self::Status { message } => {
                object(vec![("type", text("status")), ("message", text(message))])
            }
            Self::Text {
                validator_id,
                message,
            } => object(vec![
                ("type", text("text")),
                ("validatorId", text(validator_id)),
                ("message", text(message)),
            ]),
        }
    }
}

impl HashType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::EntityFrame => "entityFrame",
            Self::EntityOutput => "entityOutput",
            Self::AccountFrame => "accountFrame",
            Self::Dispute => "dispute",
            Self::Settlement => "settlement",
            Self::Profile => "profile",
            Self::JBatch => "jBatch",
            Self::EntityProviderAction => "entityProviderAction",
        }
    }
}

fn canonical_root(field: &'static str, value: &str) -> Result<String, EntityFrameError> {
    parse_digest(value)
        .map(|_| value.to_string())
        .ok_or_else(|| EntityFrameError::InvalidDigest {
            field,
            value: value.to_string(),
        })
}

fn txs_commitment(txs: &[CanonicalEntityTx]) -> Result<(String, usize), EntityFrameError> {
    let mut digest = Sha256::new();
    digest.update(ENTITY_FRAME_TXS_DOMAIN);
    let mut total_bytes = 0_usize;
    for tx in txs {
        let encoded = tx.binary_payload()?;
        let length = u32::try_from(encoded.len())
            .map_err(|_| EntityFrameError::TxTooLarge(encoded.len()))?;
        total_bytes = total_bytes
            .checked_add(4)
            .and_then(|value| value.checked_add(encoded.len()))
            .ok_or(EntityFrameError::TxPreimageTooLarge)?;
        digest.update(length.to_be_bytes());
        digest.update(encoded);
    }
    Ok((hex_digest(&digest.finalize()), total_bytes))
}

fn events_value(events: &[EntityFrameEvent]) -> CanonicalValue {
    CanonicalValue::Array(
        events
            .iter()
            .map(EntityFrameEvent::canonical_value)
            .collect(),
    )
}

/// Non-consensus replay diagnostic over the exact ordered event encoding that
/// is already committed by [`compute_entity_frame_hash`]. This deliberately
/// reuses `events_value` and `binary_payload`; a second event serializer would
/// make parity diagnostics capable of disagreeing with the certified frame.
pub fn compute_entity_events_parity_digest(
    events: &[EntityFrameEvent],
) -> Result<[u8; 32], EntityFrameError> {
    let encoded = binary_payload(&events_value(events))?;
    let mut digest = Sha256::new();
    digest.update(ENTITY_EVENTS_PARITY_DOMAIN);
    digest.update(encoded);
    Ok(digest.finalize().into())
}

#[derive(Clone, Debug)]
pub struct EntityFrameBody<'a> {
    pub parent_frame_hash: &'a str,
    pub height: u64,
    pub timestamp: u64,
    pub txs: &'a [CanonicalEntityTx],
    pub events: &'a [EntityFrameEvent],
    pub entity_id: &'a str,
    pub state_root: &'a str,
    pub authority_root: &'a str,
    pub entity_context: &'a CanonicalValue,
    pub j_prefix_certificate: Option<&'a CanonicalValue>,
}

pub fn compute_entity_frame_hash(body: &EntityFrameBody<'_>) -> Result<String, EntityFrameError> {
    let state_root = canonical_root("stateRoot", body.state_root)?;
    let authority_root = canonical_root("authorityRoot", body.authority_root)?;
    let tx_count =
        u64::try_from(body.txs.len()).map_err(|_| EntityFrameError::TxPreimageTooLarge)?;
    let context = binary_payload(body.entity_context)?;
    let context_digest = hex_digest(&Sha256::digest(&context));
    let events = events_value(body.events);
    let event_bytes = if body.events.is_empty() {
        0
    } else {
        binary_payload(&events)?.len()
    };
    if event_bytes > MAX_ENTITY_FRAME_BYTES {
        return Err(EntityFrameError::EventByteLimitExceeded {
            actual: event_bytes,
            limit: MAX_ENTITY_FRAME_BYTES,
        });
    }
    let (txs_digest, tx_bytes) = txs_commitment(body.txs)?;
    let header = object(vec![
        ("domain", text(ENTITY_FRAME_DOMAIN)),
        ("prevFrameHash", text(body.parent_frame_hash)),
        ("height", number("frame.height", body.height)?),
        ("timestamp", number("frame.timestamp", body.timestamp)?),
        ("txCount", number("frame.txCount", tx_count)?),
        ("txsDigest", text(txs_digest)),
        ("events", events),
        ("entityId", text(body.entity_id)),
        ("stateRoot", text(state_root)),
        ("authorityRoot", text(authority_root)),
        ("entityContextDigest", text(context_digest)),
        (
            "jPrefixCertificate",
            body.j_prefix_certificate
                .cloned()
                .unwrap_or(CanonicalValue::Null),
        ),
    ]);
    let encoded_header = binary_payload(&header)?;
    let total_bytes = encoded_header
        .len()
        .checked_add(context.len())
        .and_then(|value| value.checked_add(tx_bytes))
        .ok_or(EntityFrameError::TxPreimageTooLarge)?;
    if total_bytes > MAX_ENTITY_FRAME_BYTES {
        return Err(EntityFrameError::TotalByteLimitExceeded {
            actual: total_bytes,
            limit: MAX_ENTITY_FRAME_BYTES,
        });
    }
    Ok(keccak_bytes(&encoded_header))
}

impl EntityFrame {
    pub fn require_certified_proof_shape(&self) -> Result<(), EntityFrameError> {
        let signer_manifest_ok = !self.collected_sigs.is_empty()
            && self.collected_sigs.iter().all(|(signer, signatures)| {
                !signer.is_empty()
                    && signatures.len() == self.hashes_to_sign.len()
                    && signatures.iter().all(|signature| !signature.is_empty())
            });
        let manifest = self.hashes_to_sign.first();
        let manifest_ok = manifest
            .is_some_and(|entry| entry.kind == HashType::EntityFrame && entry.hash == self.hash);
        if !signer_manifest_ok || !manifest_ok || self.hankos.len() != 1 {
            return Err(EntityFrameError::CertifiedProofShapeInvalid(
                self.hash.clone(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_typescript_entity_frame_hash_golden() {
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::DirectPayment,
            object(vec![
                ("targetEntityId", text("bob")),
                ("tokenId", number("tokenId", 1).expect("token id")),
                ("amount", CanonicalValue::BigInt(7.into())),
                (
                    "route",
                    CanonicalValue::Array(vec![text("alice"), text("bob")]),
                ),
                ("deliveryMode", text("direct")),
            ]),
        )
        .expect("direct payment");
        let context = object(vec![
            ("version", number("test.version", 1).expect("version")),
            (
                "htlc",
                object(vec![("entries", CanonicalValue::Array(vec![]))]),
            ),
        ]);
        let hash = compute_entity_frame_hash(&EntityFrameBody {
            parent_frame_hash: "genesis",
            height: 1,
            timestamp: 1_000,
            txs: &[tx],
            events: &[EntityFrameEvent::Status {
                message: "ok".into(),
            }],
            entity_id: &format!("0x{}", "22".repeat(32)),
            state_root: &format!("0x{}", "11".repeat(32)),
            authority_root: "0xedc4ddb8ec2d8f0a4e4c83dc91d1c51c16e828fa4bea0a914b64fd57a4bbc704",
            entity_context: &context,
            j_prefix_certificate: None,
        })
        .expect("frame hash");
        assert_eq!(
            hash,
            "0x973a1c2680c1e8ae6a7d843b7faa86eb9e87730df467d4627c1ce1317411468e",
        );
    }

    #[test]
    fn htlc_payment_plaintext_never_enters_consensus() {
        let result = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::HtlcPayment,
            object(vec![
                ("hashlock", text("0x01")),
                ("nested", object(vec![("secret", text("plaintext"))])),
            ]),
        );
        assert_eq!(result, Err(EntityFrameError::HtlcSecretForbidden));
    }
}
