//! The recovery proof an account signs with every frame it proposes.
//!
//! Parity target: `buildAccountProofBody` and `createDisputeProofHashWithNonce`
//! (core/protocol/dispute/proof-builder.ts). The account leaf commits the hash
//! of this body, the dispute hash over it, and the nonce both are bound to, so
//! an engine that carried the proof it was seeded with would commit last
//! frame's proof against this frame's state — a leaf nobody else computes, and
//! a promise the account could not keep on chain.
//!
//! The encoding is Solidity's, because the body is what a validator submits to
//! `Depository`: ABI words, `payment → swap → pull` clause order, allowances
//! ascending by delta index.

use num_bigint::{BigInt, Sign};
use sha3::{Digest, Keccak256};

use crate::consensus::replica::CounterpartyDispute;
use crate::consensus::signing::{CertifiedBoardAuthority, verify_dispute_hanko_with_authority};
use crate::error::StateError;
use crate::state::AccountReplica;
use crate::state::identity::Side;
use xln_rscore_protocol::CanonicalValue;

const JS_MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

/// One `DeltaTransformer.Batch` payment clause.
struct Payment {
    delta_index: usize,
    amount: BigInt,
    revealed_until_timestamp: u64,
    hash: [u8; 32],
}

/// One `DeltaTransformer.Batch` swap clause.
struct Swap {
    owner_is_left: bool,
    add_delta_index: usize,
    add_amount: BigInt,
    sub_delta_index: usize,
    sub_amount: BigInt,
}

/// One cross-j hash-ladder clause.  Pull bodies are already canonical Account
/// state; dispute construction must project that exact body instead of silently
/// hashing an empty pull array (which produces a proof the peer and Depository
/// do not recognize).
struct Pull {
    delta_index: usize,
    amount: BigInt,
    claimed_ratio: u16,
    full_hash: [u8; 32],
    partial_root: [u8; 32],
    target_role: bool,
}

/// What one clause may move on each side, ascending by delta index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeAllowance {
    pub delta_index: usize,
    pub right_allowance: BigInt,
    pub left_allowance: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeTransformerClause {
    pub transformer_address: [u8; 20],
    pub encoded_batch: Vec<u8>,
    pub allowances: Vec<DisputeAllowance>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeProofBody {
    pub watch_seed: [u8; 32],
    pub left_response_seconds: u32,
    pub right_response_seconds: u32,
    pub offdeltas: Vec<BigInt>,
    pub token_ids: Vec<u32>,
    pub transformers: Vec<DisputeTransformerClause>,
}

fn word_from_u64(value: u64) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

/// Proof offsets are Int512 two's-complement limbs. An offset is cumulative;
/// an ERC20-sized transfer may legitimately cross either signed 256-bit edge.
fn words_from_int512(value: &BigInt, field: &'static str) -> Result<[u8; 64], StateError> {
    let boundary = BigInt::from(1) << 511_u32;
    if value < &(-&boundary) || value >= &boundary {
        return Err(StateError::DisputeProof(format!("{field}:int512Range")));
    }
    let encoded = if value.sign() == Sign::Minus {
        (BigInt::from(1) << 512_u32) + value
    } else {
        value.clone()
    };
    let bytes = encoded.to_bytes_be().1;
    let mut words = [0_u8; 64];
    words[64 - bytes.len()..].copy_from_slice(&bytes);
    Ok(words)
}

/// SignedAmount is (negative, magnitude), so both payer directions use the
/// full uint256 asset domain. BigInt has a unique zero: negative zero cannot
/// be emitted into the signed contract preimage.
fn words_from_movement(value: &BigInt, field: &'static str) -> Result<[u8; 64], StateError> {
    let magnitude = if value.sign() == Sign::Minus {
        -value
    } else {
        value.clone()
    };
    let mut words = [0_u8; 64];
    words[..32].copy_from_slice(&word_from_u64(u64::from(value.sign() == Sign::Minus)));
    words[32..].copy_from_slice(&word_from_uint(&magnitude, field)?);
    Ok(words)
}

fn word_from_uint(value: &BigInt, field: &'static str) -> Result<[u8; 32], StateError> {
    let (sign, bytes) = value.to_bytes_be();
    if sign == Sign::Minus || bytes.len() > 32 {
        return Err(StateError::DisputeProof(format!("{field}:uint256Range")));
    }
    let mut word = [0_u8; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(word)
}

fn word_from_address(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn object_field<'a>(
    value: &'a CanonicalValue,
    name: &'static str,
) -> Result<&'a CanonicalValue, StateError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(StateError::DisputeProof("pull:object".into()));
    };
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
        .ok_or_else(|| StateError::DisputeProof(format!("pull:{name}")))
}

fn optional_object_field<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
}

fn canonical_u64(value: &CanonicalValue, field: &'static str) -> Result<u64, StateError> {
    let CanonicalValue::Number(value) = value else {
        return Err(StateError::DisputeProof(format!("pull:{field}")));
    };
    value
        .as_str()
        .parse::<u64>()
        .map_err(|_| StateError::DisputeProof(format!("pull:{field}")))
}

fn canonical_bigint<'a>(
    value: &'a CanonicalValue,
    field: &'static str,
) -> Result<&'a BigInt, StateError> {
    let CanonicalValue::BigInt(value) = value else {
        return Err(StateError::DisputeProof(format!("pull:{field}")));
    };
    Ok(value)
}

