//! 65-byte Hanko shortcut (HankoVerifier.verify).
//!
//! Parity target: core/hanko/short.ts. A raw `r||s||v` signature is the Hanko
//! of the signer's own lazy 1-of-1 entity:
//! `id = keccak256(abi.encode(Board{1,[bytes32(addr)],[1],0,0,0}))`. The chain
//! accepts it wherever a Hanko is accepted. Off-chain consensus keeps
//! exchanging full envelopes (one wire shape per proof); the shortcut applies
//! at the jurisdiction submission boundary only.

use xln_rscore_crypto::recover_signer_address;

use crate::abi::Word;
use crate::claims::{BoardDelays, BoardMember, lazy_entity_id};
use crate::codec::{decode_hanko_envelope, recover_hanko_signatures, unpack_hanko_signatures};
use crate::{HankoError, HankoResult};

pub const SHORT_HANKO_BYTES: usize = 65;

pub fn is_short_hanko(hanko: &[u8]) -> bool {
    hanko.len() == SHORT_HANKO_BYTES
}

/// Lazy entity id of an EOA: keccak256 of its canonical 1-of-1 board (delays 0).
pub fn lazy_single_signer_entity_id(signer: &[u8; 20]) -> Word {
    let mut member = [0_u8; 32];
    member[12..].copy_from_slice(signer);
    lazy_entity_id(
        &[BoardMember {
            entity_id: member,
            weight: 1,
        }],
        1,
        BoardDelays::default(),
    )
}

fn normalize_recovery(signature: &[u8]) -> HankoResult<[u8; 65]> {
    let mut raw: [u8; 65] = signature
        .try_into()
        .map_err(|_| HankoError::Invalid("SHORT_HANKO_LENGTH_INVALID"))?;
    if raw[64] < 27 {
        raw[64] += 27;
    }
    Ok(raw)
}

/// Entity id the chain derives from a 65-byte Hanko over `digest`.
pub fn recover_short_hanko_entity_id(hanko: &[u8], digest: &[u8; 32]) -> HankoResult<Word> {
    let raw = normalize_recovery(hanko)?;
    if raw[64] != 27 && raw[64] != 28 {
        return Err(HankoError::Invalid("SHORT_HANKO_RECOVERY_FAILED"));
    }
    let signer = recover_signer_address(digest, &raw)
        .ok_or(HankoError::Invalid("SHORT_HANKO_RECOVERY_FAILED"))?;
    Ok(lazy_single_signer_entity_id(&signer))
}

/// Compact a full envelope to the 65-byte form when, and only when, it is one
/// EOA signature claiming that signer's own lazy entity. Every other proof
/// (placeholders, member signatures, quorum boards, registered entities,
/// nested claims, non-zero board delays) is returned unchanged.
pub fn compact_hanko_for_chain(hanko: &[u8], digest: &[u8; 32]) -> HankoResult<Vec<u8>> {
    if is_short_hanko(hanko) {
        return Ok(hanko.to_vec());
    }
    let envelope = decode_hanko_envelope(hanko)?;
    if !envelope.placeholders.is_empty()
        || !envelope.member_signatures.is_empty()
        || envelope.claims.len() != 1
    {
        return Ok(hanko.to_vec());
    }
    let claim = &envelope.claims[0];
    let one = {
        let mut word = [0_u8; 32];
        word[31] = 1;
        word
    };
    if claim.entity_indexes.len() != 1
        || claim.entity_indexes[0] != [0_u8; 32]
        || claim.weights.len() != 1
        || claim.weights[0] != one
        || claim.threshold != one
        || claim.board_change_delay != 0
        || claim.control_change_delay != 0
        || claim.dividend_change_delay != 0
    {
        return Ok(hanko.to_vec());
    }
    let signatures = unpack_hanko_signatures(&envelope.packed_signatures)?;
    if signatures.len() != 1 {
        return Ok(hanko.to_vec());
    }
    let recovered = recover_hanko_signatures(digest, &envelope.packed_signatures)?;
    let Some(signer) = recovered.first() else {
        return Ok(hanko.to_vec());
    };
    let mut address = [0_u8; 20];
    address.copy_from_slice(&signer.signer_entity_id[12..]);
    if lazy_single_signer_entity_id(&address) != claim.entity_id {
        return Ok(hanko.to_vec());
    }
    Ok(signatures[0].to_vec())
}

/// Target entity id of a chain-bound Hanko (short or full) without verifying it.
pub fn chain_hanko_target_entity_id(hanko: &[u8], digest: &[u8; 32]) -> HankoResult<Word> {
    if is_short_hanko(hanko) {
        return recover_short_hanko_entity_id(hanko, digest);
    }
    let envelope = decode_hanko_envelope(hanko)?;
    envelope
        .claims
        .last()
        .map(|claim| claim.entity_id)
        .ok_or(HankoError::Invalid("HANKO_CLAIM_REQUIRED"))
}
