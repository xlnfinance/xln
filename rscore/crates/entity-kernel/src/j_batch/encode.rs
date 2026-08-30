use ethabi::Token;
use ethabi::ethereum_types::{H160, U256};
use num_bigint::{BigInt, BigUint, Sign};

use super::JSubmitError;
use super::types::*;

const MAX_BATCH_BYTES: usize = 256 * 1024;
const MAX_BATCH_OPS: usize = 50;

fn tuple(values: impl IntoIterator<Item = Token>) -> Token {
    Token::Tuple(values.into_iter().collect())
}
fn array(values: impl IntoIterator<Item = Token>) -> Token {
    Token::Array(values.into_iter().collect())
}
fn uint(value: U256) -> Token {
    Token::Uint(value)
}
fn fixed(bytes: &[u8]) -> Token {
    Token::FixedBytes(bytes.to_vec())
}
fn address(value: &Address) -> Token {
    Token::Address(H160::from_slice(value))
}

fn signed(value: &BigInt) -> Result<Token, JSubmitError> {
    let limit = BigInt::from(1_u8) << 255_u32;
    if value < &-limit.clone() || value >= &limit {
        return Err(JSubmitError::Batch("int256-range"));
    }
    let bits: BigUint = if value.sign() == Sign::Minus {
        ((BigInt::from(1_u8) << 256_u32) + value)
            .to_biguint()
            .ok_or(JSubmitError::Batch("int256-negative"))?
    } else {
        value.to_biguint().ok_or(JSubmitError::Batch("int256"))?
    };
    let bytes = bits.to_bytes_be();
    if bytes.len() > 32 {
        return Err(JSubmitError::Batch("int256-width"));
    }
    Ok(Token::Int(U256::from_big_endian(&bytes)))
}