fn canonical_hex32(value: &CanonicalValue, field: &'static str) -> Result<[u8; 32], StateError> {
    let CanonicalValue::String(value) = value else {
        return Err(StateError::DisputeProof(format!("pull:{field}")));
    };
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| StateError::DisputeProof(format!("pull:{field}")))?;
    let mut bytes = [0_u8; 32];
    for (index, pair) in payload.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |byte: u8| -> Option<u8> {
            match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                _ => None,
            }
        };
        let high =
            nibble(pair[0]).ok_or_else(|| StateError::DisputeProof(format!("pull:{field}")))?;
        let low =
            nibble(pair[1]).ok_or_else(|| StateError::DisputeProof(format!("pull:{field}")))?;
        bytes[index] = (high << 4) | low;
    }
    Ok(bytes)
}

fn pull_target_role(value: &CanonicalValue) -> Result<bool, StateError> {
    let binding = object_field(value, "crossJurisdiction")?;
    let CanonicalValue::String(leg) = object_field(binding, "leg")? else {
        return Err(StateError::DisputeProof("pull:leg".into()));
    };
    match leg.as_str() {
        "source" => Ok(false),
        "target" => Ok(true),
        _ => Err(StateError::DisputeProof("pull:leg".into())),
    }
}

/// The proof body's hash, and the dispute hash a validator signs over it.
pub struct DisputeProof {
    pub proof_body_hash: [u8; 32],
    pub dispute_hash: [u8; 32],
}

/// The byte wire has already made hash widths, integer sign and the role bit
/// structural. Hanko absence remains representable because internal drafts use
/// the same canonical shape, but routed evidence requires non-empty bytes.
pub(crate) fn validate_counterparty_dispute_shape(
    dispute: &CounterpartyDispute,
) -> Result<(), StateError> {
    if dispute.hanko.as_ref().is_none_or(Vec::is_empty) {
        return Err(StateError::DisputeHankoInvalid(
            "SHAPE_INVALID:HANKO_MISSING".to_string(),
        ));
    }
    Ok(())
}

/// Authority-aware dispute verification. Historical evidence may use exactly
/// the previous Entity-certified board until its exclusive expiry; callers on
/// fresh-money or refresh lanes pass `allow_previous_board = false`.
pub(crate) fn verify_counterparty_dispute_with_authority(
    replica: &AccountReplica,
    expected_counterparty: &[u8; 32],
    dispute: &CounterpartyDispute,
    authority: Option<&CertifiedBoardAuthority>,
    entity_timestamp_ms: u64,
    allow_previous_board: bool,
) -> Result<[u8; 32], StateError> {
    let digest = validate_counterparty_dispute_hash(replica, expected_counterparty, dispute)?;
    let hanko = dispute
        .hanko
        .as_deref()
        .ok_or_else(|| StateError::DisputeHankoInvalid("SHAPE_INVALID:HANKO_MISSING".into()))?;
    verify_dispute_hanko_with_authority(
        hanko,
        &digest,
        expected_counterparty,
        authority,
        entity_timestamp_ms,
        allow_previous_board,
    )?;
    Ok(digest)
}

/// Prove the exact received hash independently of board authentication.
///
/// Stale/duplicate delivery may skip an obsolete Hanko under the canonical
/// replay policy, but it still may not smuggle a different Account-bound hash
/// into the exact Account input envelope.
pub(crate) fn validate_counterparty_dispute_hash(
    replica: &AccountReplica,
    expected_counterparty: &[u8; 32],
    dispute: &CounterpartyDispute,
) -> Result<[u8; 32], StateError> {
    validate_counterparty_dispute_shape(dispute)?;
    if expected_counterparty != replica.counterparty().as_bytes() {
        return Err(StateError::DisputeHankoInvalid(
            "COUNTERPARTY_ACCOUNT_BINDING".to_string(),
        ));
    }
    // Parity target: `validateCounterpartyDisputeHanko`
    // (core/account/consensus/dispute/hanko.ts). TypeScript keeps every proof
    // nonce strictly below MAX_SAFE_INTEGER, and the next settlement or proof
    // nonce is chosen above this witness. A witness at MAX_SAFE_INTEGER - 1
    // leaves no executable successor, so it is refused on every lane before it
    // is stored: a peer may exhaust its Account, never the Runtime.
    if dispute.nonce >= JS_MAX_SAFE_INTEGER {
        return Err(StateError::DisputeHankoInvalid(format!(
            "SHAPE_INVALID:PROOF_NONCE:{}",
            dispute.nonce
        )));
    }
    if dispute.nonce == JS_MAX_SAFE_INTEGER - 1 {
        return Err(StateError::DisputeHankoInvalid(format!(
            "SETTLEMENT_NONCE_EXHAUSTED:{JS_MAX_SAFE_INTEGER}"
        )));
    }
    let identity = replica.state().identity();
    let digest = dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.entity(Side::Left).as_bytes(),
        identity.entity(Side::Right).as_bytes(),
        dispute.nonce,
        dispute.proposer_is_left,
        &dispute.proof_body_hash,
        identity.watch_seed().bytes(),
    );
    if dispute.hash != digest {
        return Err(StateError::DisputeHankoInvalid("HASH_MISMATCH".to_string()));
    }
    Ok(digest)
}

