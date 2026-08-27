use num_bigint::{BigInt, BigUint, Sign};
use xln_rscore_engine::{AccountSettledEvent, EntityId, JEventMetadata, TokenId};

use super::receipt::fixed_hex;
use super::types::{ACCOUNT_SETTLED_TOPIC, JWatcherError, MAX_SAFE_INTEGER, RpcLog};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedSettlement {
    pub left: EntityId,
    pub right: EntityId,
    pub token_id: TokenId,
    pub left_reserve: BigInt,
    pub right_reserve: BigInt,
    pub collateral: BigInt,
    pub ondelta: BigInt,
    pub nonce: u64,
}

pub(crate) fn is_account_settled(log: &RpcLog) -> Result<bool, JWatcherError> {
    let Some(topic) = log.topics.first() else {
        return Ok(false);
    };
    Ok(fixed_hex::<32>(topic, "logTopic")? == ACCOUNT_SETTLED_TOPIC)
}

pub(crate) fn decode_account_settled(
    log: &RpcLog,
) -> Result<Vec<DecodedSettlement>, JWatcherError> {
    if log.topics.len() != 1 || !is_account_settled(log)? {
        return Err(JWatcherError::AccountSettledAbi("topics"));
    }
    let bytes = super::receipt::parse_hex(&log.data, None, "accountSettledData")?;
    let array = offset(&bytes, 0, "rootOffset")?;
    let count = usize_word(&bytes, array, "settlementCount")?;
    let heads = add(array, 32, "settlementHeads")?;
    let mut output = Vec::new();
    for index in 0..count {
        let relative = offset(
            &bytes,
            add(heads, mul(index, 32)?, "settlementOffset")?,
            "settlementOffset",
        )?;
        let base = add(heads, relative, "settlementBase")?;
        output.extend(decode_settlement(&bytes, base)?);
    }
    Ok(output)
}

fn decode_settlement(bytes: &[u8], base: usize) -> Result<Vec<DecodedSettlement>, JWatcherError> {
    let left = entity_word(bytes, base, "left")?;
    let right = entity_word(bytes, add(base, 32, "right")?, "right")?;
    let tokens_offset = offset(bytes, add(base, 64, "tokensOffset")?, "tokensOffset")?;
    let nonce = safe_word(bytes, add(base, 96, "nonce")?, "nonce")?;
    let tokens_base = add(base, tokens_offset, "tokensBase")?;
    let count = usize_word(bytes, tokens_base, "tokenCount")?;
    let rows = add(tokens_base, 32, "tokenRows")?;
    (0..count)
        .map(|index| {
            decode_token(
                bytes,
                add(rows, mul(index, 160)?, "tokenRow")?,
                &left,
                &right,
                nonce,
            )
        })
        .collect()
}

fn decode_token(
    bytes: &[u8],
    base: usize,
    left: &EntityId,
    right: &EntityId,
    nonce: u64,
) -> Result<DecodedSettlement, JWatcherError> {
    let token = unsigned_word(bytes, base, "tokenId")?;
    let token_bytes = token.to_bytes_be();
    if token_bytes.len() > 2 {
        return Err(JWatcherError::AccountSettledToken(token.to_string()));
    }
    let token_value = token_bytes
        .iter()
        .fold(0_u32, |value, byte| (value << 8) | u32::from(*byte));
    let token_id =
        TokenId::new(token_value).map_err(|error| JWatcherError::Account(error.to_string()))?;
    Ok(DecodedSettlement {
        left: left.clone(),
        right: right.clone(),
        token_id,
        left_reserve: unsigned_bigint(bytes, add(base, 32, "leftReserve")?, "leftReserve")?,
        right_reserve: unsigned_bigint(bytes, add(base, 64, "rightReserve")?, "rightReserve")?,
        collateral: unsigned_bigint(bytes, add(base, 96, "collateral")?, "collateral")?,
        ondelta: signed_bigint(bytes, add(base, 128, "ondelta")?, "ondelta")?,
        nonce,
    })
}