pub(crate) fn proof_body_token(body: &ProofBody) -> Result<Token, JSubmitError> {
    Ok(tuple([
        fixed(&body.watch_seed),
        uint(U256::from(body.left_response_seconds)),
        uint(U256::from(body.right_response_seconds)),
        array(
            body.offdeltas
                .iter()
                .map(signed)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(body.token_ids.iter().copied().map(uint)),
        array(body.transformers.iter().map(|clause| {
            tuple([
                address(&clause.transformer_address),
                Token::Bytes(clause.encoded_batch.clone()),
                array(clause.allowances.iter().map(|allowance| {
                    tuple([
                        uint(allowance.delta_index),
                        uint(allowance.right_allowance),
                        uint(allowance.left_allowance),
                    ])
                })),
            ])
        })),
    ]))
}

fn validate_limits(batch: &JBatch) -> Result<(), JSubmitError> {
    let total = batch.flashloans.len()
        + batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len();
    if total > MAX_BATCH_OPS {
        return Err(JSubmitError::Batch("operation-limit"));
    }
    if batch.flashloans.len() > 8
        || batch.settlements.len() > 32
        || batch.dispute_starts.len() > 8
        || batch.counter_disputes.len() > 8
        || batch.dispute_finalizations.len() > 1
        || batch.reveal_secrets.len() > 32
        || batch.hash_ladder_registrations.len() > 32
    {
        return Err(JSubmitError::Batch("section-limit"));
    }
    if batch
        .settlements
        .iter()
        .any(|value| value.diffs.len() > 32 || value.forgive_debts_in_token_ids.len() > 32)
        || batch
            .reserve_to_collateral
            .iter()
            .any(|value| value.pairs.is_empty() || value.pairs.len() > 64)
        || batch
            .reserve_to_collateral
            .iter()
            .map(|value| value.pairs.len())
            .sum::<usize>()
            > 256
    {
        return Err(JSubmitError::Batch("nested-limit"));
    }
    Ok(())
}

pub(crate) fn batch_token(batch: &JBatch) -> Result<Token, JSubmitError> {
    validate_limits(batch)?;
    Ok(tuple([
        array(
            batch
                .flashloans
                .iter()
                .map(|v| tuple([uint(v.token_id), uint(v.amount)])),
        ),
        array(
            batch
                .reserve_to_reserve
                .iter()
                .map(|v| tuple([fixed(&v.receiving_entity), uint(v.token_id), uint(v.amount)])),
        ),
        array(batch.reserve_to_collateral.iter().map(|v| {
            tuple([
                uint(v.token_id),
                fixed(&v.receiving_entity),
                array(
                    v.pairs
                        .iter()
                        .map(|p| tuple([fixed(&p.entity), uint(p.amount)])),
                ),
            ])
        })),
        array(batch.collateral_to_reserve.iter().map(|v| {
            tuple([
                fixed(&v.counterparty),
                uint(v.token_id),
                uint(v.amount),
                uint(v.nonce),
                Token::Bytes(v.sig.clone()),
            ])
        })),
        array(
            batch
                .settlements
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.left_entity),
                        fixed(&v.right_entity),
                        array(
                            v.diffs
                                .iter()
                                .map(|d| -> Result<Token, JSubmitError> {
                                    Ok(tuple([
                                        uint(d.token_id),
                                        signed(&d.left_diff)?,
                                        signed(&d.right_diff)?,
                                        signed(&d.collateral_diff)?,
                                        signed(&d.ondelta_diff)?,
                                    ]))
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ),
                        array(v.forgive_debts_in_token_ids.iter().copied().map(uint)),
                        Token::Bytes(v.sig.clone()),
                        uint(v.nonce),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .dispute_starts
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.counterentity),
                        uint(v.nonce),
                        Token::Bool(v.proposer_is_left),
                        fixed(&v.proofbody_hash),
                        proof_body_token(&v.initial_proofbody)?,
                        fixed(&v.watch_seed),
                        Token::Bytes(v.sig.clone()),
                        Token::Bytes(v.starter_initial_arguments.clone()),
                        Token::Bytes(v.starter_counter_arguments.clone()),
                        fixed(&v.starter_counter_proof_commitment),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .counter_disputes
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.counterentity),
                        uint(v.initial_nonce),
                        fixed(&v.initial_proofbody_hash),
                        uint(v.counter_nonce),
                        Token::Bool(v.proposer_is_left),
                        proof_body_token(&v.counter_proofbody)?,
                        Token::Bytes(v.sig.clone()),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .dispute_finalizations
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.counterentity),
                        uint(v.initial_nonce),
                        uint(v.final_nonce),
                        Token::Bool(v.proposer_is_left),
                        fixed(&v.initial_proofbody_hash),
                        proof_body_token(&v.final_proofbody)?,
                        Token::Bytes(v.starter_arguments.clone()),
                        Token::Bytes(v.other_arguments.clone()),
                        Token::Bytes(v.sig.clone()),
                        Token::Bool(v.started_by_left),
                        Token::Bool(v.cooperative),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(batch.external_token_to_reserve.iter().map(|v| {
            tuple([
                fixed(&v.entity),
                address(&v.contract_address),
                uint(v.external_token_id),
                uint(U256::from(v.token_type)),
                uint(v.internal_token_id),
                uint(v.amount),
            ])
        })),
        array(
            batch
                .reserve_to_external_token
                .iter()
                .map(|v| tuple([fixed(&v.receiving_entity), uint(v.token_id), uint(v.amount)])),
        ),
        array(
            batch
                .reveal_secrets
                .iter()
                .map(|v| tuple([address(&v.transformer), fixed(&v.secret)])),
        ),
        array(batch.hash_ladder_registrations.iter().map(|v| {
            tuple([
                fixed(&v.counterparty_entity),
                Token::Bool(v.target_role),
                fixed(&v.full_hash),
                fixed(&v.partial_root),
                tuple([
                    uint(U256::from(v.witness.fill_ratio)),
                    fixed(&v.witness.full_secret),
                    Token::FixedArray(v.witness.reveals.iter().map(|r| fixed(r)).collect()),
                ]),
            ])
        })),
    ]))
}

pub fn encode_j_batch(batch: &JBatch) -> Result<Vec<u8>, JSubmitError> {
    let encoded = ethabi::encode(&[batch_token(batch)?]);
    if encoded.len() > MAX_BATCH_BYTES {
        return Err(JSubmitError::Batch("encoded-byte-limit"));
    }
    Ok(encoded)
}

pub fn encode_proof_body(body: &ProofBody) -> Result<Vec<u8>, JSubmitError> {
    Ok(ethabi::encode(&[proof_body_token(body)?]))
}
