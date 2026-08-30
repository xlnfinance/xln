use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{
    DisputeFinalizationEvidence, JurisdictionEvent, canonical_dispute_finalization_evidence_hash,
    canonical_events, canonical_events_hash, normalize_dispute_finalization_evidence,
};

use crate::EntityKernelError;

use super::FinalizedJEventBatch;

const HISTORY_LEAF_DOMAIN_TEXT: &str = "xln:j-history-event-block:v1";
const HISTORY_FOLD_DOMAIN_TEXT: &str = "xln:j-history-fold:v1";
const HISTORY_RANGE_DOMAIN_TEXT: &str = "xln:j-history-range:v1";
const HISTORY_RANGE_BODY_DOMAIN_TEXT: &str = "xln:j-history-range-body:v1";

pub const EMPTY_J_HISTORY_ROOT: [u8; 32] = [
    0x11, 0xf1, 0x89, 0xb4, 0xdb, 0x64, 0x0a, 0x8b, 0xcb, 0xdf, 0x48, 0xda, 0x58, 0xbc, 0xa9, 0xfc,
    0x07, 0x64, 0xf0, 0x7c, 0x06, 0x88, 0x15, 0xd7, 0x3c, 0x69, 0x84, 0x57, 0xbb, 0xb0, 0x1e, 0xc2,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalJEventBlock {
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
    pub events_hash: [u8; 32],
    pub events: Vec<JurisdictionEvent>,
    pub dispute_finalization_evidence_hash: [u8; 32],
    pub dispute_finalization_evidence: Vec<DisputeFinalizationEvidence>,
}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::JEventInvalid {
        detail: detail.into(),
    }
}

fn word(value: u64) -> [u8; 32] {
    let mut output = [0_u8; 32];
    output[24..].copy_from_slice(&value.to_be_bytes());
    output
}

fn text_hash(value: &str) -> [u8; 32] {
    Keccak256::digest(value.trim().to_lowercase().as_bytes()).into()
}

fn keccak_words(words: &[[u8; 32]]) -> [u8; 32] {
    let mut digest = Keccak256::new();
    for value in words {
        digest.update(value);
    }
    digest.finalize().into()
}

fn dynamic_words(values: &[[u8; 32]]) -> Result<Vec<u8>, EntityKernelError> {
    let length = u64::try_from(values.len()).map_err(|_| invalid("J_RANGE_LENGTH"))?;
    let mut output = Vec::with_capacity((values.len() + 1) * 32);
    output.extend_from_slice(&word(length));
    for value in values {
        output.extend_from_slice(value);
    }
    Ok(output)
}

fn range_abi(
    heights: &[[u8; 32]],
    block_hashes: &[[u8; 32]],
    event_hashes: &[[u8; 32]],
    evidence_hashes: &[[u8; 32]],
) -> Result<Vec<u8>, EntityKernelError> {
    let tails = [
        dynamic_words(heights)?,
        dynamic_words(block_hashes)?,
        dynamic_words(event_hashes)?,
        dynamic_words(evidence_hashes)?,
    ];
    let mut output = Vec::new();
    output.extend_from_slice(&text_hash(HISTORY_RANGE_BODY_DOMAIN_TEXT));
    let mut offset = 5_u64 * 32;
    for tail in &tails {
        output.extend_from_slice(&word(offset));
        offset = offset
            .checked_add(u64::try_from(tail.len()).map_err(|_| invalid("J_RANGE_LENGTH"))?)
            .ok_or_else(|| invalid("J_RANGE_LENGTH"))?;
    }
    for tail in tails {
        output.extend_from_slice(&tail);
    }
    Ok(output)
}

