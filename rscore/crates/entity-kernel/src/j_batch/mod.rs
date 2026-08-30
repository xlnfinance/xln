mod decode;
mod encode;
mod reserve;
mod schema;
mod scrub;
mod types;
mod value;

use ethabi::ethereum_types::U256;
use num_bigint::Sign;
use thiserror::Error;

pub use decode::{decode_final_dispute_token, decode_j_batch};
pub use encode::{encode_j_batch, encode_proof_body};
pub use reserve::{
    DraftBatchReserveIssue, DraftBatchReserveOpType, DraftBatchReserveSimulation,
    simulate_draft_batch_reserve_availability,
};
pub use schema::final_dispute as final_dispute_param;
pub(crate) use scrub::{
    prepend_recovery_batch, prune_empty_recovery_batches, scrub_counter_disputes_for_active_start,
    scrub_counter_disputes_for_counterparty, scrub_counter_disputes_superseded_by_observed,
    scrub_dispute_finalizations_for_counterparty, scrub_dispute_starts_for_counterparty,
    scrub_source_registrations_for_counterparty,
};
pub use types::*;
pub use value::{
    canonical_j_batch, canonical_j_batch_state, decode_canonical_j_batch,
    decode_canonical_j_batch_state,
};

fn nonnegative_u256(value: &num_bigint::BigInt, field: &'static str) -> Result<U256, JBatchError> {
    if value.sign() == Sign::Minus {
        return Err(JBatchError::Abi(format!("{field}:negative")));
    }
    let (_, bytes) = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(JBatchError::Abi(format!("{field}:width")));
    }
    Ok(U256::from_big_endian(&bytes))
}

/// Lossless projection of the one Account-owned ProofBody into the Depository
/// batch type.  Both the signed hash and J submission consume the same value;
/// Entity must never rebuild transformer clauses independently.
pub fn proof_body_from_engine(
    body: xln_rscore_engine::DisputeProofBody,
) -> Result<ProofBody, JBatchError> {
    Ok(ProofBody {
        watch_seed: body.watch_seed,
        left_response_seconds: body.left_response_seconds,
        right_response_seconds: body.right_response_seconds,
        offdeltas: body.offdeltas,
        token_ids: body.token_ids.into_iter().map(U256::from).collect(),
        transformers: body
            .transformers
            .into_iter()
            .map(|clause| {
                Ok(TransformerClause {
                    transformer_address: clause.transformer_address,
                    encoded_batch: clause.encoded_batch,
                    allowances: clause
                        .allowances
                        .into_iter()
                        .map(|allowance| {
                            Ok(Allowance {
                                delta_index: U256::from(allowance.delta_index),
                                right_allowance: nonnegative_u256(
                                    &allowance.right_allowance,
                                    "rightAllowance",
                                )?,
                                left_allowance: nonnegative_u256(
                                    &allowance.left_allowance,
                                    "leftAllowance",
                                )?,
                            })
                        })
                        .collect::<Result<Vec<_>, JBatchError>>()?,
                })
            })
            .collect::<Result<Vec<_>, JBatchError>>()?,
    })
}

fn fixed_hex<const N: usize>(value: &str, field: &'static str) -> Result<[u8; N], JBatchError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == N * 2)
        .ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))?;
    let bytes = payload.as_bytes();
    let mut output = [0_u8; N];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let nibble = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        output[index] =
            (nibble(pair[0]).ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))? << 4)
                | nibble(pair[1]).ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))?;
    }
    Ok(output)
}

fn hex_bytes(value: &str, field: &'static str) -> Result<Vec<u8>, JBatchError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() % 2 == 0)
        .ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))?;
    payload
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Ok(
                (nibble(pair[0]).ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))? << 4)
                    | nibble(pair[1]).ok_or_else(|| JBatchError::Abi(format!("{field}:hex")))?,
            )
        })
        .collect()
}

/// Canonical watcher/replay projection of the same Depository `ProofBody`.
/// The event type stores boundary strings; after this one conversion both the
/// event and the resident Account are hashed by `encode_proof_body` below.
pub fn proof_body_from_j_event(
    body: &xln_rscore_engine::ProofBody,
) -> Result<ProofBody, JBatchError> {
    Ok(ProofBody {
        watch_seed: fixed_hex(&body.watch_seed, "watchSeed")?,
        left_response_seconds: u32::try_from(body.left_response_seconds)
            .map_err(|_| JBatchError::Abi("leftResponseSeconds:width".into()))?,
        right_response_seconds: u32::try_from(body.right_response_seconds)
            .map_err(|_| JBatchError::Abi("rightResponseSeconds:width".into()))?,
        offdeltas: body.offdeltas.clone(),
        token_ids: body
            .token_ids
            .iter()
            .map(|value| nonnegative_u256(value, "tokenId"))
            .collect::<Result<Vec<_>, _>>()?,
        transformers: body
            .transformers
            .iter()
            .map(|clause| {
                Ok(TransformerClause {
                    transformer_address: fixed_hex(
                        &clause.transformer_address,
                        "transformerAddress",
                    )?,
                    encoded_batch: hex_bytes(&clause.encoded_batch, "encodedBatch")?,
                    allowances: clause
                        .allowances
                        .iter()
                        .map(|allowance| {
                            Ok(Allowance {
                                delta_index: nonnegative_u256(
                                    &allowance.delta_index,
                                    "deltaIndex",
                                )?,
                                right_allowance: nonnegative_u256(
                                    &allowance.right_allowance,
                                    "rightAllowance",
                                )?,
                                left_allowance: nonnegative_u256(
                                    &allowance.left_allowance,
                                    "leftAllowance",
                                )?,
                            })
                        })
                        .collect::<Result<Vec<_>, JBatchError>>()?,
                })
            })
            .collect::<Result<Vec<_>, JBatchError>>()?,
    })
}

pub fn proof_body_hash(body: &ProofBody) -> Result<[u8; 32], JBatchError> {
    use sha3::{Digest, Keccak256};
    Ok(Keccak256::digest(encode_proof_body(body)?).into())
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JSubmitError {
    #[error("RSCORE_J_BATCH:{0}")]
    Batch(&'static str),
    #[error("RSCORE_J_ABI:{0}")]
    Abi(String),
}

pub use JSubmitError as JBatchError;