/// Apply the canonical nonce/body requirement after the candidate proof body
/// is known. Active traffic authenticates the witness before collision or
/// replay can mutate state; stale/duplicate traffic has already left through
/// the at-least-once no-op gate. Only a replayed frame can be compared with its
/// post-frame body.
///
/// Parity target: `getDisputeHankoRequirementError`
/// (core/account/consensus/dispute/hanko.ts). `proposer_is_left` is bound into
/// the reconstructed Solidity digest above; TypeScript does not separately
/// compare it with a locally inferred side, so neither does this predicate.
pub(crate) fn counterparty_dispute_requirement_error(
    expected_proof_body_hash: Option<&[u8; 32]>,
    previous: Option<&CounterpartyDispute>,
    j_nonce: u64,
    received: Option<&CounterpartyDispute>,
) -> Option<String> {
    let Some(expected) = expected_proof_body_hash else {
        return received
            .is_some()
            .then(|| "DISPUTE_HANKO_UNEXPECTED_WITHOUT_LOCAL_PROOF".to_string());
    };
    if let Some(dispute) = received {
        if dispute.nonce <= j_nonce {
            return Some(format!(
                "DISPUTE_HANKO_NONCE_ALREADY_FINALIZED: received={} jNonce={j_nonce}",
                dispute.nonce
            ));
        }
        if let Some(previous) = previous {
            if dispute.nonce < previous.nonce {
                return Some(format!(
                    "DISPUTE_HANKO_NONCE_REGRESSION: received={} previous={}",
                    dispute.nonce, previous.nonce
                ));
            }
            if dispute.nonce == previous.nonce
                && dispute.proof_body_hash != previous.proof_body_hash
            {
                return Some(format!(
                    "DISPUTE_HANKO_NONCE_REUSE: nonce={}",
                    dispute.nonce
                ));
            }
        }
        if &dispute.proof_body_hash != expected {
            return Some(format!(
                "DISPUTE_HANKO_PROOFBODY_MISMATCH: expected={} received={}",
                prefixed_hex(expected),
                prefixed_hex(&dispute.proof_body_hash)
            ));
        }
    }
    let proof_changed = previous.is_none_or(|proof| &proof.proof_body_hash != expected);
    let proof_nonce_consumed = previous.map_or(0, |proof| proof.nonce) <= j_nonce;
    if (proof_changed || proof_nonce_consumed) && received.is_none() {
        return Some(format!(
            "DISPUTE_HANKO_REQUIRED: proofBodyHash={} jNonce={j_nonce}",
            prefixed_hex(expected)
        ));
    }
    None
}

fn prefixed_hex(bytes: &[u8]) -> String {
    // Nibble table, not `write!`: a dispute proof formats every leaf it binds.
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = Vec::with_capacity(2 + bytes.len() * 2);
    output.extend_from_slice(b"0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)]);
        output.push(DIGITS[usize::from(byte & 0x0f)]);
    }
    String::from_utf8(output).unwrap_or_default()
}

/// Build this account's proof body and the dispute hash for one nonce.
///
/// `proposer_is_left` is the side this replica belongs to, which is what the
/// contract checks the signature against.
pub fn build_dispute_proof(
    replica: &AccountReplica,
    delta_transformer: &[u8; 20],
    nonce: u64,
) -> Result<DisputeProof, StateError> {
    let proof_body_hash = proof_body_hash(replica, delta_transformer)?;
    let identity = replica.state().identity();
    let dispute_hash = dispute_proof_hash(
        identity.domain().chain_id(),
        identity.domain().depository_address().bytes(),
        identity.entity(Side::Left).as_bytes(),
        identity.entity(Side::Right).as_bytes(),
        nonce,
        replica.owner_side() == Side::Left,
        &proof_body_hash,
        identity.watch_seed().bytes(),
    );
    Ok(DisputeProof {
        proof_body_hash,
        dispute_hash,
    })
}

/// keccak of the ABI-encoded `ProofBody`.
pub fn proof_body_hash(
    replica: &AccountReplica,
    delta_transformer: &[u8; 20],
) -> Result<[u8; 32], StateError> {
    let body = build_dispute_proof_body(replica, delta_transformer)?;
    Ok(Keccak256::digest(encode_proof_body(&body)?).into())
}

