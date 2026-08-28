//! Single-signer Entity quorum for the native H1 Runtime.
//!
//! The public shapes retain validator maps and secondary hash manifests, so a
//! threshold implementation can replace only this signer/certifier. The MVP
//! refuses a multi-validator authority instead of silently treating one key as
//! quorum.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use thiserror::Error;
use xln_rscore_engine::{
    BoardDelays, SigningIdentity, address_of_private_key, derive_signer_key, sign_digest,
};

use super::authority::{EntityAuthorityError, EntityFrameAuthority};
use super::encoding::parse_digest;
use super::frame::{
    EntityFrame, EntityFrameBody, EntityFrameError, EntityFrameLeader, HashToSign, HashType,
    compute_entity_frame_hash,
};

type SignedManifest = (Vec<Vec<u8>>, Vec<Vec<u8>>);

fn profile_entity_certification() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

/// Signature/Hanko bytes already authored by the resident Account worker for
/// one Account-frame digest. The constructor is crate-private so an external
/// caller cannot smuggle unverified bytes into Entity consensus; only the
/// Account result collector can create one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresignedManifestEntry {
    kind: HashType,
    signature: [u8; 65],
    hanko: Vec<u8>,
}

impl PresignedManifestEntry {
    pub(crate) fn account(signature: [u8; 65], hanko: Vec<u8>) -> Self {
        Self {
            kind: HashType::AccountFrame,
            signature,
            hanko,
        }
    }

    pub(crate) fn dispute(signature: [u8; 65], hanko: Vec<u8>) -> Self {
        Self {
            kind: HashType::Dispute,
            signature,
            hanko,
        }
    }
}

pub type PresignedManifest = BTreeMap<String, PresignedManifestEntry>;

#[derive(Clone)]
pub struct EntitySingleSigner {
    signer_id: String,
    entity_id: [u8; 32],
    private_key: [u8; 32],
    weight: u128,
    threshold: u128,
    delays: BoardDelays,
}