pub fn canonical_j_event_blocks(
    batches: &[FinalizedJEventBatch],
) -> Result<Vec<CanonicalJEventBlock>, EntityKernelError> {
    let mut prior = 0_u64;
    let mut blocks = Vec::with_capacity(batches.len());
    for batch in batches {
        if batch.j_height == 0 || batch.j_height <= prior {
            return Err(invalid("J_RANGE_BLOCK_ORDER"));
        }
        // The authenticated watcher block is the single event-history source.
        // Account claims are a derived bilateral projection and may contain
        // only the Account-owned subset; rebuilding history from them silently
        // dropped every EntityProvider, reserve, dispute and wallet event.
        for ingress in &batch.account_claims {
            let xln_rscore_engine::AccountTx::JEventClaim(claim) = &ingress.tx else {
                return Err(invalid("J_RANGE_ACCOUNT_TX"));
            };
            if claim.j_height != batch.j_height || claim.j_block_hash != batch.j_block_hash {
                return Err(invalid("J_RANGE_CLAIM_BINDING"));
            }
        }
        let events = canonical_events(&batch.events).map_err(|error| invalid(error.to_string()))?;
        let evidence =
            normalize_dispute_finalization_evidence(&batch.dispute_finalization_evidence)
                .map_err(|error| invalid(error.to_string()))?;
        blocks.push(CanonicalJEventBlock {
            j_height: batch.j_height,
            j_block_hash: batch.j_block_hash,
            events_hash: canonical_events_hash(&events)
                .map_err(|error| invalid(error.to_string()))?,
            events,
            dispute_finalization_evidence_hash: if evidence.is_empty() {
                [0_u8; 32]
            } else {
                canonical_dispute_finalization_evidence_hash(&evidence)
                    .map_err(|error| invalid(error.to_string()))?
            },
            dispute_finalization_evidence: evidence,
        });
        prior = batch.j_height;
    }
    Ok(blocks)
}

pub fn fold_j_history_root(
    mut root: [u8; 32],
    jurisdiction_ref: &str,
    blocks: &[CanonicalJEventBlock],
) -> [u8; 32] {
    for block in blocks {
        let leaf = keccak_words(&[
            text_hash(HISTORY_LEAF_DOMAIN_TEXT),
            text_hash(jurisdiction_ref),
            word(block.j_height),
            text_hash(&render_hex(&block.j_block_hash)),
            block.events_hash,
            block.dispute_finalization_evidence_hash,
        ]);
        root = keccak_words(&[text_hash(HISTORY_FOLD_DOMAIN_TEXT), root, leaf]);
    }
    root
}

pub fn canonical_j_event_range_hash(
    blocks: &[CanonicalJEventBlock],
) -> Result<[u8; 32], EntityKernelError> {
    let heights = blocks
        .iter()
        .map(|block| word(block.j_height))
        .collect::<Vec<_>>();
    let block_hashes = blocks
        .iter()
        .map(|block| text_hash(&render_hex(&block.j_block_hash)))
        .collect::<Vec<_>>();
    let event_hashes = blocks
        .iter()
        .map(|block| block.events_hash)
        .collect::<Vec<_>>();
    let evidence_hashes = blocks
        .iter()
        .map(|block| block.dispute_finalization_evidence_hash)
        .collect::<Vec<_>>();
    Ok(Keccak256::digest(range_abi(
        &heights,
        &block_hashes,
        &event_hashes,
        &evidence_hashes,
    )?)
    .into())
}

#[allow(clippy::too_many_arguments)]
pub fn j_event_range_digest(
    entity_id: &str,
    jurisdiction_ref: &str,
    signer_id: &str,
    base_height: u64,
    scanned_through: u64,
    tip_block_hash: &[u8; 32],
    event_history_root: &[u8; 32],
    range_hash: &[u8; 32],
) -> Result<[u8; 32], EntityKernelError> {
    if scanned_through <= base_height {
        return Err(invalid("J_HISTORY_RANGE_EMPTY"));
    }
    Ok(keccak_words(&[
        text_hash(HISTORY_RANGE_DOMAIN_TEXT),
        text_hash(entity_id),
        text_hash(jurisdiction_ref),
        text_hash(signer_id),
        word(base_height),
        word(scanned_through),
        text_hash(&render_hex(tip_block_hash)),
        *event_history_root,
        *range_hash,
    ]))
}

fn render_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 15)] as char);
    }
    output
}