/// Build the exact value later submitted to Depository. Hashing and JBatch
/// projection consume this same object; no Entity-side proof reconstruction
/// or second formula is permitted.
pub fn build_dispute_proof_body(
    replica: &AccountReplica,
    delta_transformer: &[u8; 20],
) -> Result<DisputeProofBody, StateError> {
    let state = replica.state();
    if state.carried().subcontracts_root != [0; 32] {
        // Rust does not keep a second opaque subcontract body behind the
        // committed root.  Silently omitting it would certify a different
        // ProofBody; refuse until that canonical collection is resident.
        return Err(StateError::DisputeProof("subcontracts:bodyMissing".into()));
    }
    let mut token_ids: Vec<u32> = Vec::new();
    let mut offdeltas: Vec<BigInt> = Vec::new();
    for delta in state.deltas() {
        // Both offsets are validated Int512 state. Depository adds them in
        // Int768 and records any shortfall as unsigned debt; signed256 MIN
        // and final sums beyond signed256 are valid settlement outcomes.
        token_ids.push(u32::from(delta.token_id().get()));
        offdeltas.push(delta.offdelta().clone());
    }
    let index_of = |token_id: u32, field: &'static str| -> Result<usize, StateError> {
        token_ids
            .iter()
            .position(|candidate| *candidate == token_id)
            .ok_or_else(|| StateError::DisputeProof(format!("{field}:{token_id}")))
    };

    let mut locks: Vec<_> = state.htlc_locks().collect();
    locks.sort_by(|left, right| left.lock_id().cmp(right.lock_id()));
    let mut payments = Vec::with_capacity(locks.len());
    for lock in locks {
        // The account holds an exclusive millisecond deadline; the contract
        // takes the greatest inclusive second before it.
        let seconds = (lock.timelock().clone() - 1) / 1_000;
        let seconds =
            u64::try_from(seconds).map_err(|_| StateError::DisputeProof("timelock".to_string()))?;
        if seconds == 0 {
            return Err(StateError::DisputeProof("timelock".to_string()));
        }
        payments.push(Payment {
            delta_index: index_of(u32::from(lock.token_id().get()), "lockToken")?,
            amount: if lock.sender() == Side::Left {
                -lock.amount().clone()
            } else {
                lock.amount().clone()
            },
            revealed_until_timestamp: seconds,
            hash: *lock.hashlock().bytes(),
        });
    }

    let mut offers: Vec<_> = state.swap_offers().collect();
    offers.sort_by(|left, right| left.offer_id().cmp(right.offer_id()));
    let mut swaps = Vec::with_capacity(offers.len());
    for offer in offers {
        if offer.cross_jurisdiction().is_some() {
            continue;
        }
        swaps.push(Swap {
            owner_is_left: offer.maker_is_left(),
            add_delta_index: index_of(offer.give_token_id(), "swapGiveToken")?,
            add_amount: offer.give_amount().clone(),
            sub_delta_index: index_of(offer.want_token_id(), "swapWantToken")?,
            sub_amount: offer.want_amount().clone(),
        });
    }

    let mut pulls = Vec::with_capacity(state.pull_count());
    for (_, value) in state.pulls() {
        let token_id = u32::try_from(canonical_u64(object_field(value, "tokenId")?, "tokenId")?)
            .map_err(|_| StateError::DisputeProof("pull:tokenId".into()))?;
        let claimed_ratio = optional_object_field(value, "claimedRatio")
            .map(|value| canonical_u64(value, "claimedRatio"))
            .transpose()?
            .unwrap_or(0)
            .min(u64::from(u16::MAX)) as u16;
        pulls.push(Pull {
            delta_index: index_of(token_id, "pullToken")?,
            amount: canonical_bigint(object_field(value, "amount")?, "amount")?.clone(),
            claimed_ratio,
            full_hash: canonical_hex32(object_field(value, "fullHash")?, "fullHash")?,
            partial_root: canonical_hex32(object_field(value, "partialRoot")?, "partialRoot")?,
            target_role: pull_target_role(value)?,
        });
    }

    // Preserve TS payment → swap → pull order and greedily split only at the
    // signed storage-atom or uint256 allowance boundary.
    let mut clauses = chunk_clauses(&payments, |items| {
        Ok(DisputeTransformerClause {
            transformer_address: *delta_transformer,
            encoded_batch: encode_batch(items, &[], &[])?,
            allowances: payment_allowances(items)?,
        })
    })?;
    clauses.extend(chunk_clauses(&swaps, |items| {
        Ok(DisputeTransformerClause {
            transformer_address: *delta_transformer,
            encoded_batch: encode_batch(&[], items, &[])?,
            allowances: swap_allowances(items)?,
        })
    })?);
    clauses.extend(chunk_clauses(&pulls, |items| {
        Ok(DisputeTransformerClause {
            transformer_address: *delta_transformer,
            encoded_batch: encode_batch(&[], &[], items)?,
            allowances: pull_allowances(items),
        })
    })?);
    let identity = state.identity();
    let dispute = state.dispute_config();
    Ok(DisputeProofBody {
        watch_seed: *identity.watch_seed().bytes(),
        left_response_seconds: dispute.left_response_seconds(),
        right_response_seconds: dispute.right_response_seconds(),
        offdeltas,
        token_ids,
        transformers: clauses,
    })
}

// Exact msgpackr atom envelope: magic byte + record definition + "atom" +
// hex string. ABI batches are at least 288 bytes, hence always str16 below
// this 10,000-byte boundary. The independent TS vectors pin this overhead.
fn clause_fits(clause: &DisputeTransformerClause) -> bool {
    let max: BigInt = (BigInt::from(1) << 256_u32) - 1;
    clause.encoded_batch.len() * 2 + 26 < 10_000
        && clause
            .allowances
            .iter()
            .all(|row| row.left_allowance <= max && row.right_allowance <= max)
}