impl std::fmt::Debug for EntitySingleSigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EntitySingleSigner")
            .field("signerId", &self.signer_id)
            .field("entityId", &super::encoding::hex_digest(&self.entity_id))
            .field("weight", &self.weight)
            .field("threshold", &self.threshold)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedEntityProposal {
    pub frame: EntityFrame,
    /// Full manifest Hankos are needed only until Account/output witnesses are
    /// attached. Durable Entity lineage keeps `frame.hankos[0]` alone.
    pub manifest_hankos: Vec<Vec<u8>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityCertificationError {
    #[error(transparent)]
    Authority(#[from] EntityAuthorityError),
    #[error(transparent)]
    Frame(#[from] EntityFrameError),
    #[error("ENTITY_SIGNER_ID_EMPTY")]
    SignerIdEmpty,
    #[error("ENTITY_SIGNER_ENTITY_ID_INVALID:{0}")]
    EntityIdInvalid(String),
    #[error("ENTITY_SIGNER_KEY_DERIVATION_FAILED:{0}")]
    KeyDerivation(String),
    #[error("ENTITY_SINGLE_SIGNER_AUTHORITY_REQUIRED")]
    SingleSignerAuthorityRequired,
    #[error("ENTITY_SINGLE_SIGNER_AUTHORITY_MISMATCH:{expected}:{received}")]
    AuthoritySignerMismatch { expected: String, received: String },
    #[error("ENTITY_AUTHORITY_ROOT_MISMATCH:{expected}:{received}")]
    AuthorityRootMismatch { expected: String, received: String },
    #[error("ENTITY_HASH_MANIFEST_DIGEST_INVALID:{0}")]
    ManifestDigestInvalid(String),
    #[error("SECONDARY_HASH_DUPLICATE:{0}")]
    DuplicateHash(String),
    #[error("ENTITY_MANIFEST_SIGNING_FAILED:{0}")]
    SigningFailed(String),
    #[error("ENTITY_PRESIGNED_MANIFEST_KIND_INVALID:{0}")]
    PresignedKindInvalid(String),
    #[error("ENTITY_PRESIGNED_MANIFEST_UNUSED:{0}")]
    PresignedUnused(String),
}

fn entity_id(value: &str) -> Result<[u8; 32], EntityCertificationError> {
    parse_digest(value).ok_or_else(|| EntityCertificationError::EntityIdInvalid(value.to_string()))
}

impl EntitySingleSigner {
    pub fn from_seed(
        seed: &str,
        signer_id: &str,
        entity_id_text: &str,
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Result<Self, EntityCertificationError> {
        let signer = signer_id.trim().to_lowercase();
        if signer.is_empty() {
            return Err(EntityCertificationError::SignerIdEmpty);
        }
        let private_key = derive_signer_key(seed, signer_id)
            .map_err(|error| EntityCertificationError::KeyDerivation(error.to_string()))?;
        Ok(Self {
            signer_id: signer,
            entity_id: entity_id(entity_id_text)?,
            private_key,
            weight,
            threshold,
            delays,
        })
    }

    pub fn from_key(
        private_key: [u8; 32],
        signer_id: &str,
        entity_id_text: &str,
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Result<Self, EntityCertificationError> {
        let signer = signer_id.trim().to_lowercase();
        if signer.is_empty() {
            return Err(EntityCertificationError::SignerIdEmpty);
        }
        Ok(Self {
            signer_id: signer,
            entity_id: entity_id(entity_id_text)?,
            private_key,
            weight,
            threshold,
            delays,
        })
    }

    pub fn signer_id(&self) -> &str {
        &self.signer_id
    }

    /// EOA bound to this replica's signer alias by its private key.
    pub fn signer_address(&self) -> Option<[u8; 20]> {
        address_of_private_key(&self.private_key)
    }

    pub fn entity_id_text(&self) -> String {
        super::encoding::hex_digest(&self.entity_id)
    }

    pub(crate) fn sign_raw_digest(&self, digest: &[u8; 32]) -> Option<[u8; 65]> {
        sign_digest(&self.private_key, digest)
    }

    fn signing_identity(&self) -> SigningIdentity {
        SigningIdentity::from_key(
            self.private_key,
            &self.signer_id,
            self.entity_id,
            self.weight,
            self.threshold,
            self.delays,
        )
    }

    fn sign_manifest(
        &self,
        manifest: &[HashToSign],
        presigned: PresignedManifest,
    ) -> Result<SignedManifest, EntityCertificationError> {
        let identity = self.signing_identity();
        let mut signatures = Vec::with_capacity(manifest.len());
        let mut hankos = Vec::with_capacity(manifest.len());
        let mut presigned = presigned.into_iter().peekable();
        for (index, entry) in manifest.iter().enumerate() {
            let witness = if index == 0 {
                if presigned
                    .peek()
                    .is_some_and(|(hash, _)| hash == &entry.hash)
                {
                    return Err(EntityCertificationError::PresignedKindInvalid(
                        entry.hash.clone(),
                    ));
                }
                None
            } else {
                match presigned.peek() {
                    Some((hash, _)) if hash < &entry.hash => {
                        return Err(EntityCertificationError::PresignedUnused(hash.clone()));
                    }
                    Some((hash, _)) if hash == &entry.hash => {
                        presigned.next().map(|(_, witness)| witness)
                    }
                    Some(_) | None => None,
                }
            };
            if let Some(witness) = witness {
                if entry.kind != witness.kind {
                    return Err(EntityCertificationError::PresignedKindInvalid(
                        entry.hash.clone(),
                    ));
                }
                signatures.push(witness.signature.to_vec());
                hankos.push(witness.hanko);
                continue;
            }
            let digest = parse_digest(&entry.hash).ok_or_else(|| {
                EntityCertificationError::ManifestDigestInvalid(entry.hash.clone())
            })?;
            let (signature, hanko) = identity
                .sign_frame_with_raw(&digest)
                .map_err(|error| EntityCertificationError::SigningFailed(error.to_string()))?;
            signatures.push(signature.to_vec());
            hankos.push(hanko);
        }
        if let Some((hash, _)) = presigned.next() {
            return Err(EntityCertificationError::PresignedUnused(hash));
        }
        Ok((signatures, hankos))
    }
}

pub fn build_entity_hash_manifest(
    entity_id: &str,
    height: u64,
    frame_hash: &str,
    mut secondary: Vec<HashToSign>,
) -> Result<Vec<HashToSign>, EntityCertificationError> {
    if parse_digest(frame_hash).is_none() {
        return Err(EntityCertificationError::ManifestDigestInvalid(
            frame_hash.to_string(),
        ));
    }
    let mut seen = BTreeSet::from([frame_hash.to_string()]);
    for entry in &secondary {
        if parse_digest(&entry.hash).is_none() {
            return Err(EntityCertificationError::ManifestDigestInvalid(
                entry.hash.clone(),
            ));
        }
        if !seen.insert(entry.hash.clone()) {
            return Err(EntityCertificationError::DuplicateHash(entry.hash.clone()));
        }
    }
    secondary.sort_by(|left, right| left.hash.cmp(&right.hash));
    let suffix = entity_id.chars().rev().take(4).collect::<String>();
    let suffix = suffix.chars().rev().collect::<String>();
    let mut manifest = Vec::with_capacity(secondary.len() + 1);
    manifest.push(HashToSign {
        hash: frame_hash.to_string(),
        kind: HashType::EntityFrame,
        context: format!("entity:{suffix}:frame:{height}"),
    });
    manifest.extend(secondary);
    Ok(manifest)
}

pub fn certify_single_signer_entity_frame(
    signer: &EntitySingleSigner,
    authority: &EntityFrameAuthority,
    body: EntityFrameBody<'_>,
    secondary_hashes: Vec<HashToSign>,
    presigned_manifest: PresignedManifest,
) -> Result<CertifiedEntityProposal, EntityCertificationError> {
    let total_started = Instant::now();
    if !authority.is_single_signer()? {
        return Err(EntityCertificationError::SingleSignerAuthorityRequired);
    }
    let normalized = authority.validate_and_normalize()?;
    let authority_signer = normalized
        .config
        .validators
        .first()
        .ok_or(EntityAuthorityError::ValidatorsEmpty)?;
    if authority_signer != signer.signer_id() {
        return Err(EntityCertificationError::AuthoritySignerMismatch {
            expected: authority_signer.clone(),
            received: signer.signer_id().to_string(),
        });
    }
    let authority_root = authority.root()?;
    if authority_root != body.authority_root {
        return Err(EntityCertificationError::AuthorityRootMismatch {
            expected: authority_root,
            received: body.authority_root.to_string(),
        });
    }
    let authority_done = total_started.elapsed();
    let frame_hash = compute_entity_frame_hash(&body)?;
    let hash_done = total_started.elapsed();
    let manifest =
        build_entity_hash_manifest(body.entity_id, body.height, &frame_hash, secondary_hashes)?;
    let manifest_done = total_started.elapsed();
    let (signatures, hankos) = signer.sign_manifest(&manifest, presigned_manifest)?;
    let sign_done = total_started.elapsed();
    let entity_hanko = hankos
        .first()
        .cloned()
        .ok_or_else(|| EntityCertificationError::SigningFailed(frame_hash.clone()))?;
    let frame = EntityFrame {
        height: body.height,
        parent_frame_hash: body.parent_frame_hash.to_string(),
        state_root: body.state_root.to_string(),
        authority_root: body.authority_root.to_string(),
        timestamp: body.timestamp,
        entity_context: body.entity_context.clone(),
        txs: body.txs.to_vec(),
        events: body.events.to_vec(),
        hash: frame_hash,
        leader: EntityFrameLeader {
            proposer_signer_id: signer.signer_id().to_string(),
            view: normalized.leader_state.view,
            certificate: None,
            relay_certificate: None,
        },
        j_prefix_certificate: body.j_prefix_certificate.cloned(),
        hashes_to_sign: manifest,
        collected_sigs: BTreeMap::from([(signer.signer_id().to_string(), signatures)]),
        hankos: vec![entity_hanko],
    };
    let frame_done = total_started.elapsed();
    frame.require_certified_proof_shape()?;
    if profile_entity_certification() {
        let total = total_started.elapsed();
        eprintln!(
            "RSCORE_ENTITY_FRAME_PHASE authority={} hash={} manifest={} sign={} clone={} proof={} total={} txs={} events={} hashes={}",
            authority_done.as_micros(),
            hash_done.saturating_sub(authority_done).as_micros(),
            manifest_done.saturating_sub(hash_done).as_micros(),
            sign_done.saturating_sub(manifest_done).as_micros(),
            frame_done.saturating_sub(sign_done).as_micros(),
            total.saturating_sub(frame_done).as_micros(),
            total.as_micros(),
            frame.txs.len(),
            frame.events.len(),
            frame.hashes_to_sign.len(),
        );
    }
    Ok(CertifiedEntityProposal {
        frame,
        manifest_hankos: hankos,
    })
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use xln_rscore_protocol::CanonicalValue;

    use super::super::authority::{ConsensusMode, EntityConsensusConfig, EntityLeaderState};
    use super::super::catalog::EntityTxKind;
    use super::super::encoding::{number, object, text};
    use super::super::frame::{CanonicalEntityTx, EntityFrameEvent};
    use super::*;

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["h1-hub".into()],
                shares: BTreeMap::from([("h1-hub".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: EntityLeaderState {
                active_validator_id: "h1-hub".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    #[test]
    fn single_signer_proposal_has_exact_manifest_and_proof_shape() {
        let entity = "0x1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08";
        let key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key hex")
                .try_into()
                .expect("key bytes");
        let signer =
            EntitySingleSigner::from_key(key, "h1-hub", entity, 1, 1, BoardDelays::default())
                .expect("signer");
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::DirectPayment,
            object(vec![
                ("targetEntityId", text("bob")),
                ("tokenId", number("tokenId", 1).expect("token")),
                ("amount", CanonicalValue::BigInt(BigInt::from(7))),
                (
                    "route",
                    CanonicalValue::Array(vec![text("alice"), text("bob")]),
                ),
                ("deliveryMode", text("direct")),
            ]),
        )
        .expect("tx");
        let context = object(vec![
            ("version", number("version", 1).expect("version")),
            (
                "htlc",
                object(vec![("entries", CanonicalValue::Array(vec![]))]),
            ),
        ]);
        let authority = authority();
        let authority_root = authority.root().expect("root");
        let txs = vec![tx];
        let events = vec![EntityFrameEvent::Status {
            message: "ok".into(),
        }];
        let result = certify_single_signer_entity_frame(
            &signer,
            &authority,
            EntityFrameBody {
                parent_frame_hash: "genesis",
                height: 1,
                timestamp: 1_000,
                txs: &txs,
                events: &events,
                entity_id: entity,
                state_root: &format!("0x{}", "11".repeat(32)),
                authority_root: &authority_root,
                entity_context: &context,
                j_prefix_certificate: None,
            },
            vec![],
            BTreeMap::new(),
        )
        .expect("certified");
        assert_eq!(result.frame.hashes_to_sign.len(), 1);
        assert_eq!(result.frame.hankos.len(), 1);
        assert_eq!(result.manifest_hankos.len(), 1);
        assert_eq!(result.frame.collected_sigs["h1-hub"][0].len(), 65);
        result
            .frame
            .require_certified_proof_shape()
            .expect("proof shape");
    }

    #[test]
    fn account_worker_signature_reuse_is_byte_identical_for_frame_and_dispute() {
        let entity = "0x1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08";
        let key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key hex")
                .try_into()
                .expect("key bytes");
        let signer =
            EntitySingleSigner::from_key(key, "h1-hub", entity, 1, 1, BoardDelays::default())
                .expect("signer");
        let authority = authority();
        let authority_root = authority.root().expect("root");
        let context = object(vec![("version", number("version", 1).expect("version"))]);
        let txs = Vec::new();
        let events = Vec::new();
        let state_root = format!("0x{}", "11".repeat(32));
        let account_hash = format!("0x{}", "33".repeat(32));
        let dispute_hash = format!("0x{}", "44".repeat(32));
        let secondary = vec![
            HashToSign {
                hash: account_hash.clone(),
                kind: HashType::AccountFrame,
                context: "account:fixture:frame:1".into(),
            },
            HashToSign {
                hash: dispute_hash.clone(),
                kind: HashType::Dispute,
                context: "account:fixture:dispute".into(),
            },
        ];
        let body = || EntityFrameBody {
            parent_frame_hash: "genesis",
            height: 1,
            timestamp: 1_000,
            txs: &txs,
            events: &events,
            entity_id: entity,
            state_root: &state_root,
            authority_root: &authority_root,
            entity_context: &context,
            j_prefix_certificate: None,
        };

        let baseline = certify_single_signer_entity_frame(
            &signer,
            &authority,
            body(),
            secondary.clone(),
            PresignedManifest::new(),
        )
        .expect("baseline");
        let digest = parse_digest(&account_hash).expect("account hash");
        let (signature, hanko) = signer
            .signing_identity()
            .sign_frame_with_raw(&digest)
            .expect("account worker signature");
        let dispute_digest = parse_digest(&dispute_hash).expect("dispute hash");
        let (dispute_signature, dispute_hanko) = signer
            .signing_identity()
            .sign_frame_with_raw(&dispute_digest)
            .expect("account worker dispute signature");
        let reused = certify_single_signer_entity_frame(
            &signer,
            &authority,
            body(),
            secondary,
            PresignedManifest::from([
                (
                    account_hash,
                    PresignedManifestEntry::account(signature, hanko),
                ),
                (
                    dispute_hash,
                    PresignedManifestEntry::dispute(dispute_signature, dispute_hanko),
                ),
            ]),
        )
        .expect("reused");

        assert_eq!(reused, baseline);
    }
}
