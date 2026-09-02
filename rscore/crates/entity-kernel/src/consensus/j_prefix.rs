//! Native single-signer Entity J-prefix attestation/certificate.
//!
//! Exact mirror of `core/jurisdiction/machine/history/j-prefix-consensus.ts`
//! (`buildLocalJPrefixAttestation`, `buildJPrefixCertificate`) for the H1
//! steady-state slice: a registered, single-signer Entity with no pending
//! local J-event range attests exactly its already-certified
//! `jHistoryFinality` anchor (`buildCertifiedBaseClaim`) every round. A
//! multi-validator authority or a pending local J-event range is a distinct,
//! unported protocol path and fails loudly instead of guessing bytes.

use std::collections::BTreeMap;

use sha3::{Digest as _, Keccak256};
use thiserror::Error;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_canonical_consensus_bytes};

use crate::{
    CanonicalJEventBlock, EntityStateSlice,
    j_events::{canonical_j_event_range_hash, j_event_range_digest},
};

use super::authority::{EntityAuthorityError, EntityFrameAuthority};
use super::single_signer::EntitySingleSigner;

const J_PREFIX_ATTESTATION_DOMAIN: &str = "xln:j-prefix-attestation:v1";
const J_PREFIX_VERSION: u64 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JPrefixError {
    #[error(transparent)]
    Authority(#[from] EntityAuthorityError),
    #[error("J_PREFIX_MULTI_VALIDATOR_UNSUPPORTED")]
    MultiValidatorUnsupported,
    #[error("J_PREFIX_PENDING_LOCAL_EVENT_UNSUPPORTED")]
    PendingLocalEventUnsupported,
    #[error("J_PREFIX_HISTORY_FINALITY_MISSING")]
    HistoryFinalityMissing,
    #[error("J_PREFIX_HISTORY_FINALITY_INVALID:{0}")]
    HistoryFinalityInvalid(&'static str),
    #[error("J_PREFIX_HISTORY_FINALITY_HEIGHT_MISMATCH:{finality}:{last_finalized}")]
    HistoryFinalityHeightMismatch { finality: u64, last_finalized: u64 },
    #[error("J_PREFIX_JURISDICTION_MISSING")]
    JurisdictionMissing,
    #[error("J_PREFIX_JURISDICTION_INVALID:{0}")]
    JurisdictionInvalid(&'static str),
    #[error("J_PREFIX_JURISDICTION_MISMATCH")]
    JurisdictionMismatch,
    #[error("J_PREFIX_NUMBER_UNSAFE")]
    NumberUnsafe,
    #[error("J_PREFIX_SIGNING_FAILED")]
    SigningFailed,
    #[error("J_PREFIX_ENCODING:{0}")]
    Encoding(String),
}

/// Exact single-signer range already derived from the authenticated local
/// watcher history. Runtime constructs this value once and uses it for both
/// the `j_event` transaction and the J-prefix certificate; the consensus
/// layer must never rebuild a second view of the same range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JPrefixRangeClaim {
    pub jurisdiction_ref: String,
    pub base_height: u64,
    pub scanned_through_height: u64,
    pub tip_block_hash: String,
    pub event_history_root: String,
    pub range_hash: String,
    pub headers: Vec<CanonicalValue>,
    pub blocks: Vec<CanonicalValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JPrefixClaim {
    jurisdiction_ref: String,
    base_height: u64,
    scanned_through_height: u64,
    tip_block_hash: String,
    event_history_root: String,
    range_hash: String,
    blocks: Vec<CanonicalValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JPrefixAttestation {
    entity_id: String,
    target_entity_height: u64,
    parent_frame_hash: String,
    validator_id: String,
    claim: JPrefixClaim,
    headers: Vec<CanonicalValue>,
    signature: String,
}

fn number(value: u64) -> Result<CanonicalValue, JPrefixError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| JPrefixError::NumberUnsafe)
}

fn claim_canonical(claim: &JPrefixClaim) -> Result<CanonicalValue, JPrefixError> {
    Ok(CanonicalValue::Object(vec![
        (
            "jurisdictionRef".into(),
            CanonicalValue::String(claim.jurisdiction_ref.clone()),
        ),
        ("baseHeight".into(), number(claim.base_height)?),
        (
            "scannedThroughHeight".into(),
            number(claim.scanned_through_height)?,
        ),
        (
            "tipBlockHash".into(),
            CanonicalValue::String(claim.tip_block_hash.clone()),
        ),
        (
            "eventHistoryRoot".into(),
            CanonicalValue::String(claim.event_history_root.clone()),
        ),
        (
            "rangeHash".into(),
            CanonicalValue::String(claim.range_hash.clone()),
        ),
        ("blocks".into(), CanonicalValue::Array(claim.blocks.clone())),
    ]))
}

/// Shared prefix of the attestation body used both unsigned (for the signing
/// hash) and fully (nested inside the certificate for the frame hash).
fn attestation_fields(
    attestation: &JPrefixAttestation,
) -> Result<Vec<(String, CanonicalValue)>, JPrefixError> {
    Ok(vec![
        ("version".into(), number(J_PREFIX_VERSION)?),
        (
            "entityId".into(),
            CanonicalValue::String(attestation.entity_id.clone()),
        ),
        (
            "targetEntityHeight".into(),
            number(attestation.target_entity_height)?,
        ),
        (
            "parentFrameHash".into(),
            CanonicalValue::String(attestation.parent_frame_hash.clone()),
        ),
        (
            "validatorId".into(),
            CanonicalValue::String(attestation.validator_id.clone()),
        ),
        (
            "jurisdictionRef".into(),
            CanonicalValue::String(attestation.claim.jurisdiction_ref.clone()),
        ),
        ("baseHeight".into(), number(attestation.claim.base_height)?),
        (
            "scannedThroughHeight".into(),
            number(attestation.claim.scanned_through_height)?,
        ),
        (
            "tipBlockHash".into(),
            CanonicalValue::String(attestation.claim.tip_block_hash.clone()),
        ),
        (
            "eventHistoryRoot".into(),
            CanonicalValue::String(attestation.claim.event_history_root.clone()),
        ),
        (
            "rangeHash".into(),
            CanonicalValue::String(attestation.claim.range_hash.clone()),
        ),
        (
            "headers".into(),
            CanonicalValue::Array(attestation.headers.clone()),
        ),
        (
            "blocks".into(),
            CanonicalValue::Array(attestation.claim.blocks.clone()),
        ),
    ])
}

fn attestation_unsigned_canonical(
    attestation: &JPrefixAttestation,
) -> Result<CanonicalValue, JPrefixError> {
    let mut fields = vec![(
        "domain".into(),
        CanonicalValue::String(J_PREFIX_ATTESTATION_DOMAIN.into()),
    )];
    fields.extend(attestation_fields(attestation)?);
    Ok(CanonicalValue::Object(fields))
}

fn attestation_full_canonical(
    attestation: &JPrefixAttestation,
) -> Result<CanonicalValue, JPrefixError> {
    let mut fields = attestation_fields(attestation)?;
    fields.push((
        "signature".into(),
        CanonicalValue::String(attestation.signature.clone()),
    ));
    Ok(CanonicalValue::Object(fields))
}

fn hash_attestation(attestation: &JPrefixAttestation) -> Result<[u8; 32], JPrefixError> {
    let bytes = encode_canonical_consensus_bytes(&attestation_unsigned_canonical(attestation)?)
        .map_err(|error| JPrefixError::Encoding(error.to_string()))?;
    Ok(Keccak256::digest(bytes).into())
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn object_field<'a>(value: &'a CanonicalValue, field: &str) -> Option<&'a CanonicalValue> {
    match value {
        CanonicalValue::Object(entries) => entries
            .iter()
            .find_map(|(key, value)| (key == field).then_some(value)),
        _ => None,
    }
}

fn field_string(value: &CanonicalValue, field: &str) -> Option<String> {
    match object_field(value, field) {
        Some(CanonicalValue::String(text)) => Some(text.trim().to_lowercase()),
        _ => None,
    }
}

fn field_u64(value: &CanonicalValue, field: &str) -> Option<u64> {
    match object_field(value, field) {
        Some(CanonicalValue::Number(number)) => number.as_str().parse::<u64>().ok(),
        _ => None,
    }
}

fn is_hex32(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value.as_bytes()[2..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// `stack:{chainId}:{depositoryAddress}` — exact mirror of
/// `getJurisdictionStackId`/`getJEventJurisdictionRef` for a directly
/// configured (non-`contracts.depository`) jurisdiction.
fn jurisdiction_ref(jurisdiction: Option<&CanonicalValue>) -> Result<String, JPrefixError> {
    let Some(jurisdiction) = jurisdiction else {
        return Ok("unconfigured".into());
    };
    let Some(address) = field_string(jurisdiction, "depositoryAddress") else {
        return Ok("unconfigured".into());
    };
    if address.len() != 42 || !address.starts_with("0x") {
        return Err(JPrefixError::JurisdictionInvalid("DEPOSITORY_ADDRESS"));
    }
    let chain_id =
        field_u64(jurisdiction, "chainId").ok_or(JPrefixError::JurisdictionInvalid("CHAIN_ID"))?;
    Ok(format!("stack:{chain_id}:{address}"))
}

/// Entity requires a J-prefix certificate on every frame once it is either
/// jurisdiction-registered or has ever certified a `jHistoryFinality` anchor.
pub fn entity_requires_j_prefix_certificate(
    jurisdiction: Option<&CanonicalValue>,
    j_history_finality: Option<&CanonicalValue>,
) -> bool {
    let registered = jurisdiction
        .map(|value| object_field(value, "registrationBlock").is_some())
        .unwrap_or(false);
    registered || j_history_finality.is_some()
}

/// Exact `buildCertifiedBaseClaim`: the only claim shape this native slice
/// builds. `state.jHistoryFinality` is committed by native J-event
/// finalization and restored verbatim from checkpoint/WAL.
fn build_certified_base_claim(
    state: &EntityStateSlice,
    jurisdiction: Option<&CanonicalValue>,
) -> Result<JPrefixClaim, JPrefixError> {
    let finality = state
        .j_history_finality
        .as_ref()
        .ok_or(JPrefixError::HistoryFinalityMissing)?;
    let finalized_through = field_u64(finality, "finalizedThroughHeight").ok_or(
        JPrefixError::HistoryFinalityInvalid("finalizedThroughHeight"),
    )?;
    if finalized_through != state.last_finalized_j_height {
        return Err(JPrefixError::HistoryFinalityHeightMismatch {
            finality: finalized_through,
            last_finalized: state.last_finalized_j_height,
        });
    }
    let expected_ref = jurisdiction_ref(jurisdiction)?;
    let finality_ref =
        field_string(finality, "jurisdictionRef").ok_or(JPrefixError::JurisdictionMissing)?;
    if finality_ref != expected_ref {
        return Err(JPrefixError::JurisdictionMismatch);
    }
    let tip_block_hash = field_string(finality, "tipBlockHash")
        .ok_or(JPrefixError::HistoryFinalityInvalid("tipBlockHash"))?;
    if !is_hex32(&tip_block_hash) {
        return Err(JPrefixError::HistoryFinalityInvalid("tipBlockHash"));
    }
    let event_history_root = field_string(finality, "eventHistoryRoot")
        .ok_or(JPrefixError::HistoryFinalityInvalid("eventHistoryRoot"))?;
    if !is_hex32(&event_history_root) {
        return Err(JPrefixError::HistoryFinalityInvalid("eventHistoryRoot"));
    }
    let empty_blocks: &[CanonicalJEventBlock] = &[];
    let range_hash = hex32(
        &canonical_j_event_range_hash(empty_blocks)
            .map_err(|error| JPrefixError::Encoding(error.to_string()))?,
    );
    Ok(JPrefixClaim {
        jurisdiction_ref: expected_ref,
        base_height: finalized_through,
        scanned_through_height: finalized_through,
        tip_block_hash,
        event_history_root,
        range_hash,
        blocks: Vec::new(),
    })
}

fn validate_range_claim(
    state: &EntityStateSlice,
    jurisdiction: Option<&CanonicalValue>,
    range: &JPrefixRangeClaim,
) -> Result<JPrefixClaim, JPrefixError> {
    let expected_ref = jurisdiction_ref(jurisdiction)?;
    if range.jurisdiction_ref.trim().to_lowercase() != expected_ref {
        return Err(JPrefixError::JurisdictionMismatch);
    }
    if range.base_height != state.last_finalized_j_height
        || range.scanned_through_height <= range.base_height
    {
        return Err(JPrefixError::HistoryFinalityHeightMismatch {
            finality: range.base_height,
            last_finalized: state.last_finalized_j_height,
        });
    }
    if !is_hex32(&range.tip_block_hash)
        || !is_hex32(&range.event_history_root)
        || !is_hex32(&range.range_hash)
    {
        return Err(JPrefixError::HistoryFinalityInvalid("RANGE_HASH"));
    }
    let expected_headers = range.scanned_through_height - range.base_height;
    if u64::try_from(range.headers.len()).ok() != Some(expected_headers) {
        return Err(JPrefixError::HistoryFinalityInvalid("RANGE_HEADERS"));
    }
    Ok(JPrefixClaim {
        jurisdiction_ref: expected_ref,
        base_height: range.base_height,
        scanned_through_height: range.scanned_through_height,
        tip_block_hash: range.tip_block_hash.clone(),
        event_history_root: range.event_history_root.clone(),
        range_hash: range.range_hash.clone(),
        blocks: range.blocks.clone(),
    })
}

fn current_parent_frame_hash(height: u64, parent_frame_hash: &str) -> String {
    if height == 0 {
        "genesis".into()
    } else {
        parent_frame_hash.trim().to_lowercase()
    }
}

/// Build and sign the exact local single-signer attestation, then wrap it as
/// a quorum-of-one `JPrefixCertificate` and return its canonical projection
/// for the Entity frame header. `None` means this frame legitimately carries
/// no certificate (not registered / no finality anchor yet), matching TS.
///
/// `target_entity_height`/`parent_frame_hash` are the post-transition
/// height/parent — exactly `state.height + 1`/`currentParentFrameHash(state)`
/// evaluated against the *pre*-transition replica in TS.
#[allow(clippy::too_many_arguments)]
pub fn build_required_j_prefix_certificate(
    signer: &EntitySingleSigner,
    authority: &EntityFrameAuthority,
    post_state: &EntityStateSlice,
    target_entity_height: u64,
    prior_certified_frame_hash: &str,
    range: Option<&JPrefixRangeClaim>,
) -> Result<Option<CanonicalValue>, JPrefixError> {
    let jurisdiction = authority.config.jurisdiction.as_ref();
    if !entity_requires_j_prefix_certificate(jurisdiction, post_state.j_history_finality.as_ref())
        && range.is_none()
    {
        return Ok(None);
    }
    if !authority.is_single_signer()? {
        return Err(JPrefixError::MultiValidatorUnsupported);
    }
    let claim = match range {
        Some(range) => validate_range_claim(post_state, jurisdiction, range)?,
        None => build_certified_base_claim(post_state, jurisdiction)?,
    };
    let headers = range.map_or_else(Vec::new, |range| range.headers.clone());
    let parent_frame_hash =
        current_parent_frame_hash(target_entity_height - 1, prior_certified_frame_hash);
    let validator_id = signer.signer_id().trim().to_lowercase();
    let unsigned = JPrefixAttestation {
        entity_id: post_state.entity_id.trim().to_lowercase(),
        target_entity_height,
        parent_frame_hash: parent_frame_hash.clone(),
        validator_id: validator_id.clone(),
        claim: claim.clone(),
        headers,
        signature: String::new(),
    };
    let digest = hash_attestation(&unsigned)?;
    let signature = signer
        .sign_raw_digest(&digest)
        .ok_or(JPrefixError::SigningFailed)?;
    let attestation = JPrefixAttestation {
        signature: hex65(&signature),
        ..unsigned
    };
    let mut attestations = BTreeMap::new();
    attestations.insert(
        validator_id.clone(),
        attestation_full_canonical(&attestation)?,
    );
    let certificate = CanonicalValue::Object(vec![
        ("version".into(), number(J_PREFIX_VERSION)?),
        (
            "entityId".into(),
            CanonicalValue::String(post_state.entity_id.trim().to_lowercase()),
        ),
        ("targetEntityHeight".into(), number(target_entity_height)?),
        (
            "parentFrameHash".into(),
            CanonicalValue::String(parent_frame_hash),
        ),
        (
            "jurisdictionRef".into(),
            CanonicalValue::String(claim.jurisdiction_ref.clone()),
        ),
        ("baseHeight".into(), number(claim.base_height)?),
        ("selected".into(), claim_canonical(&claim)?),
        (
            "attestations".into(),
            CanonicalValue::Map(
                attestations
                    .into_iter()
                    .map(|(signer_id, value)| (CanonicalValue::String(signer_id), value))
                    .collect(),
            ),
        ),
    ]);
    Ok(Some(certificate))
}

fn hex65(signature: &[u8; 65]) -> String {
    let mut output = String::with_capacity(132);
    output.push_str("0x");
    for byte in signature {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

/// Sign the exact TS `buildJEventRangeDigest` preimage without exposing the
/// Entity private key or a generic raw-digest signing API across crates.
#[allow(clippy::too_many_arguments)]
pub fn sign_j_event_range(
    signer: &EntitySingleSigner,
    entity_id: &str,
    jurisdiction_ref: &str,
    base_height: u64,
    scanned_through_height: u64,
    tip_block_hash: &[u8; 32],
    event_history_root: &[u8; 32],
    range_hash: &[u8; 32],
) -> Result<String, JPrefixError> {
    let digest = j_event_range_digest(
        entity_id,
        jurisdiction_ref,
        signer.signer_id(),
        base_height,
        scanned_through_height,
        tip_block_hash,
        event_history_root,
        range_hash,
    )
    .map_err(|error| JPrefixError::Encoding(error.to_string()))?;
    signer
        .sign_raw_digest(&digest)
        .map(|signature| hex65(&signature))
        .ok_or(JPrefixError::SigningFailed)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use xln_rscore_engine::BoardDelays;

    use super::super::authority::{ConsensusMode, EntityConsensusConfig, EntityLeaderState};
    use super::*;

    fn state_with_finality() -> EntityStateSlice {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 1_000);
        state.height = 30;
        state.last_finalized_j_height = 35;
        state.j_history_finality = Some(CanonicalValue::Object(vec![
            ("finalizedThroughHeight".into(), number(35).expect("n")),
            (
                "jurisdictionRef".into(),
                CanonicalValue::String(
                    "stack:31337:0xa513e6e4b8f2a923d98304ec87f64353c4d5c853".into(),
                ),
            ),
            (
                "tipBlockHash".into(),
                CanonicalValue::String(format!("0x{}", "22".repeat(32))),
            ),
            (
                "eventHistoryRoot".into(),
                CanonicalValue::String(format!("0x{}", "33".repeat(32))),
            ),
        ]));
        state
    }

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["h1-hub".into()],
                shares: BTreeMap::from([("h1-hub".into(), 1)]),
                jurisdiction: Some(CanonicalValue::Object(vec![
                    ("chainId".into(), number(31337).expect("n")),
                    (
                        "depositoryAddress".into(),
                        CanonicalValue::String("0xa513e6e4b8f2a923d98304ec87f64353c4d5c853".into()),
                    ),
                ])),
            },
            leader_state: EntityLeaderState {
                active_validator_id: "h1-hub".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn signer() -> EntitySingleSigner {
        let key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key hex")
                .try_into()
                .expect("key bytes");
        EntitySingleSigner::from_key(
            key,
            "h1-hub",
            &format!("0x{}", "11".repeat(32)),
            1,
            1,
            BoardDelays::default(),
        )
        .expect("signer")
    }

    #[test]
    fn base_claim_certificate_is_exact_and_restart_deterministic() {
        let state = state_with_finality();
        let authority = authority();
        let signer = signer();
        let first =
            build_required_j_prefix_certificate(&signer, &authority, &state, 31, "genesis", None)
                .expect("certificate")
                .expect("non-empty");
        let second =
            build_required_j_prefix_certificate(&signer, &authority, &state, 31, "genesis", None)
                .expect("certificate")
                .expect("non-empty");
        assert_eq!(
            first, second,
            "rebuilding after a simulated restart must be byte-identical"
        );
        let CanonicalValue::Object(fields) = &first else {
            panic!("certificate must be an object");
        };
        let get = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v);
        assert_eq!(get("baseHeight"), Some(&number(35).expect("n")));
        assert_eq!(get("targetEntityHeight"), Some(&number(31).expect("n")));
        let Some(CanonicalValue::Map(attestations)) = get("attestations") else {
            panic!("attestations must be a map");
        };
        assert_eq!(attestations.len(), 1);
    }

    #[test]
    fn no_finality_and_unregistered_jurisdiction_stays_none() {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 1_000);
        state.height = 0;
        let authority = EntityFrameAuthority {
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
        };
        let signer = signer();
        let certificate =
            build_required_j_prefix_certificate(&signer, &authority, &state, 1, "genesis", None)
                .expect("no error");
        assert_eq!(certificate, None);
    }

    #[test]
    fn semantic_range_is_certified_on_demand_before_registration_finality() {
        let mut state = state_with_finality();
        state.last_finalized_j_height = 0;
        state.j_history_finality = None;
        let range = JPrefixRangeClaim {
            jurisdiction_ref: "stack:31337:0xa513e6e4b8f2a923d98304ec87f64353c4d5c853".into(),
            base_height: 0,
            scanned_through_height: 1,
            tip_block_hash: format!("0x{}", "44".repeat(32)),
            event_history_root: format!("0x{}", "55".repeat(32)),
            range_hash: format!("0x{}", "66".repeat(32)),
            headers: vec![CanonicalValue::Object(vec![
                ("jHeight".into(), number(1).expect("height")),
                (
                    "jBlockHash".into(),
                    CanonicalValue::String(format!("0x{}", "44".repeat(32))),
                ),
            ])],
            blocks: Vec::new(),
        };
        let certificate = build_required_j_prefix_certificate(
            &signer(),
            &authority(),
            &state,
            1,
            "genesis",
            Some(&range),
        )
        .expect("on-demand certificate")
        .expect("semantic range requires a certificate");
        assert_eq!(
            object_field(&certificate, "baseHeight").and_then(|value| match value {
                CanonicalValue::Number(value) => value.as_str().parse::<u64>().ok(),
                _ => None,
            }),
            Some(0),
        );
    }

    #[test]
    fn multi_validator_authority_fails_loudly_instead_of_guessing() {
        let state = state_with_finality();
        let mut authority = authority();
        authority.config.validators.push("h1-hub-2".into());
        authority.config.shares.insert("h1-hub-2".into(), 1);
        authority.config.threshold = 2;
        let signer = signer();
        let result =
            build_required_j_prefix_certificate(&signer, &authority, &state, 31, "genesis", None);
        assert_eq!(result, Err(JPrefixError::MultiValidatorUnsupported));
    }

    #[test]
    fn pending_local_event_certifies_the_exact_supplied_range() {
        let state = state_with_finality();
        let authority = authority();
        let signer = signer();
        let range = JPrefixRangeClaim {
            jurisdiction_ref: "stack:31337:0xa513e6e4b8f2a923d98304ec87f64353c4d5c853".into(),
            base_height: 35,
            scanned_through_height: 36,
            tip_block_hash: format!("0x{}", "44".repeat(32)),
            event_history_root: format!("0x{}", "55".repeat(32)),
            range_hash: format!("0x{}", "66".repeat(32)),
            headers: vec![CanonicalValue::Object(vec![
                ("jHeight".into(), number(36).expect("height")),
                (
                    "jBlockHash".into(),
                    CanonicalValue::String(format!("0x{}", "44".repeat(32))),
                ),
            ])],
            blocks: Vec::new(),
        };
        let result = build_required_j_prefix_certificate(
            &signer,
            &authority,
            &state,
            31,
            "genesis",
            Some(&range),
        )
        .expect("certificate")
        .expect("required");
        assert_eq!(
            object_field(&result, "selected")
                .and_then(|value| field_u64(value, "scannedThroughHeight")),
            Some(36)
        );
    }
}