fn chunk_clauses<T>(
    items: &[T],
    build: impl Fn(&[T]) -> Result<DisputeTransformerClause, StateError>,
) -> Result<Vec<DisputeTransformerClause>, StateError> {
    let mut clauses = Vec::new();
    let mut start = 0;
    for end in 1..=items.len() {
        let candidate = build(&items[start..end])?;
        if clause_fits(&candidate) {
            continue;
        }
        if end - 1 > start {
            clauses.push(build(&items[start..end - 1])?);
        }
        start = end - 1;
        let single = build(&items[start..end])?;
        if !clause_fits(&single) {
            return Err(StateError::DisputeProof(format!(
                "ACCOUNT_DISPUTE_PROOF_ATOM_BYTES_EXCEEDED:transformer={}:{}/10000",
                clauses.len(),
                single.encoded_batch.len() * 2 + 26,
            )));
        }
    }
    if start < items.len() {
        clauses.push(build(&items[start..])?);
    }
    Ok(clauses)
}

impl DisputeTransformerClause {
    /// Project positional arguments from the already-built signed batch, never
    /// rerun a second chunking formula in Entity. Solidity restarts each side's
    /// counterparty-owned swap index for every transformer invocation.
    pub fn argument_counts(&self) -> Result<(usize, usize, usize), StateError> {
        let read = |offset: usize| -> Result<usize, StateError> {
            let word = self
                .encoded_batch
                .get(offset..offset + 32)
                .ok_or_else(|| StateError::DisputeProof("batch:argumentOffset".into()))?;
            if word[..24].iter().any(|byte| *byte != 0) {
                return Err(StateError::DisputeProof("batch:argumentCount".into()));
            }
            usize::try_from(u64::from_be_bytes(word[24..].try_into().expect("word")))
                .map_err(|_| StateError::DisputeProof("batch:argumentCount".into()))
        };
        let base = read(0)?;
        let payment_count = read(base + read(base)?)?;
        let swap_base = base + read(base + 32)?;
        let swap_count = read(swap_base)?;
        let mut left_count = 0;
        let mut right_count = 0;
        for index in 0..swap_count {
            match read(swap_base + 32 + index * 160)? {
                0 => left_count += 1,
                1 => right_count += 1,
                _ => return Err(StateError::DisputeProof("batch:swapOwner".into())),
            }
        }
        Ok((payment_count, left_count, right_count))
    }
}

fn add_allowance(
    allowances: &mut Vec<(usize, BigInt, BigInt)>,
    delta_index: usize,
    signed_diff: &BigInt,
) {
    if signed_diff.sign() == Sign::NoSign {
        return;
    }
    let entry = match allowances
        .iter_mut()
        .find(|(index, _, _)| *index == delta_index)
    {
        Some(entry) => entry,
        None => {
            allowances.push((delta_index, BigInt::from(0), BigInt::from(0)));
            allowances.last_mut().expect("pushed")
        }
    };
    if signed_diff.sign() == Sign::Plus {
        entry.1 += signed_diff;
    } else {
        entry.2 += -signed_diff;
    }
}

fn finish_allowances(mut rows: Vec<(usize, BigInt, BigInt)>) -> Vec<DisputeAllowance> {
    rows.sort_by_key(|(index, _, _)| *index);
    rows.into_iter()
        .map(
            |(delta_index, left_allowance, right_allowance)| DisputeAllowance {
                delta_index,
                right_allowance,
                left_allowance,
            },
        )
        .collect()
}

fn payment_allowances(payments: &[Payment]) -> Result<Vec<DisputeAllowance>, StateError> {
    let mut rows: Vec<(usize, BigInt, BigInt)> = Vec::new();
    for payment in payments {
        add_allowance(&mut rows, payment.delta_index, &payment.amount);
    }
    Ok(finish_allowances(rows))
}

fn swap_allowances(swaps: &[Swap]) -> Result<Vec<DisputeAllowance>, StateError> {
    let mut rows: Vec<(usize, BigInt, BigInt)> = Vec::new();
    for swap in swaps {
        // The maker gives on one delta and wants on the other, and the sign of
        // each movement follows the side that pays it.
        let give = if swap.owner_is_left {
            -swap.add_amount.clone()
        } else {
            swap.add_amount.clone()
        };
        let want = if swap.owner_is_left {
            swap.sub_amount.clone()
        } else {
            -swap.sub_amount.clone()
        };
        add_allowance(&mut rows, swap.add_delta_index, &give);
        add_allowance(&mut rows, swap.sub_delta_index, &want);
    }
    Ok(finish_allowances(rows))
}

fn pull_allowances(pulls: &[Pull]) -> Vec<DisputeAllowance> {
    let mut rows: Vec<(usize, BigInt, BigInt)> = Vec::new();
    for pull in pulls {
        add_allowance(&mut rows, pull.delta_index, &pull.amount);
    }
    finish_allowances(rows)
}

