//! Deterministic Entity frame body and hash.
//!
//! The preimage is the exact MessagePack shape in
//! `core/entity/consensus/frame.ts`: each canonical tx is a magic-prefixed
//! binary payload, the ordered set is SHA-256 committed with u32 lengths, and
//! the header (which commits the Entity context by digest) is Keccak-256.

use std::collections::BTreeMap;
use std::sync::Arc;

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
pub const MAX_ENTITY_FRAME_BYTES: usize = 10_000_000;
/// TS `LIMITS.MAX_ENTITY_FRAME_TXS`: FIFO prefix cut before apply, live and replay alike.
pub const MAX_ENTITY_FRAME_TXS: usize = 1000;
pub const MAX_ENTITY_FRAME_TX_BYTES: usize = MAX_ENTITY_FRAME_BYTES / 2;
pub const MAX_ENTITY_PROPOSAL_WIRE_BYTES: usize =
    MAX_ENTITY_FRAME_BYTES - MAX_ENTITY_FRAME_BYTES / 3 - MAX_ENTITY_FRAME_BYTES / 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalEntityTx {
    pub kind: EntityTxKind,
    /// Exact TS `canonicalEntityTxForFrameHash(tx).data` projection.
    /// AccountInput and J-event wire decoders must perform their specialized
    /// projection before constructing this trusted type.
    data: Option<CanonicalValue>,
    /// Exact transaction data retained in the certified Entity frame. TS
    /// hashes a smaller projection for AccountInput, but persists the complete
    /// child frame so either engine can resume from the same path-keyed DB.
    pub wire_data: CanonicalValue,
    /// Exact canonical `{type,data}` bytes. Computing them at admission makes
    /// wire fitting and the certified frame hash share one encoder result.
    /// AccountInput drops the redundant parsed projection after this byte
    /// string is born; typed execution uses `wire_data`/AccountInputRow.
    frame_payload: Arc<[u8]>,
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
        if kind == EntityTxKind::HtlcPayment && contains_secret_field(&data) {
            return Err(EntityFrameError::HtlcSecretForbidden);
        }
        let canonical = object(vec![("type", text(kind.as_str())), ("data", data.clone())]);
        let frame_payload = Arc::<[u8]>::from(binary_payload(&canonical)?);
        Ok(Self {
            kind,
            data: (kind != EntityTxKind::AccountInput).then_some(data),
            wire_data,
            frame_payload,
        })
    }

    pub fn frame_data(&self) -> Option<&CanonicalValue> {
        self.data.as_ref()
    }

    pub(crate) fn canonical_value(&self) -> Option<CanonicalValue> {
        self.data.as_ref().map(|data| {
            object(vec![
                ("type", text(self.kind.as_str())),
                ("data", data.clone()),
            ])
        })
    }

    pub(crate) fn frame_payload(&self) -> &[u8] {
        &self.frame_payload
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

fn txs_commitment<'a>(
    txs: impl IntoIterator<Item = &'a CanonicalEntityTx>,
) -> Result<(String, usize), EntityFrameError> {
    let mut digest = Sha256::new();
    digest.update(ENTITY_FRAME_TXS_DOMAIN);
    let mut total_bytes = 0_usize;
    for tx in txs {
        let encoded = tx.frame_payload();
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

/// Exact bytes contributed by one transaction to the canonical ordered
/// transaction preimage: the u32 length plus the canonical binary payload.
/// Live FIFO selection calls this only until the frame budget is full.
pub fn measure_entity_frame_tx_bytes(tx: &CanonicalEntityTx) -> Result<usize, EntityFrameError> {
    let encoded = tx.frame_payload();
    u32::try_from(encoded.len()).map_err(|_| EntityFrameError::TxTooLarge(encoded.len()))?;
    encoded
        .len()
        .checked_add(4)
        .ok_or(EntityFrameError::TxPreimageTooLarge)
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

#[derive(Clone, Copy, Debug)]
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
    /// Optional pre-encoded canonical context. Production certification sets
    /// this after wire fitting; replay/lineage verification encodes on demand.
    pub entity_context_bytes: Option<&'a [u8]>,
    pub j_prefix_certificate: Option<&'a CanonicalValue>,
}

/// Owned production draft. Certification hashes a borrowed view and then
/// moves the same tx/event/context buffers into the certified frame; the hot
/// path never clones a multi-megabyte Entity body after proving it.
#[derive(Clone, Debug)]
pub struct EntityFrameDraft {
    pub parent_frame_hash: String,
    pub height: u64,
    pub timestamp: u64,
    pub txs: Vec<CanonicalEntityTx>,
    pub events: Vec<EntityFrameEvent>,
    pub entity_id: String,
    pub state_root: String,
    pub authority_root: String,
    pub entity_context: CanonicalValue,
    /// Exact canonical bytes already measured during Runtime prefix fitting.
    /// This is transient proof material, not a second persisted context: the
    /// certified frame still owns only `entity_context`.
    pub entity_context_bytes: Vec<u8>,
    pub j_prefix_certificate: Option<CanonicalValue>,
}

impl EntityFrameDraft {
    pub fn body(&self) -> EntityFrameBody<'_> {
        EntityFrameBody {
            parent_frame_hash: &self.parent_frame_hash,
            height: self.height,
            timestamp: self.timestamp,
            txs: &self.txs,
            events: &self.events,
            entity_id: &self.entity_id,
            state_root: &self.state_root,
            authority_root: &self.authority_root,
            entity_context: &self.entity_context,
            entity_context_bytes: Some(&self.entity_context_bytes),
            j_prefix_certificate: self.j_prefix_certificate.as_ref(),
        }
    }
}

/// Borrowed pre-apply view over the exact canonical Entity-frame encoder.
/// Live prefix fitting uses this instead of maintaining a second size oracle.
pub struct EntityFrameWireMeasureBody<'a> {
    pub parent_frame_hash: &'a str,
    pub height: u64,
    pub timestamp: u64,
    pub txs: &'a [&'a CanonicalEntityTx],
    pub events: &'a [EntityFrameEvent],
    pub entity_id: &'a str,
    pub state_root: &'a str,
    pub authority_root: &'a str,
    /// Canonical Entity context bytes produced by `encode_entity_frame_context`.
    pub entity_context_bytes: &'a [u8],
    pub j_prefix_certificate: Option<&'a CanonicalValue>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntityFrameWireMeasure {
    pub total_bytes: usize,
    pub tx_bytes: usize,
    pub context_bytes: usize,
    pub event_bytes: usize,
    pub header_bytes: usize,
}

