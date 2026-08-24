//! Hanko envelope encode/decode and signature packing.
//!
//! Parity target: core/hanko/codec.ts, including the resource limits the
//! jurisdiction's verifier enforces — off-chain consensus must reject a proof
//! the chain could never verify.

use xln_rscore_crypto::recover_signer_address;

use crate::abi::{AbiClaim, AbiEnvelope, Word, decode_hanko_abi, encode_hanko_abi};
use crate::{HankoError, HankoResult};

/// Exact HankoVerifier.sol resource limits.
pub const HANKO_MAX_BYTES: usize = 64 * 1024;
const HANKO_MAX_ENTITIES: usize = 256;
const HANKO_MAX_CLAIMS: usize = 64;
const HANKO_MAX_MEMBERS_PER_CLAIM: usize = 256;
const HANKO_MAX_TOTAL_MEMBERS: usize = 1024;
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// The wire claim, unchanged from the ABI shape: canonical form is proven by
/// re-encoding, so nothing is normalised on the way in.
pub type WireClaim = AbiClaim;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HankoEnvelope {
    pub placeholders: Vec<Word>,
    pub packed_signatures: Vec<u8>,
    pub claims: Vec<WireClaim>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredSignature {
    /// The signer address, left-padded into an entity id.
    pub signer_entity_id: Word,
    pub signature: [u8; 65],
}

/// How many 65-byte signatures a packed blob holds: 64 bytes each plus one
/// recovery bit, rejecting any length that is not exactly that.
pub fn signature_count(byte_length: usize) -> HankoResult<usize> {
    if byte_length == 0 {
        return Ok(0);
    }
    let candidate = byte_length * 8 / 513;
    let expected = candidate * 64 + candidate.div_ceil(8);
    if candidate == 0 || expected != byte_length {
        return Err(HankoError::Invalid("HANKO_PACKED_SIGNATURE_LENGTH_INVALID"));
    }
    Ok(candidate)
}

fn assert_contract_hanko_shape(envelope: &HankoEnvelope) -> HankoResult<()> {
    let signatures = signature_count(envelope.packed_signatures.len())?;
    let total_entities = envelope.placeholders.len() + signatures + envelope.claims.len();
    if envelope.claims.len() > HANKO_MAX_CLAIMS
        || total_entities > HANKO_MAX_ENTITIES
        || envelope.placeholders.len() > HANKO_MAX_ENTITIES
        || signatures > HANKO_MAX_ENTITIES
    {
        return Err(HankoError::Invalid("HANKO_PROOF_TOO_LARGE"));
    }
    let mut total_members = 0;
    for claim in &envelope.claims {
        let members = claim.entity_indexes.len();
        if members == 0 || members != claim.weights.len() || members > HANKO_MAX_MEMBERS_PER_CLAIM {
            return Err(HankoError::Invalid("HANKO_CLAIM_SHAPE_INVALID"));
        }
        total_members += members;
        if total_members > HANKO_MAX_TOTAL_MEMBERS {
            return Err(HankoError::Invalid("HANKO_PROOF_TOO_LARGE"));
        }
    }
    Ok(())
}

pub fn encode_hanko_envelope(envelope: &HankoEnvelope) -> HankoResult<Vec<u8>> {
    assert_contract_hanko_shape(envelope)?;
    let encoded = encode_hanko_abi(&AbiEnvelope {
        placeholders: envelope.placeholders.clone(),
        packed_signatures: envelope.packed_signatures.clone(),
        claims: envelope.claims.clone(),
    });
    if encoded.len() > HANKO_MAX_BYTES {
        return Err(HankoError::Invalid("HANKO_PROOF_TOO_LARGE"));
    }
    Ok(encoded)
}

pub fn decode_hanko_envelope(encoded: &[u8]) -> HankoResult<HankoEnvelope> {
    if encoded.len() > HANKO_MAX_BYTES {
        return Err(HankoError::Invalid("HANKO_PROOF_TOO_LARGE"));
    }
    let decoded = decode_hanko_abi(encoded)?;
    let envelope = HankoEnvelope {
        placeholders: decoded.placeholders,
        packed_signatures: decoded.packed_signatures,
        claims: decoded.claims,
    };
    assert_contract_hanko_shape(&envelope)?;
    if encode_hanko_envelope(&envelope)? != encoded {
        return Err(HankoError::Invalid("HANKO_ABI_NON_CANONICAL"));
    }
    Ok(envelope)
}

fn assert_canonical_signature(signature: &[u8; 65]) -> HankoResult<()> {
    if signature[64] != 27 && signature[64] != 28 {
        return Err(HankoError::Invalid("HANKO_SIGNATURE_RECOVERY_INVALID"));
    }
    let zero_r = signature[..32].iter().all(|byte| *byte == 0);
    let zero_s = signature[32..64].iter().all(|byte| *byte == 0);
    if zero_r || zero_s || signature[32..64] > SECP256K1_HALF_ORDER[..] {
        return Err(HankoError::Invalid("HANKO_SIGNATURE_NON_CANONICAL"));
    }
    Ok(())
}

pub fn pack_hanko_signatures(signatures: &[[u8; 65]]) -> HankoResult<Vec<u8>> {
    if signatures.is_empty() {
        return Ok(Vec::new());
    }
    for signature in signatures {
        assert_canonical_signature(signature)?;
    }
    let recovery_bytes = signatures.len().div_ceil(8);
    let mut packed = vec![0_u8; signatures.len() * 64 + recovery_bytes];
    for (index, signature) in signatures.iter().enumerate() {
        packed[index * 64..index * 64 + 64].copy_from_slice(&signature[..64]);
        if signature[64] == 28 {
            packed[signatures.len() * 64 + index / 8] |= 1 << (index % 8);
        }
    }
    Ok(packed)
}

pub fn unpack_hanko_signatures(packed: &[u8]) -> HankoResult<Vec<[u8; 65]>> {
    let count = signature_count(packed.len())?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let recovery_offset = count * 64;
    let used_bits = count % 8;
    if used_bits != 0 {
        let last = packed[packed.len() - 1];
        if last >> used_bits != 0 {
            return Err(HankoError::Invalid(
                "HANKO_PACKED_SIGNATURE_PADDING_INVALID",
            ));
        }
    }
    let mut signatures = Vec::with_capacity(count);
    for index in 0..count {
        let mut signature = [0_u8; 65];
        signature[..64].copy_from_slice(&packed[index * 64..index * 64 + 64]);
        let bit = packed[recovery_offset + index / 8] >> (index % 8) & 1;
        signature[64] = 27 + bit;
        assert_canonical_signature(&signature)?;
        signatures.push(signature);
    }
    Ok(signatures)
}

/// Recover every packed signature over `digest`. Duplicate signers and
/// unrecoverable signatures are rejections, not surprises: the same rules the
/// jurisdiction applies.
pub fn recover_hanko_signatures(
    digest: &[u8; 32],
    packed: &[u8],
) -> HankoResult<Vec<RecoveredSignature>> {
    let signatures = unpack_hanko_signatures(packed)?;
    let mut recovered = Vec::with_capacity(signatures.len());
    let mut seen = Vec::with_capacity(signatures.len());
    for signature in signatures {
        let address = recover_signer_address(digest, &signature)
            .ok_or(HankoError::Invalid("HANKO_SIGNATURE_UNRECOVERABLE"))?;
        let mut signer_entity_id = [0_u8; 32];
        signer_entity_id[12..].copy_from_slice(&address);
        if seen.contains(&signer_entity_id) {
            return Err(HankoError::Invalid("HANKO_DUPLICATE_SIGNER"));
        }
        seen.push(signer_entity_id);
        recovered.push(RecoveredSignature {
            signer_entity_id,
            signature,
        });
    }
    Ok(recovered)
}