pub(crate) fn into_event(
    value: DecodedSettlement,
    block_number: u64,
    block_hash: [u8; 32],
    transaction_hash: [u8; 32],
    log_index: u64,
    event_index: Option<u64>,
) -> AccountSettledEvent {
    AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: Some(block_number),
            block_hash: Some(block_hash),
            transaction_hash: Some(transaction_hash),
            log_index: Some(log_index),
            event_index,
        },
        left_entity: value.left,
        right_entity: value.right,
        token_id: value.token_id,
        left_reserve: value.left_reserve,
        right_reserve: value.right_reserve,
        collateral: value.collateral,
        ondelta: value.ondelta,
        nonce: value.nonce,
    }
}

fn word<'a>(bytes: &'a [u8], start: usize, field: &'static str) -> Result<&'a [u8], JWatcherError> {
    let end = add(start, 32, field)?;
    bytes
        .get(start..end)
        .ok_or(JWatcherError::AccountSettledAbi(field))
}

fn unsigned_word(
    bytes: &[u8],
    start: usize,
    field: &'static str,
) -> Result<BigUint, JWatcherError> {
    Ok(BigUint::from_bytes_be(word(bytes, start, field)?))
}

fn unsigned_bigint(
    bytes: &[u8],
    start: usize,
    field: &'static str,
) -> Result<BigInt, JWatcherError> {
    Ok(BigInt::from_bytes_be(
        Sign::Plus,
        word(bytes, start, field)?,
    ))
}

fn signed_bigint(bytes: &[u8], start: usize, field: &'static str) -> Result<BigInt, JWatcherError> {
    Ok(BigInt::from_signed_bytes_be(word(bytes, start, field)?))
}

fn safe_word(bytes: &[u8], start: usize, field: &'static str) -> Result<u64, JWatcherError> {
    let value = unsigned_word(bytes, start, field)?;
    let raw = value.to_bytes_be();
    if raw.len() > 8 {
        return Err(JWatcherError::AccountSettledNonce(value.to_string()));
    }
    let result = raw
        .iter()
        .fold(0_u64, |total, byte| (total << 8) | u64::from(*byte));
    if result > MAX_SAFE_INTEGER {
        return Err(JWatcherError::AccountSettledNonce(value.to_string()));
    }
    Ok(result)
}

fn usize_word(bytes: &[u8], start: usize, field: &'static str) -> Result<usize, JWatcherError> {
    let value = unsigned_word(bytes, start, field)?;
    let raw = value.to_bytes_be();
    if raw.len() > std::mem::size_of::<usize>() {
        return Err(JWatcherError::AccountSettledAbi(field));
    }
    Ok(raw
        .iter()
        .fold(0_usize, |total, byte| (total << 8) | usize::from(*byte)))
}

fn offset(bytes: &[u8], start: usize, field: &'static str) -> Result<usize, JWatcherError> {
    let value = usize_word(bytes, start, field)?;
    if !value.is_multiple_of(32) {
        return Err(JWatcherError::AccountSettledAbi(field));
    }
    Ok(value)
}

fn entity_word(bytes: &[u8], start: usize, field: &'static str) -> Result<EntityId, JWatcherError> {
    let raw: [u8; 32] = word(bytes, start, field)?
        .try_into()
        .map_err(|_| JWatcherError::AccountSettledAbi(field))?;
    EntityId::parse(&hex(&raw)).map_err(|error| JWatcherError::Account(error.to_string()))
}

fn add(left: usize, right: usize, field: &'static str) -> Result<usize, JWatcherError> {
    left.checked_add(right)
        .ok_or(JWatcherError::AccountSettledAbi(field))
}

fn mul(left: usize, right: usize) -> Result<usize, JWatcherError> {
    left.checked_mul(right)
        .ok_or(JWatcherError::AccountSettledAbi("lengthOverflow"))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2 + 2);
    value.push_str("0x");
    for byte in bytes {
        value.push(DIGITS[usize::from(byte >> 4)] as char);
        value.push(DIGITS[usize::from(byte & 15)] as char);
    }
    value
}
