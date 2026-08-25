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
use crate::consensus::signing::verify_dispute_hanko;
use crate::error::StateError;
use crate::state::AccountReplica;
use crate::state::identity::Side;

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

/// What one clause may move on each side, ascending by delta index.
struct Allowance {
    delta_index: usize,
    right_allowance: BigInt,
    left_allowance: BigInt,
}

const INT256_MIN_SHIFT: u32 = 255;

fn int256_min() -> BigInt {
    -(BigInt::from(1) << INT256_MIN_SHIFT)
}

fn int256_max() -> BigInt {
    (BigInt::from(1) << INT256_MIN_SHIFT) - 1
}

fn word_from_u64(value: u64) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

/// A signed integer as Solidity holds it: two's complement over 32 bytes.
fn word_from_int(value: &BigInt, field: &'static str) -> Result<[u8; 32], StateError> {
    if *value < int256_min() || *value > int256_max() {
        return Err(StateError::DisputeProof(format!("{field}:int256")));
    }
    let mut word = if value.sign() == Sign::Minus {
        [0xff_u8; 32]
    } else {
        [0_u8; 32]
    };
    let magnitude = if value.sign() == Sign::Minus {
        // Two's complement: 2^256 + value, computed on the magnitude so the
        // bytes are exact rather than rounded through any float or i128.
        (BigInt::from(1) << 256_u32) + value
    } else {
        value.clone()
    };
    let bytes = magnitude.to_bytes_be().1;
    if bytes.len() > 32 {
        return Err(StateError::DisputeProof(format!("{field}:width")));
    }
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(word)
}

fn word_from_uint(value: &BigInt, field: &'static str) -> Result<[u8; 32], StateError> {
    if value.sign() == Sign::Minus {
        return Err(StateError::DisputeProof(format!("{field}:negative")));
    }
    word_from_int(value, field)
}

