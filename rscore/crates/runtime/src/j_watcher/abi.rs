use num_bigint::{BigInt, BigUint, Sign};
use xln_rscore_engine::{AccountSettledEvent, EntityId, JEventMetadata, TokenId};

use super::receipt::fixed_hex;
use super::types::{ACCOUNT_SETTLED_TOPIC, JWatcherError, MAX_SAFE_INTEGER, RpcLog};

pub(crate) const RESERVE_UPDATED_TOPIC: &str =
    "0xab4d21442efe134c3d0c087e2b687e9593a1c09176f498d37873210cde052c45";
pub(crate) const SECRET_REVEALED_TOPIC: &str =
    "0x47172349c05bf58f7f6a376def3bbc250cd3295a7eead0290d8fa3531c6ca9fb";
pub(crate) const COUNTER_DISPUTE_REGISTERED_TOPIC: &str =
    "0xdf1d21d89097ae482123e351724eb4c07eb3b9319a0e116643d815958aea1609";
pub(crate) const DEBT_CREATED_TOPIC: &str =
    "0xae767eeb0c57abd46e2e0b422895ba3b89372fbd0510a58f00d996faf66f027d";
pub(crate) const DEBT_ENFORCED_TOPIC: &str =
    "0x1ffe8e6348fe244a8988797c02b57999821149e7b25c9f93a85c77819efdde67";
pub(crate) const DEBT_FORGIVEN_TOPIC: &str =
    "0x0971ac81b80f99fe0089c3fbe4af4fa1148f2ce78bc6345e76b05be73500de1f";
pub(crate) const DISPUTE_FINALIZED_TOPIC: &str =
    "0x6d46d52b5fda2a9055705ba74bf5e95807cfa39decf819cdfeaa14f9b2ba346a";
pub(crate) const DISPUTE_STARTED_TOPIC: &str =
    "0xb3a65f8a2fc99051b8235a54207bb2434556eb7682695e9374cf539c9ba453a7";
pub(crate) const HANKO_BATCH_PROCESSED_TOPIC: &str =
    "0x6ae7376aaf94e00d6598cb4305ba9943f431e6a66da007871ecddb33f054eda3";
pub(crate) const HASH_LADDER_REVEAL_REGISTERED_TOPIC: &str =
    "0x318999442affc3c062a20d25242c7ae308d25ac6512df0b342d2ce54b91a149e";
pub(crate) const FOUNDATION_BOOTSTRAPPED_TOPIC: &str =
    "0xb0887eed9a1aa3118afaf26b345c629ec7b797fb3d121bbd5dd62580b361c9bd";
pub(crate) const ENTITY_REGISTERED_TOPIC: &str =
    "0xc9234525033c1ac098f69b4dc192ce416b13f69ec0b6de127022496be73337fd";
pub(crate) const BOARD_ACTIVATED_TOPIC: &str =
    "0x87d65572891e5985b42b8cf8b7ab8a9d757f3e8bb56af8226e44066a6c7f6b80";
pub(crate) const ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC: &str =
    "0x4786dc81db7a17df666525a369e46949b73ca65024d9a16dfcc2263b013ac583";
pub(crate) const ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC: &str =
    "0x7c041f069bd419a142e2766114ff9890735741ee7041a03f0bf8be52a1c5733a";
pub(crate) const ERC20_TRANSFER_TOPIC: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
pub(crate) const ERC20_APPROVAL_TOPIC: &str =
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContractEventKind {
    AccountSettled,
    ReserveUpdated,
    SecretRevealed,
    DisputeStarted,
    DisputeFinalized,
    CounterDisputeRegistered,
    HashLadderRevealRegistered,
    DebtCreated,
    DebtEnforced,
    DebtForgiven,
    HankoBatchProcessed,
    FoundationBootstrapped,
    EntityRegistered,
    BoardActivated,
    EntityProviderActionExecuted,
    EntityProviderActionCancelled,
    Erc20Transfer,
    Erc20Approval,
}

