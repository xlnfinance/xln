//! Claim resolution: who signed, with what weight, for which board.
//!
//! Parity target: core/hanko/claims.ts. A claim names its members by index
//! into placeholders, signatures and earlier claims; the reconstructed board
//! hash is what proves the claim speaks for its entity.

use sha3::{Digest, Keccak256};
use std::collections::HashSet;

use crate::abi::{Word, word_from_usize};
use crate::codec::{
    HankoEnvelope, RecoveredSignature, decode_hanko_envelope, recover_hanko_signatures,
};
use crate::{HankoError, HankoResult};

const MAX_BOARD_POWER: u128 = 0xffff;
const MAX_BOARD_DELAY: u64 = 0xffff_ffff;
const MAX_SAFE_INDEX: u128 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoardDelays {
    pub board_change_delay: u32,
    pub control_change_delay: u32,
    pub dividend_change_delay: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardMember {
    pub entity_id: Word,
    pub weight: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticClaim {
    pub entity_id: Word,
    pub members: Vec<BoardMember>,
    pub threshold: u128,
    pub delays: BoardDelays,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedClaim {
    pub semantic: SemanticClaim,
    pub board_hash: Word,
    pub voting_power: u128,
    referenced_claim_indexes: Vec<usize>,
    used_indexes: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedHanko {
    pub target_entity_id: Word,
    pub envelope: HankoEnvelope,
    pub signatures: Vec<RecoveredSignature>,
    pub claims: Vec<ResolvedClaim>,
}

/// Decides whether a claim may speak for its entity when the entity id is not
/// the board hash itself. TypeScript resolves this against certified board
/// records; the engine has no registry, so its caller passes what it knows.
pub type BoardAuthorityValidator<'a> = &'a dyn Fn(&Word, &Word, usize) -> bool;

fn word_to_u128(word: &Word) -> Option<u128> {
    if word[..16].iter().any(|byte| *byte != 0) {
        return None;
    }
    Some(u128::from_be_bytes(
        word[16..].try_into().expect("16 bytes"),
    ))
}

fn as_board_power(word: &Word) -> HankoResult<u128> {
    let value = word_to_u128(word).ok_or(HankoError::Invalid("HANKO_BOARD_POWER_INVALID"))?;
    if value == 0 || value > MAX_BOARD_POWER {
        return Err(HankoError::Invalid("HANKO_BOARD_POWER_INVALID"));
    }
    Ok(value)
}

fn is_address_entity_id(entity_id: &Word) -> bool {
    entity_id[..12].iter().all(|byte| *byte == 0) && entity_id[12..].iter().any(|byte| *byte != 0)
}

fn word_from_u128(value: u128) -> Word {
    let mut word = [0_u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// keccak of `abi.encode(tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32))`
/// over the claim's semantic content.
pub fn hash_hanko_board_claim(claim: &SemanticClaim) -> Word {
    let member_count = claim.members.len();
    let entities_offset = 6 * 32;
    let weights_offset = entities_offset + 32 * (1 + member_count);
    let mut encoded = Vec::with_capacity(32 * (7 + 2 * (1 + member_count)));
    encoded.extend_from_slice(&word_from_usize(32));
    encoded.extend_from_slice(&word_from_u128(claim.threshold));
    encoded.extend_from_slice(&word_from_usize(entities_offset));
    encoded.extend_from_slice(&word_from_usize(weights_offset));
    encoded.extend_from_slice(&word_from_usize(
        usize::try_from(claim.delays.board_change_delay).expect("u32"),
    ));
    encoded.extend_from_slice(&word_from_usize(
        usize::try_from(claim.delays.control_change_delay).expect("u32"),
    ));
    encoded.extend_from_slice(&word_from_usize(
        usize::try_from(claim.delays.dividend_change_delay).expect("u32"),
    ));
    encoded.extend_from_slice(&word_from_usize(member_count));
    for member in &claim.members {
        encoded.extend_from_slice(&member.entity_id);
    }
    encoded.extend_from_slice(&word_from_usize(member_count));
    for member in &claim.members {
        encoded.extend_from_slice(&word_from_u128(member.weight));
    }
    Keccak256::digest(&encoded).into()
}

/// The id of a lazy entity: the hash of the board it is defined by.
///
/// Parity target: `generateLazyEntityId` (core/entity/factory.ts), which
/// encodes and hashes the same board tuple. Such an entity's claims are
/// self-authorising — the engine can verify them without the registry.
pub fn lazy_entity_id(members: &[BoardMember], threshold: u128, delays: BoardDelays) -> Word {
    hash_hanko_board_claim(&SemanticClaim {
        entity_id: [0_u8; 32],
        members: members.to_vec(),
        threshold,
        delays,
    })
}

fn resolve_delays(claim: &crate::codec::WireClaim) -> HankoResult<BoardDelays> {
    for delay in [
        claim.board_change_delay,
        claim.control_change_delay,
        claim.dividend_change_delay,
    ] {
        if u64::from(delay) > MAX_BOARD_DELAY {
            return Err(HankoError::Invalid("HANKO_BOARD_DELAY_INVALID"));
        }
    }
    Ok(BoardDelays {
        board_change_delay: claim.board_change_delay,
        control_change_delay: claim.control_change_delay,
        dividend_change_delay: claim.dividend_change_delay,
    })
}

fn resolve_claim(
    envelope: &HankoEnvelope,
    signatures: &[RecoveredSignature],
    claim_index: usize,
) -> HankoResult<ResolvedClaim> {
    let claim = &envelope.claims[claim_index];
    if claim.entity_indexes.is_empty() || claim.entity_indexes.len() != claim.weights.len() {
        return Err(HankoError::Invalid("HANKO_CLAIM_SHAPE_INVALID"));
    }
    let threshold = as_board_power(&claim.threshold)?;
    let first_claim_index = envelope.placeholders.len() + signatures.len();
    let total_entities = first_claim_index + envelope.claims.len();
    let mut indexes = Vec::with_capacity(claim.entity_indexes.len());
    for word in &claim.entity_indexes {
        let value = word_to_u128(word).ok_or(HankoError::Invalid("HANKO_ENTITY_INDEX_OOB"))?;
        if value > MAX_SAFE_INDEX || value >= total_entities as u128 {
            return Err(HankoError::Invalid("HANKO_ENTITY_INDEX_OOB"));
        }
        indexes.push(value as usize);
    }
    let mut seen = HashSet::with_capacity(indexes.len());
    for index in &indexes {
        if !seen.insert(*index) {
            return Err(HankoError::Invalid("HANKO_DUPLICATE_ENTITY_INDEX"));
        }
    }

    let mut referenced = Vec::new();
    let mut voting_power = 0_u128;
    let mut members = Vec::with_capacity(indexes.len());
    for (member_index, entity_index) in indexes.iter().copied().enumerate() {
        let weight = as_board_power(&claim.weights[member_index])?;
        let entity_id = if entity_index < envelope.placeholders.len() {
            let placeholder = envelope.placeholders[entity_index];
            if envelope.claims[..claim_index]
                .iter()
                .any(|candidate| candidate.entity_id == placeholder)
            {
                return Err(HankoError::Invalid("HANKO_NON_CANONICAL_PLACEHOLDER"));
            }
            placeholder
        } else if entity_index < first_claim_index {
            voting_power += weight;
            signatures[entity_index - envelope.placeholders.len()].signer_entity_id
        } else {
            let nested_index = entity_index - first_claim_index;
            if nested_index >= claim_index {
                return Err(HankoError::Invalid("HANKO_CLAIM_ORDER_INVALID"));
            }
            referenced.push(nested_index);
            voting_power += weight;
            envelope.claims[nested_index].entity_id
        };
        if member_index == 0
            && (!is_address_entity_id(&entity_id) || entity_index >= first_claim_index)
        {
            return Err(HankoError::Invalid("HANKO_FIRST_MEMBER_EOA_REQUIRED"));
        }
        members.push(BoardMember { entity_id, weight });
    }
    let mut unique_members = HashSet::with_capacity(members.len());
    for member in &members {
        if !unique_members.insert(member.entity_id) {
            return Err(HankoError::Invalid("HANKO_DUPLICATE_BOARD_MEMBER"));
        }
    }
    let total_power: u128 = members.iter().map(|member| member.weight).sum();
    if threshold > total_power {
        return Err(HankoError::Invalid("HANKO_THRESHOLD_EXCEEDS_BOARD_POWER"));
    }
    let semantic = SemanticClaim {
        entity_id: claim.entity_id,
        members,
        threshold,
        delays: resolve_delays(claim)?,
    };
    let board_hash = hash_hanko_board_claim(&semantic);
    Ok(ResolvedClaim {
        semantic,
        board_hash,
        voting_power,
        referenced_claim_indexes: referenced,
        used_indexes: indexes,
    })
}

fn assert_minimal_reachability(
    envelope: &HankoEnvelope,
    signatures: &[RecoveredSignature],
    claims: &[ResolvedClaim],
) -> HankoResult<()> {
    let mut reachable = HashSet::from([claims.len() - 1]);
    for index in (0..claims.len()).rev() {
        if !reachable.contains(&index) {
            continue;
        }
        for child in &claims[index].referenced_claim_indexes {
            reachable.insert(*child);
        }
    }
    if reachable.len() != claims.len() {
        return Err(HankoError::Invalid("HANKO_UNUSED_CLAIM"));
    }
    let used: HashSet<usize> = claims
        .iter()
        .flat_map(|claim| claim.used_indexes.iter().copied())
        .collect();
    for index in 0..envelope.placeholders.len() {
        if !used.contains(&index) {
            return Err(HankoError::Invalid("HANKO_UNUSED_PLACEHOLDER"));
        }
    }
    for index in 0..signatures.len() {
        if !used.contains(&(envelope.placeholders.len() + index)) {
            return Err(HankoError::Invalid("HANKO_UNUSED_SIGNATURE"));
        }
    }
    Ok(())
}

fn assert_unique_words(values: impl Iterator<Item = Word>, error: &'static str) -> HankoResult<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(HankoError::Invalid(error));
        }
    }
    Ok(())
}

/// Verify a Hanko over one digest. `validate_board_authority` decides claims
/// whose entity id is not their own board hash; pass `None` to accept only
/// self-authorising claims, which is what the account engine can prove alone.
pub fn verify_canonical_hanko(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_target_entity_id: Option<&Word>,
    validate_board_authority: Option<BoardAuthorityValidator<'_>>,
) -> HankoResult<VerifiedHanko> {
    let envelope = decode_hanko_envelope(hanko)?;
    if envelope.claims.is_empty() {
        return Err(HankoError::Invalid("HANKO_CLAIM_REQUIRED"));
    }
    // ERC-1271 member proofs are contract state only the jurisdiction can
    // evaluate. Off-chain consensus grants no weight it cannot verify, so an
    // envelope relying on one is rejected here (the chain may still accept it).
    if envelope
        .member_signatures
        .iter()
        .any(|signature| !signature.is_empty())
    {
        return Err(HankoError::Invalid("HANKO_MEMBER_SIGNATURE_UNSUPPORTED"));
    }
    assert_unique_words(
        envelope.placeholders.iter().copied(),
        "HANKO_DUPLICATE_PLACEHOLDER",
    )?;
    assert_unique_words(
        envelope.claims.iter().map(|claim| claim.entity_id),
        "HANKO_DUPLICATE_CLAIM_ENTITY",
    )?;
    let signatures = recover_hanko_signatures(digest, &envelope.packed_signatures)?;
    if signatures.is_empty() {
        return Err(HankoError::Invalid("HANKO_EOA_SIGNATURE_REQUIRED"));
    }
    for placeholder in &envelope.placeholders {
        if signatures
            .iter()
            .any(|signature| signature.signer_entity_id == *placeholder)
        {
            return Err(HankoError::Invalid(
                "HANKO_NON_CANONICAL_PLACEHOLDER_SIGNER",
            ));
        }
    }
    let mut claims = Vec::with_capacity(envelope.claims.len());
    for index in 0..envelope.claims.len() {
        claims.push(resolve_claim(&envelope, &signatures, index)?);
    }
    for claim in &claims {
        if claim.voting_power < claim.semantic.threshold {
            return Err(HankoError::Invalid("HANKO_QUORUM_INSUFFICIENT"));
        }
    }
    assert_minimal_reachability(&envelope, &signatures, &claims)?;
    for (index, claim) in claims.iter().enumerate() {
        if claim.semantic.entity_id == claim.board_hash {
            continue;
        }
        let accepted = validate_board_authority
            .map(|validate| validate(&claim.semantic.entity_id, &claim.board_hash, index))
            .unwrap_or(false);
        if !accepted {
            return Err(HankoError::BoardAuthorityUnavailable);
        }
    }
    let target_entity_id = claims[claims.len() - 1].semantic.entity_id;
    if let Some(expected) = expected_target_entity_id
        && target_entity_id != *expected
    {
        return Err(HankoError::Invalid("HANKO_TARGET_MISMATCH"));
    }
    Ok(VerifiedHanko {
        target_entity_id,
        envelope,
        signatures,
        claims,
    })
}
