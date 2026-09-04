use super::schema;
use super::types::*;
use super::{JSubmitError, encode_j_batch};
use ethabi::Token;
use ethabi::ethereum_types::{H160, U256};
use num_bigint::{BigInt, BigUint};

struct Fields(std::vec::IntoIter<Token>);

impl Fields {
    fn new(token: Token) -> Result<Self, JSubmitError> {
        match token {
            Token::Tuple(v) => Ok(Self(v.into_iter())),
            _ => Err(abi("tuple")),
        }
    }
    fn next(&mut self) -> Result<Token, JSubmitError> {
        self.0.next().ok_or_else(|| abi("field"))
    }
    fn done(mut self) -> Result<(), JSubmitError> {
        if self.0.next().is_some() {
            Err(abi("tuple-arity"))
        } else {
            Ok(())
        }
    }
    fn uint(&mut self) -> Result<U256, JSubmitError> {
        as_uint(self.next()?)
    }
    fn word(&mut self) -> Result<Word, JSubmitError> {
        as_word(self.next()?)
    }
    fn address(&mut self) -> Result<Address, JSubmitError> {
        as_address(self.next()?)
    }
    fn bytes(&mut self) -> Result<Vec<u8>, JSubmitError> {
        as_bytes(self.next()?)
    }
    fn bool(&mut self) -> Result<bool, JSubmitError> {
        as_bool(self.next()?)
    }
    fn array(&mut self) -> Result<Vec<Token>, JSubmitError> {
        as_array(self.next()?)
    }
}

fn abi(value: &str) -> JSubmitError {
    JSubmitError::Abi(value.to_string())
}
fn as_uint(token: Token) -> Result<U256, JSubmitError> {
    match token {
        Token::Uint(v) => Ok(v),
        _ => Err(abi("uint")),
    }
}
fn as_word(token: Token) -> Result<Word, JSubmitError> {
    match token {
        Token::FixedBytes(v) if v.len() == 32 => v.try_into().map_err(|_| abi("bytes32")),
        _ => Err(abi("bytes32")),
    }
}
fn as_address(token: Token) -> Result<Address, JSubmitError> {
    match token {
        Token::Address(v) => Ok(address_bytes(v)),
        _ => Err(abi("address")),
    }
}
fn as_bytes(token: Token) -> Result<Vec<u8>, JSubmitError> {
    match token {
        Token::Bytes(v) => Ok(v),
        _ => Err(abi("bytes")),
    }
}
fn as_bool(token: Token) -> Result<bool, JSubmitError> {
    match token {
        Token::Bool(v) => Ok(v),
        _ => Err(abi("bool")),
    }
}
fn as_array(token: Token) -> Result<Vec<Token>, JSubmitError> {
    match token {
        Token::Array(v) | Token::FixedArray(v) => Ok(v),
        _ => Err(abi("array")),
    }
}
fn address_bytes(value: H160) -> Address {
    let mut out = [0; 20];
    out.copy_from_slice(value.as_bytes());
    out
}

fn as_u32(value: U256, name: &'static str) -> Result<u32, JSubmitError> {
    if value > U256::from(u32::MAX) {
        return Err(JSubmitError::Batch(name));
    }
    Ok(value.low_u32())
}
fn as_u16(value: U256, name: &'static str) -> Result<u16, JSubmitError> {
    if value > U256::from(u16::MAX) {
        return Err(JSubmitError::Batch(name));
    }
    Ok(value.low_u32() as u16)
}
fn as_u8(value: U256, name: &'static str) -> Result<u8, JSubmitError> {
    if value > U256::from(u8::MAX) {
        return Err(JSubmitError::Batch(name));
    }
    Ok(value.low_u32() as u8)
}
fn signed(token: Token) -> Result<BigInt, JSubmitError> {
    let Token::Int(value) = token else {
        return Err(abi("int256"));
    };
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    let unsigned = BigUint::from_bytes_be(&bytes);
    let value = BigInt::from(unsigned);
    Ok(if bytes[0] & 0x80 == 0 {
        value
    } else {
        value - (BigInt::from(1_u8) << 256_u32)
    })
}

fn map_tuples<T>(
    tokens: Vec<Token>,
    decode: fn(Fields) -> Result<T, JSubmitError>,
) -> Result<Vec<T>, JSubmitError> {
    tokens
        .into_iter()
        .map(|token| decode(Fields::new(token)?))
        .collect()
}