/// `abi.encode(DeltaTransformer.Batch)` uses four arrays. The current Rust
/// launch profile rejects loan covenant bodies, so its fourth array is empty.
/// Omitting it changes the signed proof hash and invalidates the peer Hanko.
fn encode_batch(
    payments: &[Payment],
    swaps: &[Swap],
    pulls: &[Pull],
) -> Result<Vec<u8>, StateError> {
    let mut payment_bytes = Vec::new();
    payment_bytes.extend_from_slice(&word_from_u64(payments.len() as u64));
    for payment in payments {
        payment_bytes.extend_from_slice(&word_from_u64(payment.delta_index as u64));
        payment_bytes.extend_from_slice(&words_from_movement(&payment.amount, "paymentAmount")?);
        payment_bytes.extend_from_slice(&word_from_u64(payment.revealed_until_timestamp));
        payment_bytes.extend_from_slice(&payment.hash);
    }
    let mut swap_bytes = Vec::new();
    swap_bytes.extend_from_slice(&word_from_u64(swaps.len() as u64));
    for swap in swaps {
        swap_bytes.extend_from_slice(&word_from_u64(u64::from(swap.owner_is_left)));
        swap_bytes.extend_from_slice(&word_from_u64(swap.add_delta_index as u64));
        swap_bytes.extend_from_slice(&word_from_uint(&swap.add_amount, "swapAddAmount")?);
        swap_bytes.extend_from_slice(&word_from_u64(swap.sub_delta_index as u64));
        swap_bytes.extend_from_slice(&word_from_uint(&swap.sub_amount, "swapSubAmount")?);
    }
    let mut pull_bytes = Vec::new();
    pull_bytes.extend_from_slice(&word_from_u64(pulls.len() as u64));
    for pull in pulls {
        pull_bytes.extend_from_slice(&word_from_u64(pull.delta_index as u64));
        pull_bytes.extend_from_slice(&words_from_movement(&pull.amount, "pullAmount")?);
        pull_bytes.extend_from_slice(&word_from_u64(u64::from(pull.claimed_ratio)));
        pull_bytes.extend_from_slice(&pull.full_hash);
        pull_bytes.extend_from_slice(&pull.partial_root);
        pull_bytes.extend_from_slice(&word_from_u64(u64::from(pull.target_role)));
    }

    let head = 32 * 4;
    let mut encoded = Vec::new();
    // One tuple parameter, and the tuple is dynamic: the sequence starts with
    // the offset to it.
    encoded.extend_from_slice(&word_from_u64(32));
    encoded.extend_from_slice(&word_from_u64(head as u64));
    encoded.extend_from_slice(&word_from_u64((head + payment_bytes.len()) as u64));
    encoded.extend_from_slice(&word_from_u64(
        (head + payment_bytes.len() + swap_bytes.len()) as u64,
    ));
    encoded.extend_from_slice(&word_from_u64(
        (head + payment_bytes.len() + swap_bytes.len() + pull_bytes.len()) as u64,
    ));
    encoded.extend_from_slice(&payment_bytes);
    encoded.extend_from_slice(&swap_bytes);
    encoded.extend_from_slice(&pull_bytes);
    encoded.extend_from_slice(&word_from_u64(0));
    Ok(encoded)
}

/// `abi.encode(ProofBody)`.
fn encode_proof_body(body: &DisputeProofBody) -> Result<Vec<u8>, StateError> {
    let mut offdelta_bytes = Vec::new();
    offdelta_bytes.extend_from_slice(&word_from_u64(body.offdeltas.len() as u64));
    for offdelta in &body.offdeltas {
        offdelta_bytes.extend_from_slice(&words_from_int512(offdelta, "offdelta")?);
    }
    let mut token_bytes = Vec::new();
    token_bytes.extend_from_slice(&word_from_u64(body.token_ids.len() as u64));
    for token_id in &body.token_ids {
        token_bytes.extend_from_slice(&word_from_u64(u64::from(*token_id)));
    }

    // Each transformer clause is a dynamic tuple, so the array holds offsets.
    let mut clause_bodies = Vec::with_capacity(body.transformers.len());
    for clause_value in &body.transformers {
        let batch = &clause_value.encoded_batch;
        let allowances = &clause_value.allowances;
        let mut allowance_bytes = Vec::new();
        allowance_bytes.extend_from_slice(&word_from_u64(allowances.len() as u64));
        for allowance in allowances {
            allowance_bytes.extend_from_slice(&word_from_u64(allowance.delta_index as u64));
            allowance_bytes.extend_from_slice(&word_from_uint(
                &allowance.right_allowance,
                "rightAllowance",
            )?);
            allowance_bytes
                .extend_from_slice(&word_from_uint(&allowance.left_allowance, "leftAllowance")?);
        }
        let mut batch_bytes = Vec::new();
        batch_bytes.extend_from_slice(&word_from_u64(batch.len() as u64));
        batch_bytes.extend_from_slice(batch);
        let padding = (32 - batch.len() % 32) % 32;
        batch_bytes.extend(std::iter::repeat_n(0_u8, padding));

        let head = 32 * 3;
        let mut clause = Vec::new();
        clause.extend_from_slice(&word_from_address(&clause_value.transformer_address));
        clause.extend_from_slice(&word_from_u64(head as u64));
        clause.extend_from_slice(&word_from_u64((head + batch_bytes.len()) as u64));
        clause.extend_from_slice(&batch_bytes);
        clause.extend_from_slice(&allowance_bytes);
        clause_bodies.push(clause);
    }
    let mut transformer_bytes = Vec::new();
    transformer_bytes.extend_from_slice(&word_from_u64(clause_bodies.len() as u64));
    let mut offset = 32 * clause_bodies.len();
    for clause in &clause_bodies {
        transformer_bytes.extend_from_slice(&word_from_u64(offset as u64));
        offset += clause.len();
    }
    for clause in &clause_bodies {
        transformer_bytes.extend_from_slice(clause);
    }

    let head = 32 * 6;
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&word_from_u64(32));
    encoded.extend_from_slice(&body.watch_seed);
    encoded.extend_from_slice(&word_from_u64(u64::from(body.left_response_seconds)));
    encoded.extend_from_slice(&word_from_u64(u64::from(body.right_response_seconds)));
    encoded.extend_from_slice(&word_from_u64(head as u64));
    encoded.extend_from_slice(&word_from_u64((head + offdelta_bytes.len()) as u64));
    encoded.extend_from_slice(&word_from_u64(
        (head + offdelta_bytes.len() + token_bytes.len()) as u64,
    ));
    encoded.extend_from_slice(&offdelta_bytes);
    encoded.extend_from_slice(&token_bytes);
    encoded.extend_from_slice(&transformer_bytes);
    Ok(encoded)
}

