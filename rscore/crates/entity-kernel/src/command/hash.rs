use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

use super::value::{number, object, object_value, string};
use super::{
    ENTITY_COMMAND_DOMAIN, ENTITY_PROPOSAL_ACTION_DOMAIN, EntityCommandError,
    MAX_ENTITY_COMMAND_BYTES, MAX_ENTITY_COMMAND_TXS, invalid,
};

fn keccak(value: &[u8]) -> String {
    super::value::hex(&Keccak256::digest(value))
}

pub(super) fn assert_txs_shape(txs: &[CanonicalValue]) -> Result<(), EntityCommandError> {
    if txs.is_empty() || txs.len() > MAX_ENTITY_COMMAND_TXS {
        return Err(invalid(format!(
            "ENTITY_COMMAND_TX_COUNT_INVALID:{}",
            txs.len()
        )));
    }
    for tx in txs {
        let entries = object(tx, "tx")?;
        let _ = string(
            super::value::field(entries, "type", "tx")?,
            "ENTITY_COMMAND_TX_INVALID",
        )?;
    }
    let encoded = encode_canonical_consensus_bytes(&txs_preimage(txs))
        .map_err(|error| invalid(format!("ENTITY_COMMAND_ENCODING:{error}")))?;
    if encoded.len() > MAX_ENTITY_COMMAND_BYTES {
        return Err(invalid(format!(
            "ENTITY_COMMAND_BYTE_LIMIT_EXCEEDED:{}:{}",
            encoded.len(),
            MAX_ENTITY_COMMAND_BYTES
        )));
    }
    Ok(())
}

fn txs_preimage(txs: &[CanonicalValue]) -> CanonicalValue {
    object_value(vec![
        (
            "version",
            CanonicalValue::String(ENTITY_COMMAND_DOMAIN.into()),
        ),
        ("txs", CanonicalValue::Array(txs.to_vec())),
    ])
}

pub(super) fn hash_entity_command_txs(
    txs: &[CanonicalValue],
) -> Result<String, EntityCommandError> {
    assert_txs_shape(txs)?;
    let bytes = encode_canonical_consensus_bytes(&txs_preimage(txs))
        .map_err(|error| invalid(format!("ENTITY_COMMAND_ENCODING:{error}")))?;
    Ok(keccak(&bytes))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn hash_entity_command_body(
    version: u8,
    entity_id: &str,
    stack_key: &str,
    board_hash: &str,
    board_epoch: u64,
    author_signer_id: &str,
    author_signer: &str,
    nonce: &BigInt,
    txs_hash: &str,
) -> Result<String, EntityCommandError> {
    let value = object_value(vec![
        (
            "domain",
            CanonicalValue::String(ENTITY_COMMAND_DOMAIN.into()),
        ),
        ("version", number(u64::from(version))?),
        ("entityId", CanonicalValue::String(entity_id.into())),
        ("stackKey", CanonicalValue::String(stack_key.into())),
        ("boardHash", CanonicalValue::String(board_hash.into())),
        ("boardEpoch", number(board_epoch)?),
        (
            "authorSignerId",
            CanonicalValue::String(author_signer_id.into()),
        ),
        ("authorSigner", CanonicalValue::String(author_signer.into())),
        ("nonce", CanonicalValue::BigInt(nonce.clone())),
        ("txsHash", CanonicalValue::String(txs_hash.into())),
    ]);
    let bytes = encode_canonical_consensus_bytes(&value)
        .map_err(|error| invalid(format!("ENTITY_COMMAND_ENCODING:{error}")))?;
    Ok(keccak(&bytes))
}

pub(super) fn hash_collective_action_txs(
    txs: &[CanonicalValue],
) -> Result<String, EntityCommandError> {
    assert_txs_shape(txs)?;
    let value = object_value(vec![
        (
            "domain",
            CanonicalValue::String(ENTITY_PROPOSAL_ACTION_DOMAIN.into()),
        ),
        ("version", number(1)?),
        ("txs", CanonicalValue::Array(txs.to_vec())),
    ]);
    let encoded = encode_canonical_consensus_bytes(&value)
        .map_err(|error| invalid(format!("ENTITY_PROPOSAL_ACTION_ENCODING:{error}")))?;
    if encoded.len() > MAX_ENTITY_COMMAND_BYTES {
        return Err(invalid(format!(
            "ENTITY_COLLECTIVE_ACTION_BYTE_LIMIT_EXCEEDED:{}:{}",
            encoded.len(),
            MAX_ENTITY_COMMAND_BYTES
        )));
    }
    Ok(keccak(&encoded))
}
