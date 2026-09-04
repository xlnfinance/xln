//! Direct ABI codec for the Hanko envelope tuple
//! `tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])`
//! (HankoVerifier.HankoBytes: placeholders, packedSignatures, claims,
//! memberSignatures).
//!
//! Parity target: core/hanko/abi.ts. Byte-identical to what `AbiCoder` writes
//! for that type. Decoding is bounds-checked and, like TypeScript, lenient
//! about trailing bytes and oversized fixed-width integers — the caller
//! rejects every non-canonical layout by re-encoding.

use crate::HankoError;

pub type Word = [u8; 32];

const WORD: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbiClaim {
    pub entity_id: Word,
    pub entity_indexes: Vec<Word>,
    pub weights: Vec<Word>,
    pub threshold: Word,
    pub board_change_delay: u32,
    pub control_change_delay: u32,
    pub dividend_change_delay: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbiEnvelope {
    pub placeholders: Vec<Word>,
    pub packed_signatures: Vec<u8>,
    pub claims: Vec<AbiClaim>,
    /// Aligned with `placeholders` (or empty): an ERC-1271 proof for the
    /// placeholder at the same index. Only the jurisdiction can evaluate one.
    pub member_signatures: Vec<Vec<u8>>,
}

pub fn word_from_usize(value: usize) -> Word {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&(value as u64).to_be_bytes());
    word
}

fn word_from_u32(value: u32) -> Word {
    let mut word = [0_u8; 32];
    word[28..].copy_from_slice(&value.to_be_bytes());
    word
}

fn encode_claim(claim: &AbiClaim, output: &mut Vec<u8>) {
    let indexes_offset = 7 * WORD;
    let weights_offset = indexes_offset + WORD * (1 + claim.entity_indexes.len());
    output.extend_from_slice(&claim.entity_id);
    output.extend_from_slice(&word_from_usize(indexes_offset));
    output.extend_from_slice(&word_from_usize(weights_offset));
    output.extend_from_slice(&claim.threshold);
    output.extend_from_slice(&word_from_u32(claim.board_change_delay));
    output.extend_from_slice(&word_from_u32(claim.control_change_delay));
    output.extend_from_slice(&word_from_u32(claim.dividend_change_delay));
    for values in [&claim.entity_indexes, &claim.weights] {
        output.extend_from_slice(&word_from_usize(values.len()));
        for value in values {
            output.extend_from_slice(value);
        }
    }
}

/// ABI `bytes`: length word + payload right-padded to a word boundary.
fn encode_bytes(value: &[u8], output: &mut Vec<u8>) {
    let padding = (WORD - value.len() % WORD) % WORD;
    output.extend_from_slice(&word_from_usize(value.len()));
    output.extend_from_slice(value);
    output.resize(output.len() + padding, 0);
}

/// ABI `bytes[]`: length word, one offset word per item, then each `bytes`.
fn encode_bytes_array(values: &[Vec<u8>]) -> Vec<u8> {
    let mut heads = Vec::with_capacity(WORD * values.len());
    let mut tails = Vec::new();
    let mut offset = WORD * values.len();
    for value in values {
        heads.extend_from_slice(&word_from_usize(offset));
        let before = tails.len();
        encode_bytes(value, &mut tails);
        offset += tails.len() - before;
    }
    let mut output = Vec::with_capacity(WORD + heads.len() + tails.len());
    output.extend_from_slice(&word_from_usize(values.len()));
    output.extend_from_slice(&heads);
    output.extend_from_slice(&tails);
    output
}

pub fn encode_hanko_abi(envelope: &AbiEnvelope) -> Vec<u8> {
    let mut placeholders = Vec::with_capacity(WORD * (1 + envelope.placeholders.len()));
    placeholders.extend_from_slice(&word_from_usize(envelope.placeholders.len()));
    for placeholder in &envelope.placeholders {
        placeholders.extend_from_slice(placeholder);
    }

    let mut packed = Vec::with_capacity(2 * WORD + envelope.packed_signatures.len());
    encode_bytes(&envelope.packed_signatures, &mut packed);

    let mut heads = Vec::with_capacity(WORD * envelope.claims.len());
    let mut tails = Vec::new();
    let mut claim_offset = WORD * envelope.claims.len();
    for claim in &envelope.claims {
        heads.extend_from_slice(&word_from_usize(claim_offset));
        let before = tails.len();
        encode_claim(claim, &mut tails);
        claim_offset += tails.len() - before;
    }
    let mut claims = Vec::with_capacity(WORD + heads.len() + tails.len());
    claims.extend_from_slice(&word_from_usize(envelope.claims.len()));
    claims.extend_from_slice(&heads);
    claims.extend_from_slice(&tails);

    let members = encode_bytes_array(&envelope.member_signatures);

    let placeholders_offset = 4 * WORD;
    let packed_offset = placeholders_offset + placeholders.len();
    let claims_offset = packed_offset + packed.len();
    let members_offset = claims_offset + claims.len();
    let mut output = Vec::with_capacity(
        5 * WORD + placeholders.len() + packed.len() + claims.len() + members.len(),
    );
    output.extend_from_slice(&word_from_usize(WORD));
    output.extend_from_slice(&word_from_usize(placeholders_offset));
    output.extend_from_slice(&word_from_usize(packed_offset));
    output.extend_from_slice(&word_from_usize(claims_offset));
    output.extend_from_slice(&word_from_usize(members_offset));
    output.extend_from_slice(&placeholders);
    output.extend_from_slice(&packed);
    output.extend_from_slice(&claims);
    output.extend_from_slice(&members);
    output
}

