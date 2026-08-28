//! Canonical Entity section commitments shared with the TypeScript authority.
//!
//! Rust modules own only the sections they implement. A parent may seed the
//! remaining section digests, but the final root is always rebuilt here using
//! the exact TypeScript hierarchy: SHA-256 per section, then Keccak-256 over
//! the ordered section manifest.

use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use thiserror::Error;
use xln_rscore_protocol::{
    CanonicalValue, ConsensusMessagePackError, encode_canonical_consensus_bytes,
};

const ENTITY_SECTION_DOMAIN: &str = "xln.entity.consensus-state.sections:binary";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityConsensusSection {
    pub field: String,
    pub digest: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityConsensusError {
    #[error(transparent)]
    Encoding(#[from] ConsensusMessagePackError),
    #[error("ENTITY_CONSENSUS_SECTION_DUPLICATE:{0}")]
    DuplicateSection(String),
    #[error("ENTITY_CONSENSUS_SECTION_DIGEST_INVALID:field={field}:digest={digest}")]
    InvalidDigest { field: String, digest: String },
}

fn hex_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn canonical_digest(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value.as_bytes()[2..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

/// Exact SHA-256 commitment of one canonical Entity section value.
pub fn compute_entity_section_digest(
    value: &CanonicalValue,
) -> Result<String, EntityConsensusError> {
    let encoded = encode_canonical_consensus_bytes(value)?;
    Ok(hex_digest(&Sha256::digest(encoded)))
}

/// Exact TypeScript Entity root from an unordered complete section manifest.
pub fn compute_entity_consensus_root(
    sections: &[EntityConsensusSection],
) -> Result<String, EntityConsensusError> {
    let mut ordered = sections.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| compare_utf16(&left.field, &right.field));
    for section in &ordered {
        if !canonical_digest(&section.digest) {
            return Err(EntityConsensusError::InvalidDigest {
                field: section.field.clone(),
                digest: section.digest.clone(),
            });
        }
    }
    if let Some(pair) = ordered
        .windows(2)
        .find(|pair| pair[0].field == pair[1].field)
    {
        return Err(EntityConsensusError::DuplicateSection(
            pair[0].field.clone(),
        ));
    }
    let rows = ordered
        .into_iter()
        .map(|section| {
            object(vec![
                ("field", text(&section.field)),
                ("digest", text(&section.digest)),
            ])
        })
        .collect();
    let manifest = object(vec![
        ("domain", text(ENTITY_SECTION_DOMAIN)),
        ("sections", CanonicalValue::Array(rows)),
    ]);
    let encoded = encode_canonical_consensus_bytes(&manifest)?;
    Ok(hex_digest(&Keccak256::digest(encoded)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repeated(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn exact_typescript_entity_section_manifest_root() {
        let sections = vec![
            EntityConsensusSection {
                field: "orderbookExt".into(),
                digest: repeated("33"),
            },
            EntityConsensusSection {
                field: "accounts".into(),
                digest: repeated("11"),
            },
            EntityConsensusSection {
                field: "htlcRoutes".into(),
                digest: repeated("22"),
            },
        ];
        assert_eq!(
            compute_entity_consensus_root(&sections).expect("entity root"),
            "0x972fb942cbaf8e902682fe12a6f23334f65cea25dec704a788b87b079abde8b2"
        );
    }

    #[test]
    fn rejects_noncanonical_or_duplicate_sections() {
        let duplicate = vec![
            EntityConsensusSection {
                field: "accounts".into(),
                digest: repeated("11"),
            },
            EntityConsensusSection {
                field: "accounts".into(),
                digest: repeated("22"),
            },
        ];
        assert!(matches!(
            compute_entity_consensus_root(&duplicate),
            Err(EntityConsensusError::DuplicateSection(field)) if field == "accounts"
        ));
        assert!(matches!(
            compute_entity_consensus_root(&[EntityConsensusSection {
                field: "accounts".into(),
                digest: "0xAB".into(),
            }]),
            Err(EntityConsensusError::InvalidDigest { .. })
        ));
    }
}

#[path = "consensus/production.rs"]
mod production;

pub use production::{
    CanonicalEntityTx, CertifiedEntityFrameLink, CertifiedEntityProposal,
    CertifiedEntityTransition, ConsensusMode, ENTITY_OWNED_CONSENSUS_FIELDS, EntityAuthorityError,
    EntityCertificationError, EntityConsensusConfig, EntityConsensusState, EntityEncodingError,
    EntityFrame, EntityFrameAuthority, EntityFrameBody, EntityFrameError, EntityFrameEvent,
    EntityFrameLeader, EntityFrameWireMeasure, EntityFrameWireMeasureBody, EntityHankoWitness,
    EntityHankoWitnessMap, EntityHtlcNoteIndex, EntityLeaderState, EntityLineageError,
    EntityOutputError, EntitySingleSigner, EntityTransitionCertificationRequest,
    EntityTransitionError, EntityTxCatalogError, EntityTxKind, EntityTxSupport, HashToSign,
    HashType, LocalEntityOutput, LocalEntityOutputTx, MAX_ENTITY_FRAME_BYTES,
    MAX_ENTITY_FRAME_TX_BYTES, MAX_ENTITY_PROPOSAL_WIRE_BYTES, PendingNonMutatingWake,
    PresignedManifest, PresignedManifestEntry, ResidentEntityConsensusReplica,
    build_certified_entity_frame_link, build_entity_hash_manifest,
    build_required_j_prefix_certificate, certify_entity_transition,
    certify_single_signer_entity_frame, compute_entity_events_parity_digest,
    compute_entity_frame_hash, is_entity_owned_consensus_field, measure_entity_frame_wire,
    project_entity_consensus_sections,
};