fn decode_r2r(mut f: Fields) -> Result<ReserveToReserve, JSubmitError> {
    let v = ReserveToReserve {
        receiving_entity: f.word()?,
        token_id: f.uint()?,
        amount: f.uint()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_entity_amount(mut f: Fields) -> Result<EntityAmount, JSubmitError> {
    let v = EntityAmount {
        entity: f.word()?,
        amount: f.uint()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_r2c(mut f: Fields) -> Result<ReserveToCollateral, JSubmitError> {
    let v = ReserveToCollateral {
        token_id: f.uint()?,
        receiving_entity: f.word()?,
        pairs: map_tuples(f.array()?, decode_entity_amount)?,
    };
    f.done()?;
    Ok(v)
}
fn decode_c2r(mut f: Fields) -> Result<CollateralToReserve, JSubmitError> {
    let v = CollateralToReserve {
        counterparty: f.word()?,
        token_id: f.uint()?,
        amount: f.uint()?,
        nonce: f.uint()?,
        sig: f.bytes()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_diff(mut f: Fields) -> Result<SettlementDiff, JSubmitError> {
    let v = SettlementDiff {
        token_id: f.uint()?,
        left_diff: signed(f.next()?)?,
        right_diff: signed(f.next()?)?,
        collateral_diff: signed(f.next()?)?,
        ondelta_diff: signed(f.next()?)?,
    };
    f.done()?;
    Ok(v)
}
fn decode_settlement(mut f: Fields) -> Result<Settlement, JSubmitError> {
    let v = Settlement {
        left_entity: f.word()?,
        right_entity: f.word()?,
        diffs: map_tuples(f.array()?, decode_diff)?,
        forgive_debts_in_token_ids: f
            .array()?
            .into_iter()
            .map(as_uint)
            .collect::<Result<_, _>>()?,
        sig: f.bytes()?,
        nonce: f.uint()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_allowance(mut f: Fields) -> Result<Allowance, JSubmitError> {
    let v = Allowance {
        delta_index: f.uint()?,
        right_allowance: f.uint()?,
        left_allowance: f.uint()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_clause(mut f: Fields) -> Result<TransformerClause, JSubmitError> {
    let v = TransformerClause {
        transformer_address: f.address()?,
        encoded_batch: f.bytes()?,
        allowances: map_tuples(f.array()?, decode_allowance)?,
    };
    f.done()?;
    Ok(v)
}
fn decode_proof(token: Token) -> Result<ProofBody, JSubmitError> {
    let mut f = Fields::new(token)?;
    let watch_seed = f.word()?;
    let left_response_seconds = as_u32(f.uint()?, "left-response-seconds")?;
    let right_response_seconds = as_u32(f.uint()?, "right-response-seconds")?;
    let offdeltas = f
        .array()?
        .into_iter()
        .map(signed)
        .collect::<Result<_, _>>()?;
    let token_ids = f
        .array()?
        .into_iter()
        .map(as_uint)
        .collect::<Result<_, _>>()?;
    let transformers = map_tuples(f.array()?, decode_clause)?;
    f.done()?;
    Ok(ProofBody {
        watch_seed,
        left_response_seconds,
        right_response_seconds,
        offdeltas,
        token_ids,
        transformers,
    })
}
fn decode_start(mut f: Fields) -> Result<InitialDisputeProof, JSubmitError> {
    let v = InitialDisputeProof {
        counterentity: f.word()?,
        nonce: f.uint()?,
        proposer_is_left: f.bool()?,
        proofbody_hash: f.word()?,
        initial_proofbody: decode_proof(f.next()?)?,
        watch_seed: f.word()?,
        sig: f.bytes()?,
        starter_initial_arguments: f.bytes()?,
        starter_counter_arguments: f.bytes()?,
        starter_counter_proof_commitment: f.word()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_counter(mut f: Fields) -> Result<CounterDisputeProof, JSubmitError> {
    let v = CounterDisputeProof {
        counterentity: f.word()?,
        initial_nonce: f.uint()?,
        initial_proofbody_hash: f.word()?,
        counter_nonce: f.uint()?,
        proposer_is_left: f.bool()?,
        counter_proofbody: decode_proof(f.next()?)?,
        sig: f.bytes()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_final(mut f: Fields) -> Result<FinalDisputeProof, JSubmitError> {
    let v = FinalDisputeProof {
        counterentity: f.word()?,
        initial_nonce: f.uint()?,
        final_nonce: f.uint()?,
        proposer_is_left: f.bool()?,
        initial_proofbody_hash: f.word()?,
        final_proofbody: decode_proof(f.next()?)?,
        starter_arguments: f.bytes()?,
        other_arguments: f.bytes()?,
        sig: f.bytes()?,
        started_by_left: f.bool()?,
        cooperative: f.bool()?,
        submit_not_before_timestamp: None,
    };
    f.done()?;
    Ok(v)
}

pub fn decode_final_dispute_token(token: Token) -> Result<FinalDisputeProof, JSubmitError> {
    decode_final(Fields::new(token)?)
}
fn decode_e2r(mut f: Fields) -> Result<ExternalTokenToReserve, JSubmitError> {
    let entity = f.word()?;
    let contract_address = f.address()?;
    let external_token_id = f.uint()?;
    let token_type = as_u8(f.uint()?, "token-type")?;
    let internal_token_id = f.uint()?;
    let amount = f.uint()?;
    f.done()?;
    Ok(ExternalTokenToReserve {
        entity,
        contract_address,
        external_token_id,
        token_type,
        internal_token_id,
        amount,
    })
}
fn decode_r2e(mut f: Fields) -> Result<ReserveToExternalToken, JSubmitError> {
    let v = ReserveToExternalToken {
        receiving_entity: f.word()?,
        token_id: f.uint()?,
        amount: f.uint()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_reveal(mut f: Fields) -> Result<SecretReveal, JSubmitError> {
    let v = SecretReveal {
        transformer: f.address()?,
        secret: f.word()?,
    };
    f.done()?;
    Ok(v)
}
fn decode_ladder(mut f: Fields) -> Result<HashLadderRegistration, JSubmitError> {
    let counterparty_entity = f.word()?;
    let target_role = f.bool()?;
    let full_hash = f.word()?;
    let partial_root = f.word()?;
    let mut witness = Fields::new(f.next()?)?;
    let fill_ratio = as_u16(witness.uint()?, "fill-ratio")?;
    let full_secret = witness.word()?;
    let reveals: [Word; 4] = witness
        .array()?
        .into_iter()
        .map(as_word)
        .collect::<Result<Vec<_>, _>>()?
        .try_into()
        .map_err(|_| abi("reveals-arity"))?;
    witness.done()?;
    f.done()?;
    Ok(HashLadderRegistration {
        counterparty_entity,
        target_role,
        full_hash,
        partial_root,
        witness: HashLadderWitness {
            fill_ratio,
            full_secret,
            reveals,
        },
    })
}

fn batch_from_token(token: Token) -> Result<JBatch, JSubmitError> {
    let mut f = Fields::new(token)?;
    let batch = JBatch {
        reserve_to_reserve: map_tuples(f.array()?, decode_r2r)?,
        reserve_to_collateral: map_tuples(f.array()?, decode_r2c)?,
        collateral_to_reserve: map_tuples(f.array()?, decode_c2r)?,
        settlements: map_tuples(f.array()?, decode_settlement)?,
        dispute_starts: map_tuples(f.array()?, decode_start)?,
        counter_disputes: map_tuples(f.array()?, decode_counter)?,
        dispute_finalizations: map_tuples(f.array()?, decode_final)?,
        external_token_to_reserve: map_tuples(f.array()?, decode_e2r)?,
        reserve_to_external_token: map_tuples(f.array()?, decode_r2e)?,
        reveal_secrets: map_tuples(f.array()?, decode_reveal)?,
        hash_ladder_registrations: map_tuples(f.array()?, decode_ladder)?,
    };
    f.done()?;
    Ok(batch)
}

pub fn decode_j_batch(encoded: &[u8]) -> Result<JBatch, JSubmitError> {
    if encoded.len() > 256 * 1024 {
        return Err(JSubmitError::Batch("encoded-byte-limit"));
    }
    let mut tokens =
        ethabi::decode(&[schema::batch()], encoded).map_err(|e| abi(&e.to_string()))?;
    if tokens.len() != 1 {
        return Err(abi("batch-arity"));
    }
    let batch = batch_from_token(tokens.remove(0))?;
    if encode_j_batch(&batch)? != encoded {
        return Err(abi("non-canonical"));
    }
    Ok(batch)
}