struct AbiReader<'a> {
    bytes: &'a [u8],
}

impl<'a> AbiReader<'a> {
    fn word(&self, offset: usize) -> Result<Word, HankoError> {
        let end = offset
            .checked_add(WORD)
            .ok_or(HankoError::AbiOutOfBounds(offset))?;
        if end > self.bytes.len() {
            return Err(HankoError::AbiOutOfBounds(offset));
        }
        let mut word = [0_u8; 32];
        word.copy_from_slice(&self.bytes[offset..end]);
        Ok(word)
    }

    /// A length or offset. Anything past the buffer is invalid, which also
    /// keeps every later addition inside `usize`.
    fn size(&self, offset: usize) -> Result<usize, HankoError> {
        let word = self.word(offset)?;
        if word[..24].iter().any(|byte| *byte != 0) {
            return Err(HankoError::AbiSizeInvalid(offset));
        }
        let value = u64::from_be_bytes(word[24..].try_into().expect("8 bytes")) as usize;
        if value > self.bytes.len() {
            return Err(HankoError::AbiSizeInvalid(offset));
        }
        Ok(value)
    }

    fn word_array(&self, offset: usize) -> Result<Vec<Word>, HankoError> {
        let length = self.size(offset)?;
        let mut values = Vec::with_capacity(length);
        for index in 0..length {
            values.push(self.word(offset + WORD * (1 + index))?);
        }
        Ok(values)
    }

    /// AbiCoder masks fixed-width integers to their size; the canonical
    /// re-encode rejects the excess.
    fn uint32(&self, offset: usize) -> Result<u32, HankoError> {
        let word = self.word(offset)?;
        Ok(u32::from_be_bytes(word[28..].try_into().expect("4 bytes")))
    }

    fn bytes(&self, offset: usize) -> Result<Vec<u8>, HankoError> {
        let length = self.size(offset)?;
        let start = offset + WORD;
        let end = start
            .checked_add(length)
            .ok_or(HankoError::AbiOutOfBounds(offset))?;
        if end > self.bytes.len() {
            return Err(HankoError::AbiOutOfBounds(offset));
        }
        Ok(self.bytes[start..end].to_vec())
    }
}

pub fn decode_hanko_abi(encoded: &[u8]) -> Result<AbiEnvelope, HankoError> {
    let reader = AbiReader { bytes: encoded };
    let tuple = reader.size(0)?;
    let placeholders_at = tuple + reader.size(tuple)?;
    let packed_at = tuple + reader.size(tuple + WORD)?;
    let claims_at = tuple + reader.size(tuple + 2 * WORD)?;
    let members_at = tuple + reader.size(tuple + 3 * WORD)?;

    let placeholders = reader.word_array(placeholders_at)?;
    let packed_signatures = reader.bytes(packed_at)?;

    let claim_count = reader.size(claims_at)?;
    let claims_base = claims_at + WORD;
    let mut claims = Vec::with_capacity(claim_count);
    for index in 0..claim_count {
        let claim_at = claims_base + reader.size(claims_base + WORD * index)?;
        let indexes_at = claim_at + reader.size(claim_at + WORD)?;
        let weights_at = claim_at + reader.size(claim_at + 2 * WORD)?;
        claims.push(AbiClaim {
            entity_id: reader.word(claim_at)?,
            entity_indexes: reader.word_array(indexes_at)?,
            weights: reader.word_array(weights_at)?,
            threshold: reader.word(claim_at + 3 * WORD)?,
            board_change_delay: reader.uint32(claim_at + 4 * WORD)?,
            control_change_delay: reader.uint32(claim_at + 5 * WORD)?,
            dividend_change_delay: reader.uint32(claim_at + 6 * WORD)?,
        });
    }

    let member_count = reader.size(members_at)?;
    let members_base = members_at + WORD;
    let mut member_signatures = Vec::with_capacity(member_count);
    for index in 0..member_count {
        let at = members_base + reader.size(members_base + WORD * index)?;
        member_signatures.push(reader.bytes(at)?);
    }
    Ok(AbiEnvelope {
        placeholders,
        packed_signatures,
        claims,
        member_signatures,
    })
}
