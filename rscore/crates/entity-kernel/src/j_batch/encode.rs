use ethabi::Token;
use ethabi::ethereum_types::{H160, U256};
use num_bigint::{BigInt, Sign};

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

/// Individual asset movements retain the full uint256 magnitude; zero has one sign.
fn signed_amount(value: &BigInt) -> Result<Token, JSubmitError> {
    let (sign, bytes) = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(JSubmitError::Batch("signed-amount-width"));
    }
    Ok(tuple([
        Token::Bool(sign == Sign::Minus),
        uint(U256::from_big_endian(&bytes)),
    ]))
}

/// The signed proof commits exactly two big-endian two's-complement limbs.
/// This changes the signed ABI: old bodies must never be reinterpreted at a new deployment.
fn int512(value: &BigInt) -> Result<Token, JSubmitError> {
    let bytes = value.to_signed_bytes_be();
    if bytes.len() > 64 {
        return Err(JSubmitError::Batch("int512-width"));
    }
    let mut limbs = [if value.sign() == Sign::Minus { 0xff } else { 0 }; 64];
    limbs[64 - bytes.len()..].copy_from_slice(&bytes);
    Ok(tuple([
        Token::Int(U256::from_big_endian(&limbs[..32])),
        uint(U256::from_big_endian(&limbs[32..])),
    ]))
}

pub(crate) fn proof_body_token(body: &ProofBody) -> Result<Token, JSubmitError> {
    Ok(tuple([
        fixed(&body.watch_seed),
        uint(U256::from(body.left_response_seconds)),
        uint(U256::from(body.right_response_seconds)),
        array(
            body.offdeltas
                .iter()
                .map(int512)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(body.token_ids.iter().copied().map(uint)),
        array(
            body.transformers
                .iter()
                .map(|clause| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        address(&clause.transformer_address),
                        Token::Bytes(clause.encoded_batch.clone()),
                        array(
                            clause
                                .allowances
                                .iter()
                                .map(|allowance| -> Result<Token, JSubmitError> {
                                    Ok(tuple([
                                        uint(allowance.delta_index),
                                        uint(allowance.right_allowance),
                                        uint(allowance.left_allowance),
                                    ]))
                                })
                                .collect::<Result<Vec<_>, JSubmitError>>()?,
                        ),
                    ]))
                })
                .collect::<Result<Vec<_>, JSubmitError>>()?,
        ),
    ]))
}

fn validate_limits(batch: &JBatch) -> Result<(), JSubmitError> {
    let total = batch.reserve_to_reserve.len()
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
    if batch.settlements.len() > 32
        || batch.dispute_starts.len() > super::MAX_DISPUTE_STARTS
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
                .reserve_to_reserve
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.receiving_entity),
                        uint(v.token_id),
                        uint(v.amount),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .reserve_to_collateral
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        uint(v.token_id),
                        fixed(&v.receiving_entity),
                        array(
                            v.pairs
                                .iter()
                                .map(|p| -> Result<Token, JSubmitError> {
                                    Ok(tuple([fixed(&p.entity), uint(p.amount)]))
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .collateral_to_reserve
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.counterparty),
                        uint(v.token_id),
                        uint(v.amount),
                        uint(v.nonce),
                        Token::Bytes(v.sig.clone()),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
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
                                        signed_amount(&d.left_diff)?,
                                        signed_amount(&d.right_diff)?,
                                        signed_amount(&d.collateral_diff)?,
                                        signed_amount(&d.ondelta_diff)?,
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
        array(
            batch
                .external_token_to_reserve
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.entity),
                        address(&v.contract_address),
                        uint(v.external_token_id),
                        uint(U256::from(v.token_type)),
                        uint(v.internal_token_id),
                        uint(v.amount),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        array(
            batch
                .reserve_to_external_token
                .iter()
                .map(|v| -> Result<Token, JSubmitError> {
                    Ok(tuple([
                        fixed(&v.receiving_entity),
                        uint(v.token_id),
                        uint(v.amount),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?,
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
#[cfg(test)]
mod money_abi_tests {
    use super::*;
    use crate::j_batch::decode::decode_j_batch;
    use sha3::{Digest, Keccak256};

    #[test]
    fn reserve_to_reserve_accepts_full_uint256_without_policy_cap() {
        for amount in [U256::zero(), (U256::one() << 200) + 1, U256::MAX] {
            let mut batch = JBatch::default();
            batch.reserve_to_reserve.push(ReserveToReserve {
                receiving_entity: [0x11; 32],
                token_id: 1.into(),
                amount,
            });
            let encoded = encode_j_batch(&batch).expect("full uint256 asset amount");
            assert_eq!(decode_j_batch(&encoded).expect("canonical batch"), batch);
        }
    }

    #[test]
    fn proof_body_int512_extremes_match_compiled_solidity_abi_ethers_oracle() {
        let u: BigInt = (BigInt::from(1) << 256_u32) - 1;
        let b = BigInt::from(1) << 511_u32;
        let body = ProofBody {
            watch_seed: [0; 32],
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: vec![0.into(), u.clone(), -u, &b - 1, -b],
            token_ids: (1..=5).map(U256::from).collect(),
            transformers: Vec::new(),
        };
        let encoded = encode_proof_body(&body).expect("representable proof");
        assert_eq!(encoded.len(), 800);
        // ethers AbiCoder using Account.validateDisputeProofs compiled ABI, 2026-09-06.
        assert_eq!(
            hex::encode(Keccak256::digest(encoded)),
            "f4c441963e0504028c56ea1e53c76b729df07c7b63a4c6aa27dd0a391c538333"
        );
        for outside in [
            BigInt::from(1) << 511_u32,
            -(BigInt::from(1) << 511_u32) - 1,
        ] {
            assert!(int512(&outside).is_err(), "representational proof overflow");
        }
    }

    #[test]
    fn settlement_diff_uses_exact_unsigned_magnitude_and_rejects_negative_zero() {
        let u: BigInt = (BigInt::from(1) << 256_u32) - 1;
        let mut batch = JBatch::default();
        batch.settlements.push(Settlement {
            left_entity: [1; 32],
            right_entity: [2; 32],
            nonce: 1.into(),
            sig: vec![1],
            forgive_debts_in_token_ids: Vec::new(),
            diffs: vec![SettlementDiff {
                token_id: 1.into(),
                left_diff: u.clone(),
                right_diff: -&u,
                collateral_diff: 0.into(),
                ondelta_diff: -u,
            }],
        });
        let encoded = encode_j_batch(&batch).expect("signed full uint256 movements");
        assert_eq!(decode_j_batch(&encoded).expect("roundtrip"), batch);
        assert!(signed_amount(&(BigInt::from(1) << 256_u32)).is_err());
        assert!(signed_amount(&-(BigInt::from(1) << 256_u32)).is_err());
        let Token::Tuple(mut sections) = batch_token(&batch).expect("batch") else {
            panic!("tuple")
        };
        let Token::Array(settlements) = &mut sections[3] else {
            panic!("array")
        };
        let Token::Tuple(settlement) = &mut settlements[0] else {
            panic!("tuple")
        };
        let Token::Array(diffs) = &mut settlement[2] else {
            panic!("array")
        };
        let Token::Tuple(diff) = &mut diffs[0] else {
            panic!("tuple")
        };
        // A signer must have only one encoding for zero; a forged bool sign is rejected.
        diff[3] = tuple([Token::Bool(true), uint(U256::zero())]);
        assert!(decode_j_batch(&ethabi::encode(&[Token::Tuple(sections)])).is_err());
    }
}