/// keccak of `abi.encode(uint256,uint256,address,bytes,uint256,bool,bytes32,bytes32)`
/// over message type 1 and the account's own key.
///
/// Parity target: `encodeDisputeProofHankoPayload` (core/hanko/onchain-domain.ts).
#[allow(clippy::too_many_arguments)]
pub fn dispute_proof_hash(
    chain_id: u64,
    depository: &[u8; 20],
    left: &[u8; 32],
    right: &[u8; 32],
    nonce: u64,
    proposer_is_left: bool,
    proof_body_hash: &[u8; 32],
    watch_seed: &[u8; 32],
) -> [u8; 32] {
    // The account key is the two entity ids packed, which is `bytes`: a length
    // and the data, padded out to a whole word.
    let mut account_key = Vec::with_capacity(64);
    account_key.extend_from_slice(left);
    account_key.extend_from_slice(right);

    let head = 32 * 8;
    let mut encoded = Vec::with_capacity(head + 32 + account_key.len());
    encoded.extend_from_slice(&word_from_u64(1));
    encoded.extend_from_slice(&word_from_u64(chain_id));
    encoded.extend_from_slice(&word_from_address(depository));
    encoded.extend_from_slice(&word_from_u64(head as u64));
    encoded.extend_from_slice(&word_from_u64(nonce));
    encoded.extend_from_slice(&word_from_u64(u64::from(proposer_is_left)));
    encoded.extend_from_slice(proof_body_hash);
    encoded.extend_from_slice(watch_seed);
    encoded.extend_from_slice(&word_from_u64(account_key.len() as u64));
    encoded.extend_from_slice(&account_key);
    Keccak256::digest(&encoded).into()
}

#[cfg(test)]
mod counterparty_requirement_tests {
    use super::*;

    fn dispute(nonce: u64, proof_body_hash: [u8; 32]) -> CounterpartyDispute {
        CounterpartyDispute {
            hanko: Some(vec![1]),
            hash: [0; 32],
            proof_body_hash,
            nonce,
            proposer_is_left: true,
        }
    }

    #[test]
    fn fresh_and_exact_unconsumed_proofs_are_accepted() {
        let body = [0x11; 32];
        let fresh = dispute(5, body);
        assert_eq!(
            counterparty_dispute_requirement_error(Some(&body), None, 4, Some(&fresh)),
            None,
        );
        assert_eq!(
            counterparty_dispute_requirement_error(Some(&body), Some(&fresh), 4, Some(&fresh)),
            None,
        );
        assert_eq!(
            counterparty_dispute_requirement_error(Some(&body), Some(&fresh), 4, None),
            None,
        );
    }

    #[test]
    fn finalized_regressing_and_retargeted_nonces_are_rejected() {
        let body = [0x11; 32];
        let other = [0x22; 32];
        let previous = dispute(5, body);
        assert_eq!(
            counterparty_dispute_requirement_error(
                Some(&body),
                Some(&previous),
                5,
                Some(&previous),
            )
            .as_deref(),
            Some("DISPUTE_HANKO_NONCE_ALREADY_FINALIZED: received=5 jNonce=5"),
        );
        let regressing = dispute(4, body);
        assert_eq!(
            counterparty_dispute_requirement_error(
                Some(&body),
                Some(&previous),
                3,
                Some(&regressing),
            )
            .as_deref(),
            Some("DISPUTE_HANKO_NONCE_REGRESSION: received=4 previous=5"),
        );
        let retargeted = dispute(5, other);
        assert_eq!(
            counterparty_dispute_requirement_error(
                Some(&other),
                Some(&previous),
                3,
                Some(&retargeted),
            )
            .as_deref(),
            Some("DISPUTE_HANKO_NONCE_REUSE: nonce=5"),
        );
    }

    #[test]
    fn changed_consumed_missing_and_unexpected_proofs_are_rejected() {
        let body = [0x11; 32];
        let other = [0x22; 32];
        let previous = dispute(5, body);
        let wrong_body = dispute(6, other);
        assert!(
            counterparty_dispute_requirement_error(
                Some(&body),
                Some(&previous),
                3,
                Some(&wrong_body),
            )
            .expect("body mismatch")
            .starts_with("DISPUTE_HANKO_PROOFBODY_MISMATCH"),
        );
        assert!(
            counterparty_dispute_requirement_error(Some(&other), Some(&previous), 3, None)
                .expect("changed proof requires witness")
                .starts_with("DISPUTE_HANKO_REQUIRED"),
        );
        assert!(
            counterparty_dispute_requirement_error(Some(&body), Some(&previous), 5, None)
                .expect("consumed proof requires witness")
                .starts_with("DISPUTE_HANKO_REQUIRED"),
        );
        assert_eq!(
            counterparty_dispute_requirement_error(None, None, 0, Some(&previous)).as_deref(),
            Some("DISPUTE_HANKO_UNEXPECTED_WITHOUT_LOCAL_PROOF"),
        );
    }
}