#[allow(clippy::too_many_arguments)]
fn encode_entity_frame_wire<'a>(
    parent_frame_hash: &str,
    height: u64,
    timestamp: u64,
    txs: impl ExactSizeIterator<Item = &'a CanonicalEntityTx>,
    events: &[EntityFrameEvent],
    entity_id: &str,
    state_root: &str,
    authority_root: &str,
    entity_context_bytes: &[u8],
    j_prefix_certificate: Option<&CanonicalValue>,
) -> Result<(Vec<u8>, EntityFrameWireMeasure), EntityFrameError> {
    let state_root = canonical_root("stateRoot", state_root)?;
    let authority_root = canonical_root("authorityRoot", authority_root)?;
    let tx_count = u64::try_from(txs.len()).map_err(|_| EntityFrameError::TxPreimageTooLarge)?;
    let context_digest = hex_digest(&Sha256::digest(entity_context_bytes));
    let events = events_value(events);
    let event_bytes = if events == CanonicalValue::Array(Vec::new()) {
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
    let (txs_digest, tx_bytes) = txs_commitment(txs)?;
    let header = object(vec![
        ("domain", text(ENTITY_FRAME_DOMAIN)),
        ("prevFrameHash", text(parent_frame_hash)),
        ("height", number("frame.height", height)?),
        ("timestamp", number("frame.timestamp", timestamp)?),
        ("txCount", number("frame.txCount", tx_count)?),
        ("txsDigest", text(txs_digest)),
        ("events", events),
        ("entityId", text(entity_id)),
        ("stateRoot", text(state_root)),
        ("authorityRoot", text(authority_root)),
        ("entityContextDigest", text(context_digest)),
        (
            "jPrefixCertificate",
            j_prefix_certificate
                .cloned()
                .unwrap_or(CanonicalValue::Null),
        ),
    ]);
    let encoded_header = binary_payload(&header)?;
    let header_bytes = encoded_header.len();
    let context_bytes = entity_context_bytes.len();
    let total_bytes = header_bytes
        .checked_add(context_bytes)
        .and_then(|value| value.checked_add(tx_bytes))
        .ok_or(EntityFrameError::TxPreimageTooLarge)?;
    Ok((
        encoded_header,
        EntityFrameWireMeasure {
            total_bytes,
            tx_bytes,
            context_bytes,
            event_bytes,
            header_bytes,
        },
    ))
}

/// Encode the committed Entity context once at the Runtime boundary. Prefix
/// fitting and frame certification consume these exact bytes; callers cannot
/// accidentally substitute JSON or another local wire representation.
pub fn encode_entity_frame_context(
    entity_context: &CanonicalValue,
) -> Result<Vec<u8>, EntityFrameError> {
    Ok(binary_payload(entity_context)?)
}

pub fn measure_entity_frame_wire(
    body: &EntityFrameWireMeasureBody<'_>,
) -> Result<EntityFrameWireMeasure, EntityFrameError> {
    const DUMMY_DIGEST: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
    let state_root = canonical_root("stateRoot", body.state_root)?;
    let authority_root = canonical_root("authorityRoot", body.authority_root)?;
    let tx_count =
        u64::try_from(body.txs.len()).map_err(|_| EntityFrameError::TxPreimageTooLarge)?;
    let context_bytes = body.entity_context_bytes.len();
    let events = events_value(body.events);
    let event_bytes = if events == CanonicalValue::Array(Vec::new()) {
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
    let tx_bytes = body.txs.iter().try_fold(0_usize, |total, tx| {
        total
            .checked_add(measure_entity_frame_tx_bytes(tx)?)
            .ok_or(EntityFrameError::TxPreimageTooLarge)
    })?;
    // Wire fitting needs only the exact encoded length. Both digests below
    // are fixed-width hex strings, so hashing the complete context and every
    // already-encoded transaction here was a pure duplicate of certification.
    let header = object(vec![
        ("domain", text(ENTITY_FRAME_DOMAIN)),
        ("prevFrameHash", text(body.parent_frame_hash)),
        ("height", number("frame.height", body.height)?),
        ("timestamp", number("frame.timestamp", body.timestamp)?),
        ("txCount", number("frame.txCount", tx_count)?),
        ("txsDigest", text(DUMMY_DIGEST)),
        ("events", events),
        ("entityId", text(body.entity_id)),
        ("stateRoot", text(state_root)),
        ("authorityRoot", text(authority_root)),
        ("entityContextDigest", text(DUMMY_DIGEST)),
        (
            "jPrefixCertificate",
            body.j_prefix_certificate
                .cloned()
                .unwrap_or(CanonicalValue::Null),
        ),
    ]);
    let header_bytes = binary_payload(&header)?.len();
    let total_bytes = header_bytes
        .checked_add(context_bytes)
        .and_then(|value| value.checked_add(tx_bytes))
        .ok_or(EntityFrameError::TxPreimageTooLarge)?;
    Ok(EntityFrameWireMeasure {
        total_bytes,
        tx_bytes,
        context_bytes,
        event_bytes,
        header_bytes,
    })
}

pub fn compute_entity_frame_hash(body: &EntityFrameBody<'_>) -> Result<String, EntityFrameError> {
    compute_entity_frame_hash_with_measure(body).map(|(hash, _)| hash)
}

pub fn compute_entity_frame_hash_with_measure(
    body: &EntityFrameBody<'_>,
) -> Result<(String, EntityFrameWireMeasure), EntityFrameError> {
    let encoded_context;
    let context_bytes = match body.entity_context_bytes {
        Some(bytes) => bytes,
        None => {
            encoded_context = encode_entity_frame_context(body.entity_context)?;
            &encoded_context
        }
    };
    let (encoded_header, measure) = encode_entity_frame_wire(
        body.parent_frame_hash,
        body.height,
        body.timestamp,
        body.txs.iter(),
        body.events,
        body.entity_id,
        body.state_root,
        body.authority_root,
        context_bytes,
        body.j_prefix_certificate,
    )?;
    if measure.total_bytes > MAX_ENTITY_FRAME_BYTES {
        return Err(EntityFrameError::TotalByteLimitExceeded {
            actual: measure.total_bytes,
            limit: MAX_ENTITY_FRAME_BYTES,
        });
    }
    Ok((keccak_bytes(&encoded_header), measure))
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

    /// Secondary manifest rows are transient commit material. Their Hankos
    /// have already been attached to the exact Account/output payloads before
    /// a frame enters durable lineage; retaining the same hashes and raw
    /// signatures in the certified head is a second authority copy.
    pub fn compact_lineage_proof(&mut self) -> Result<(), EntityFrameError> {
        self.require_certified_proof_shape()?;
        self.hashes_to_sign.truncate(1);
        for signatures in self.collected_sigs.values_mut() {
            signatures.truncate(1);
        }
        self.hankos.truncate(1);
        self.require_certified_proof_shape()
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
            entity_context_bytes: None,
            j_prefix_certificate: None,
        })
        .expect("frame hash");
        assert_eq!(
            hash,
            "0xa858bd0cd66a4d80711d9bc7a554f70a38baa0d6aadbae854178c11252ae8909",
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

    #[test]
    fn tx_bytes_match_the_canonical_wire_measure() {
        let first =
            CanonicalEntityTx::from_frame_projection(EntityTxKind::DirectPayment, text("first"))
                .expect("first tx");
        let second =
            CanonicalEntityTx::from_frame_projection(EntityTxKind::DirectPayment, text("second"))
                .expect("second tx");
        let txs = [&first, &second];
        let first_bytes = measure_entity_frame_tx_bytes(&first).expect("first bytes");
        let second_bytes = measure_entity_frame_tx_bytes(&second).expect("second bytes");
        let context_bytes = encode_entity_frame_context(&CanonicalValue::Object(Vec::new()))
            .expect("context bytes");
        let measured = measure_entity_frame_wire(&EntityFrameWireMeasureBody {
            parent_frame_hash: "genesis",
            height: 1,
            timestamp: 1,
            txs: &txs,
            events: &[],
            entity_id: &format!("0x{}", "22".repeat(32)),
            state_root: &format!("0x{}", "11".repeat(32)),
            authority_root: &format!("0x{}", "33".repeat(32)),
            entity_context_bytes: &context_bytes,
            j_prefix_certificate: None,
        })
        .expect("wire measure");
        assert_eq!(first_bytes + second_bytes, measured.tx_bytes);
        assert!(first_bytes > 4 && second_bytes > 4);
    }

    #[test]
    fn size_only_wire_measure_matches_the_hashing_encoder() {
        let first =
            CanonicalEntityTx::from_frame_projection(EntityTxKind::DirectPayment, text("first"))
                .expect("first tx");
        let second =
            CanonicalEntityTx::from_frame_projection(EntityTxKind::DirectPayment, text("second"))
                .expect("second tx");
        let txs = [&first, &second];
        let context = object(vec![("peerAssertions", CanonicalValue::Array(Vec::new()))]);
        let context_bytes = encode_entity_frame_context(&context).expect("context bytes");
        let body = EntityFrameWireMeasureBody {
            parent_frame_hash: "genesis",
            height: 1,
            timestamp: 1,
            txs: &txs,
            events: &[EntityFrameEvent::Status {
                message: "accepted".into(),
            }],
            entity_id: &format!("0x{}", "22".repeat(32)),
            state_root: &format!("0x{}", "11".repeat(32)),
            authority_root: &format!("0x{}", "33".repeat(32)),
            entity_context_bytes: &context_bytes,
            j_prefix_certificate: None,
        };
        let measured = measure_entity_frame_wire(&body).expect("size-only measure");
        let (_, encoded) = encode_entity_frame_wire(
            body.parent_frame_hash,
            body.height,
            body.timestamp,
            body.txs.iter().copied(),
            body.events,
            body.entity_id,
            body.state_root,
            body.authority_root,
            body.entity_context_bytes,
            body.j_prefix_certificate,
        )
        .expect("hashing encoder");
        assert_eq!(measured, encoded);

        let owned_txs = vec![first.clone(), second.clone()];
        let preencoded = EntityFrameBody {
            parent_frame_hash: body.parent_frame_hash,
            height: body.height,
            timestamp: body.timestamp,
            txs: &owned_txs,
            events: body.events,
            entity_id: body.entity_id,
            state_root: body.state_root,
            authority_root: body.authority_root,
            entity_context: &context,
            entity_context_bytes: Some(&context_bytes),
            j_prefix_certificate: body.j_prefix_certificate,
        };
        let fallback = EntityFrameBody {
            entity_context_bytes: None,
            ..preencoded
        };
        assert_eq!(
            compute_entity_frame_hash_with_measure(&preencoded).expect("preencoded hash"),
            compute_entity_frame_hash_with_measure(&fallback).expect("fallback hash"),
        );
    }

    #[test]
    fn empty_event_parity_vector_matches_typescript() {
        assert_eq!(
            hex_digest(&compute_entity_events_parity_digest(&[]).expect("empty event digest"),),
            "0x701d6f37973653c3cd817e7c8b7cbc401a10bdad404170e7cda85a02f605d656",
        );
    }
}