pub(crate) fn event_kind(log: &RpcLog) -> Result<Option<ContractEventKind>, JWatcherError> {
    let Some(topic) = log.topics.first() else {
        return Ok(None);
    };
    fixed_hex::<32>(topic, "logTopic")?;
    let topic = topic.to_ascii_lowercase();
    let kind = match topic.as_str() {
        RESERVE_UPDATED_TOPIC => ContractEventKind::ReserveUpdated,
        SECRET_REVEALED_TOPIC => ContractEventKind::SecretRevealed,
        COUNTER_DISPUTE_REGISTERED_TOPIC => ContractEventKind::CounterDisputeRegistered,
        DEBT_CREATED_TOPIC => ContractEventKind::DebtCreated,
        DEBT_ENFORCED_TOPIC => ContractEventKind::DebtEnforced,
        DEBT_FORGIVEN_TOPIC => ContractEventKind::DebtForgiven,
        DISPUTE_FINALIZED_TOPIC => ContractEventKind::DisputeFinalized,
        DISPUTE_STARTED_TOPIC => ContractEventKind::DisputeStarted,
        HANKO_BATCH_PROCESSED_TOPIC => ContractEventKind::HankoBatchProcessed,
        HASH_LADDER_REVEAL_REGISTERED_TOPIC => ContractEventKind::HashLadderRevealRegistered,
        FOUNDATION_BOOTSTRAPPED_TOPIC => ContractEventKind::FoundationBootstrapped,
        ENTITY_REGISTERED_TOPIC => ContractEventKind::EntityRegistered,
        BOARD_ACTIVATED_TOPIC => ContractEventKind::BoardActivated,
        ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC => ContractEventKind::EntityProviderActionExecuted,
        ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC => ContractEventKind::EntityProviderActionCancelled,
        ERC20_TRANSFER_TOPIC => ContractEventKind::Erc20Transfer,
        ERC20_APPROVAL_TOPIC => ContractEventKind::Erc20Approval,
        _ if fixed_hex::<32>(topic.as_str(), "logTopic")? == ACCOUNT_SETTLED_TOPIC => {
            ContractEventKind::AccountSettled
        }
        _ => return Ok(None),
    };
    Ok(Some(kind))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StaticEventWords {
    pub topics: Vec<[u8; 32]>,
    pub data: Vec<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisputeStartedLog {
    pub sender: EntityId,
    pub counterentity: EntityId,
    pub nonce: BigUint,
    pub proposer_is_left: bool,
    pub proofbody_hash: [u8; 32],
    pub watch_seed: [u8; 32],
    pub starter_initial_arguments: Vec<u8>,
    pub starter_counter_arguments: Vec<u8>,
    pub starter_counter_proof_commitment: [u8; 32],
    pub dispute_timeout: u64,
    pub dispute_start_timestamp: u64,
    pub left_response_seconds: u64,
    pub right_response_seconds: u64,
}

fn fixed_token(token: &ethabi::Token, field: &'static str) -> Result<[u8; 32], JWatcherError> {
    let ethabi::Token::FixedBytes(bytes) = token else {
        return Err(JWatcherError::EventAbi(field));
    };
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| JWatcherError::EventAbi(field))
}

fn bytes_token(token: &ethabi::Token, field: &'static str) -> Result<Vec<u8>, JWatcherError> {
    let ethabi::Token::Bytes(bytes) = token else {
        return Err(JWatcherError::EventAbi(field));
    };
    Ok(bytes.clone())
}

fn uint_token(token: &ethabi::Token, field: &'static str) -> Result<BigUint, JWatcherError> {
    let ethabi::Token::Uint(value) = token else {
        return Err(JWatcherError::EventAbi(field));
    };
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    Ok(BigUint::from_bytes_be(&bytes))
}

fn safe_token(token: &ethabi::Token, field: &'static str) -> Result<u64, JWatcherError> {
    let value = uint_token(token, field)?;
    let bytes = value.to_bytes_be();
    if bytes.len() > 8 {
        return Err(JWatcherError::SafeInteger(field));
    }
    let value = bytes
        .iter()
        .fold(0_u64, |total, byte| (total << 8) | u64::from(*byte));
    if value > MAX_SAFE_INTEGER {
        return Err(JWatcherError::SafeInteger(field));
    }
    Ok(value)
}

pub(crate) fn decode_dispute_started(log: &RpcLog) -> Result<DisputeStartedLog, JWatcherError> {
    if log.topics.len() != 4 || event_kind(log)? != Some(ContractEventKind::DisputeStarted) {
        return Err(JWatcherError::EventAbi("disputeStartedTopics"));
    }
    let bytes = super::receipt::parse_hex(&log.data, None, "disputeStartedData")?;
    let params = [
        ethabi::ParamType::Bool,
        ethabi::ParamType::FixedBytes(32),
        ethabi::ParamType::FixedBytes(32),
        ethabi::ParamType::Bytes,
        ethabi::ParamType::Bytes,
        ethabi::ParamType::FixedBytes(32),
        ethabi::ParamType::Uint(256),
        ethabi::ParamType::Uint(256),
        ethabi::ParamType::Uint(32),
        ethabi::ParamType::Uint(32),
    ];
    let values = ethabi::decode(&params, &bytes)
        .map_err(|_| JWatcherError::EventAbi("disputeStartedData"))?;
    if ethabi::encode(&values) != bytes {
        return Err(JWatcherError::EventAbi("disputeStartedCanonical"));
    }
    let proposer_is_left = match &values[0] {
        ethabi::Token::Bool(value) => *value,
        _ => return Err(JWatcherError::EventAbi("proposerIsLeft")),
    };
    Ok(DisputeStartedLog {
        sender: entity_word_value(
            &fixed_hex::<32>(&log.topics[1], "disputeSender")?,
            "disputeSender",
        )?,
        counterentity: entity_word_value(
            &fixed_hex::<32>(&log.topics[2], "disputeCounterentity")?,
            "disputeCounterentity",
        )?,
        nonce: uint(&fixed_hex::<32>(&log.topics[3], "disputeNonce")?),
        proposer_is_left,
        proofbody_hash: fixed_token(&values[1], "proofbodyHash")?,
        watch_seed: fixed_token(&values[2], "watchSeed")?,
        starter_initial_arguments: bytes_token(&values[3], "starterInitialArguments")?,
        starter_counter_arguments: bytes_token(&values[4], "starterCounterArguments")?,
        starter_counter_proof_commitment: fixed_token(&values[5], "starterCounterProofCommitment")?,
        dispute_timeout: safe_token(&values[6], "disputeTimeout")?,
        dispute_start_timestamp: safe_token(&values[7], "disputeStartTimestamp")?,
        left_response_seconds: safe_token(&values[8], "leftResponseSeconds")?,
        right_response_seconds: safe_token(&values[9], "rightResponseSeconds")?,
    })
}

pub(crate) fn decode_static_words(
    log: &RpcLog,
    topic_count: usize,
    data_count: usize,
) -> Result<StaticEventWords, JWatcherError> {
    if log.topics.len() != topic_count + 1 {
        return Err(JWatcherError::EventAbi("topics"));
    }
    let bytes = super::receipt::parse_hex(&log.data, Some(data_count * 32), "eventData")?;
    let topics = log
        .topics
        .iter()
        .skip(1)
        .map(|topic| fixed_hex::<32>(topic, "eventTopic"))
        .collect::<Result<Vec<_>, _>>()?;
    let data = bytes
        .chunks_exact(32)
        .map(|word| word.try_into().map_err(|_| JWatcherError::EventAbi("word")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(StaticEventWords { topics, data })
}

pub(crate) fn uint(word: &[u8; 32]) -> BigUint {
    BigUint::from_bytes_be(word)
}

pub(crate) fn bigint(word: &[u8; 32]) -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, word)
}

pub(crate) fn safe_uint(word: &[u8; 32], field: &'static str) -> Result<u64, JWatcherError> {
    let value = uint(word);
    let raw = value.to_bytes_be();
    if raw.len() > 8 {
        return Err(JWatcherError::SafeInteger(field));
    }
    let result = raw
        .iter()
        .fold(0_u64, |total, byte| (total << 8) | u64::from(*byte));
    if result > MAX_SAFE_INTEGER {
        return Err(JWatcherError::SafeInteger(field));
    }
    Ok(result)
}

pub(crate) fn bool_word(word: &[u8; 32], field: &'static str) -> Result<bool, JWatcherError> {
    match uint(word) {
        value if value == BigUint::from(0_u8) => Ok(false),
        value if value == BigUint::from(1_u8) => Ok(true),
        _ => Err(JWatcherError::EventAbi(field)),
    }
}

pub(crate) fn address_word(
    word: &[u8; 32],
    field: &'static str,
) -> Result<[u8; 20], JWatcherError> {
    if word[..12] != [0_u8; 12] {
        return Err(JWatcherError::EventAbi(field));
    }
    word[12..]
        .try_into()
        .map_err(|_| JWatcherError::EventAbi(field))
}

pub(crate) fn entity_word_value(
    word: &[u8; 32],
    field: &'static str,
) -> Result<EntityId, JWatcherError> {
    EntityId::parse(&hex(word)).map_err(|error| JWatcherError::Account(format!("{field}:{error}")))
}

#[cfg(test)]
mod catalog_tests {
    use sha3::{Digest, Keccak256};

    use super::*;

    #[test]
    fn topics_match_the_canonical_solidity_event_signatures() {
        let vectors = [
            (
                "ReserveUpdated(bytes32,uint256,uint256)",
                RESERVE_UPDATED_TOPIC,
            ),
            (
                "SecretRevealed(bytes32,bytes32,bytes32)",
                SECRET_REVEALED_TOPIC,
            ),
            (
                "CounterDisputeRegistered(bytes32,bytes32,uint256,bool,bytes32)",
                COUNTER_DISPUTE_REGISTERED_TOPIC,
            ),
            (
                "DebtCreated(bytes32,bytes32,uint256,uint256,uint256)",
                DEBT_CREATED_TOPIC,
            ),
            (
                "DebtEnforced(bytes32,bytes32,uint256,uint256,uint256,uint256)",
                DEBT_ENFORCED_TOPIC,
            ),
            (
                "DebtForgiven(bytes32,bytes32,uint256,uint256,uint256)",
                DEBT_FORGIVEN_TOPIC,
            ),
            (
                "DisputeFinalized(bytes32,bytes32,uint256,bytes32,bytes32)",
                DISPUTE_FINALIZED_TOPIC,
            ),
            (
                "DisputeStarted(bytes32,bytes32,uint256,bool,bytes32,bytes32,bytes,bytes,bytes32,uint256,uint256,uint32,uint32)",
                DISPUTE_STARTED_TOPIC,
            ),
            (
                "HankoBatchProcessed(bytes32,bytes32,uint256)",
                HANKO_BATCH_PROCESSED_TOPIC,
            ),
            (
                "HashLadderRevealRegistered(bytes32,bytes32,bytes32,uint16,bytes32,bytes32[4],bool,uint256)",
                HASH_LADDER_REVEAL_REGISTERED_TOPIC,
            ),
            (
                "FoundationBootstrapped(address,bytes32,uint256,uint256)",
                FOUNDATION_BOOTSTRAPPED_TOPIC,
            ),
            (
                "EntityRegistered(bytes32,uint256,bytes32)",
                ENTITY_REGISTERED_TOPIC,
            ),
            (
                "BoardActivated(bytes32,bytes32,bytes32,uint256)",
                BOARD_ACTIVATED_TOPIC,
            ),
            (
                "EntityProviderActionExecuted(bytes32,uint256,bytes32,uint8)",
                ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC,
            ),
            (
                "EntityProviderActionCancelled(bytes32,uint256,bytes32,uint8,bytes32)",
                ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC,
            ),
            ("Transfer(address,address,uint256)", ERC20_TRANSFER_TOPIC),
            ("Approval(address,address,uint256)", ERC20_APPROVAL_TOPIC),
        ];
        for (signature, expected) in vectors {
            assert_eq!(
                format!("0x{}", hex::encode(Keccak256::digest(signature))),
                expected
            );
        }
    }
}

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

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2 + 2);
    value.push_str("0x");
    for byte in bytes {
        value.push(DIGITS[usize::from(byte >> 4)] as char);
        value.push(DIGITS[usize::from(byte & 15)] as char);
    }
    value
}