fn word_from_address(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(address);
    word
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

/// Rebuild and authenticate a peer's recovery proof from the Account's own
/// identity. The exact supplied hash must equal the independent rebuild: a
/// valid Hanko over another Account/domain/watch-seed must never be retained
/// as enforceable evidence for this one.
pub(crate) fn verify_counterparty_dispute(
    replica: &AccountReplica,
    expected_counterparty: &[u8; 32],
    dispute: &CounterpartyDispute,
) -> Result<[u8; 32], StateError> {
    let digest = validate_counterparty_dispute_hash(replica, expected_counterparty, dispute)?;
    let hanko = dispute
        .hanko
        .as_deref()
        .ok_or_else(|| StateError::DisputeHankoInvalid("SHAPE_INVALID:HANKO_MISSING".into()))?;
    verify_dispute_hanko(hanko, &digest, expected_counterparty)?;
    Ok(digest)
}

/// Prove the exact received hash independently of board authentication.
///
/// Stale/duplicate delivery may skip an obsolete Hanko under the canonical
/// replay policy, but it still may not smuggle a different Account-bound hash
/// into the exact peer envelope.
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
    if dispute.nonce > JS_MAX_SAFE_INTEGER {
        return Err(StateError::DisputeHankoInvalid(format!(
            "SHAPE_INVALID:PROOF_NONCE:{}",
            dispute.nonce
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
    use std::fmt::Write as _;
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
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
    let state = replica.state();
    let mut token_ids: Vec<u32> = Vec::new();
    let mut offdeltas: Vec<BigInt> = Vec::new();
    for delta in state.deltas() {
        // Depository negates a negative final delta, and Solidity cannot
        // negate int256::MIN — a body that cannot be finalized must never be
        // signed.
        let final_delta = delta.ondelta().clone() + delta.offdelta().clone();
        if final_delta < int256_min() || final_delta > int256_max() || final_delta == int256_min() {
            return Err(StateError::DisputeProof(format!(
                "finalDelta:{}",
                delta.token_id().get()
            )));
        }
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
        swaps.push(Swap {
            owner_is_left: offer.maker_is_left(),
            add_delta_index: index_of(offer.give_token_id(), "swapGiveToken")?,
            add_amount: offer.give_amount().clone(),
            sub_delta_index: index_of(offer.want_token_id(), "swapWantToken")?,
            sub_amount: offer.want_amount().clone(),
        });
    }

    // One clause per non-empty collection, in the order DeltaTransformer runs
    // them. A batch with nothing in it is not a clause.
    let mut clauses: Vec<(Vec<u8>, Vec<Allowance>)> = Vec::new();
    if !payments.is_empty() {
        let allowances = payment_allowances(&payments)?;
        clauses.push((encode_batch(&payments, &[])?, allowances));
    }
    if !swaps.is_empty() {
        let allowances = swap_allowances(&swaps)?;
        clauses.push((encode_batch(&[], &swaps)?, allowances));
    }
    Ok(Keccak256::digest(encode_proof_body(
        replica,
        delta_transformer,
        &token_ids,
        &offdeltas,
        &clauses,
    )?)
    .into())
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

fn finish_allowances(mut rows: Vec<(usize, BigInt, BigInt)>) -> Vec<Allowance> {
    rows.sort_by_key(|(index, _, _)| *index);
    rows.into_iter()
        .map(|(delta_index, left_allowance, right_allowance)| Allowance {
            delta_index,
            right_allowance,
            left_allowance,
        })
        .collect()
}

fn payment_allowances(payments: &[Payment]) -> Result<Vec<Allowance>, StateError> {
    let mut rows: Vec<(usize, BigInt, BigInt)> = Vec::new();
    for payment in payments {
        add_allowance(&mut rows, payment.delta_index, &payment.amount);
    }
    Ok(finish_allowances(rows))
}

fn swap_allowances(swaps: &[Swap]) -> Result<Vec<Allowance>, StateError> {
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

/// `abi.encode(DeltaTransformer.Batch)` — three arrays of static tuples, so
/// each array is a length followed by its elements inline.
fn encode_batch(payments: &[Payment], swaps: &[Swap]) -> Result<Vec<u8>, StateError> {
    let mut payment_bytes = Vec::new();
    payment_bytes.extend_from_slice(&word_from_u64(payments.len() as u64));
    for payment in payments {
        payment_bytes.extend_from_slice(&word_from_u64(payment.delta_index as u64));
        payment_bytes.extend_from_slice(&word_from_int(&payment.amount, "paymentAmount")?);
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
    // No pulls: the engine carries that section's root and never builds it, so
    // an account holding one is refused before it reaches this process.
    let pull_bytes = word_from_u64(0).to_vec();

    let head = 32 * 3;
    let mut encoded = Vec::new();
    // One tuple parameter, and the tuple is dynamic: the sequence starts with
    // the offset to it.
    encoded.extend_from_slice(&word_from_u64(32));
    encoded.extend_from_slice(&word_from_u64(head as u64));
    encoded.extend_from_slice(&word_from_u64((head + payment_bytes.len()) as u64));
    encoded.extend_from_slice(&word_from_u64(
        (head + payment_bytes.len() + swap_bytes.len()) as u64,
    ));
    encoded.extend_from_slice(&payment_bytes);
    encoded.extend_from_slice(&swap_bytes);
    encoded.extend_from_slice(&pull_bytes);
    Ok(encoded)
}

/// `abi.encode(ProofBody)`.
fn encode_proof_body(
    replica: &AccountReplica,
    delta_transformer: &[u8; 20],
    token_ids: &[u32],
    offdeltas: &[BigInt],
    clauses: &[(Vec<u8>, Vec<Allowance>)],
) -> Result<Vec<u8>, StateError> {
    let identity = replica.state().identity();
    let dispute = replica.state().dispute_config();

    let mut offdelta_bytes = Vec::new();
    offdelta_bytes.extend_from_slice(&word_from_u64(offdeltas.len() as u64));
    for offdelta in offdeltas {
        offdelta_bytes.extend_from_slice(&word_from_int(offdelta, "offdelta")?);
    }
    let mut token_bytes = Vec::new();
    token_bytes.extend_from_slice(&word_from_u64(token_ids.len() as u64));
    for token_id in token_ids {
        token_bytes.extend_from_slice(&word_from_u64(u64::from(*token_id)));
    }

    // Each transformer clause is a dynamic tuple, so the array holds offsets.
    let mut clause_bodies = Vec::with_capacity(clauses.len());
    for (batch, allowances) in clauses {
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
        clause.extend_from_slice(&word_from_address(delta_transformer));
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
    encoded.extend_from_slice(identity.watch_seed().bytes());
    encoded.extend_from_slice(&word_from_u64(u64::from(dispute.left_response_seconds())));
    encoded.extend_from_slice(&word_from_u64(u64::from(dispute.right_response_seconds())));
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