#[cfg(test)]
mod chunk_parity_tests {
    use super::*;

    #[test]
    fn dispute_chunks_match_ts_32_payments_34_swaps_proof_hash() {
        let payments = (0..32)
            .map(|index| {
                let mut hash = [0; 32];
                hash[31] = index + 1;
                Payment {
                    delta_index: 0,
                    amount: BigInt::from(-1),
                    revealed_until_timestamp: 99,
                    hash,
                }
            })
            .collect::<Vec<_>>();
        let swaps = (0..34)
            .map(|index| Swap {
                owner_is_left: index % 2 == 0,
                add_delta_index: 0,
                add_amount: BigInt::from(100),
                sub_delta_index: 1,
                sub_amount: BigInt::from(200),
            })
            .collect::<Vec<_>>();
        let mut clauses = chunk_clauses(&payments, |items| {
            Ok(DisputeTransformerClause {
                transformer_address: [0x22; 20],
                encoded_batch: encode_batch(items, &[], &[])?,
                allowances: payment_allowances(items)?,
            })
        })
        .unwrap();
        clauses.extend(
            chunk_clauses(&swaps, |items| {
                Ok(DisputeTransformerClause {
                    transformer_address: [0x22; 20],
                    encoded_batch: encode_batch(&[], items, &[])?,
                    allowances: swap_allowances(items)?,
                })
            })
            .unwrap(),
        );
        assert_eq!(
            clauses
                .iter()
                .map(|clause| clause.argument_counts().unwrap())
                .collect::<Vec<_>>(),
            [(29, 0, 0), (3, 0, 0), (0, 14, 15), (0, 3, 2)]
        );
        assert_eq!(
            clauses
                .iter()
                .map(|clause| clause.encoded_batch.len() * 2 + 26)
                .collect::<Vec<_>>(),
            [9882, 1562, 9882, 2202]
        );
        let mut body = DisputeProofBody {
            watch_seed: [0x11; 32],
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: vec![BigInt::from(0); 2],
            token_ids: vec![1, 2],
            transformers: clauses,
        };
        // Independent TS buildAccountProofBody oracle, fixed IDs lock/offer-00..
        // and monotonically numbered hashes: binds ordering, ABI and allowances.
        assert_eq!(
            prefixed_hex(&Keccak256::digest(encode_proof_body(&body).unwrap())),
            "0x7331b0e30fbe6940ecbc6d33c9fb4e1a56820b0429a0c14e1ecf750cf1231b4f"
        );
        let pulls = (0..22)
            .map(|index| {
                let mut full_hash = [0; 32];
                full_hash[31] = index + 1;
                Pull {
                    delta_index: 0,
                    amount: BigInt::from(if index % 2 == 0 { 1 } else { -1 }),
                    claimed_ratio: u16::from(index),
                    full_hash,
                    partial_root: [0x33; 32],
                    target_role: index % 2 == 0,
                }
            })
            .collect::<Vec<_>>();
        let clauses = chunk_clauses(&pulls, |items| {
            Ok(DisputeTransformerClause {
                transformer_address: [0x22; 20],
                encoded_batch: encode_batch(&[], &[], items)?,
                allowances: pull_allowances(items),
            })
        })
        .unwrap();
        assert_eq!(
            clauses
                .iter()
                .map(|clause| clause.encoded_batch.len() * 2 + 26)
                .collect::<Vec<_>>(),
            [9562, 1498]
        );
        body.transformers.extend(clauses);
        assert_eq!(
            prefixed_hex(&Keccak256::digest(encode_proof_body(&body).unwrap())),
            "0x0af26e0daa5e35620695a67d9b7cb4cad0b643b11cbd30a1fc68fe1d75bacfcf"
        );
    }

    #[test]
    fn dispute_chunks_split_uint256_allowance_before_it_overflows() {
        let max: BigInt = (BigInt::from(1) << 256_u32) - 1;
        let payments = [max.clone(), BigInt::from(1)].map(|amount| Payment {
            delta_index: 0,
            amount,
            revealed_until_timestamp: 99,
            hash: [1; 32],
        });
        let clauses = chunk_clauses(&payments, |items| {
            Ok(DisputeTransformerClause {
                transformer_address: [2; 20],
                encoded_batch: encode_batch(items, &[], &[])?,
                allowances: payment_allowances(items)?,
            })
        })
        .unwrap();
        assert_eq!(clauses.len(), 2);
        assert_eq!(clauses[0].allowances[0].left_allowance, max);
        assert_eq!(clauses[1].allowances[0].left_allowance, BigInt::from(1));
        let error = chunk_clauses(&[0], |_| {
            Ok(DisputeTransformerClause {
                transformer_address: [2; 20],
                encoded_batch: vec![0; 4987],
                allowances: Vec::new(),
            })
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("ACCOUNT_DISPUTE_PROOF_ATOM_BYTES_EXCEEDED")
        );
    }
}
