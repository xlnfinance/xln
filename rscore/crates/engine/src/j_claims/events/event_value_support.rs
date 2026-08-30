use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::event_types::{
    ExternalAllowance, ExternalTokenBalance, JEventMetadata, ProofAllowance, ProofBody,
    ProofTransformerClause,
};
use super::events::{MAX_SAFE_INTEGER, validate_metadata};
use crate::StateError;
use crate::j_claims::codec::j_error;

pub(crate) fn metadata_fields(
    metadata: &JEventMetadata,
) -> Result<Vec<(String, CanonicalValue)>, StateError> {
    validate_metadata(metadata)?;
    let mut fields = Vec::new();
    metadata_push_u64(&mut fields, "blockNumber", metadata.block_number)?;
    metadata_push_hash(&mut fields, "blockHash", metadata.block_hash);
    metadata_push_hash(&mut fields, "transactionHash", metadata.transaction_hash);
    metadata_push_u64(&mut fields, "logIndex", metadata.log_index)?;
    metadata_push_u64(&mut fields, "eventIndex", metadata.event_index)?;
    Ok(fields)
}

pub(crate) fn proof_body(value: &ProofBody) -> Result<CanonicalValue, StateError> {
    Ok(object(vec![
        ("watchSeed", text(&value.watch_seed)),
        (
            "leftResponseSeconds",
            u64_number(value.left_response_seconds)?,
        ),
        (
            "rightResponseSeconds",
            u64_number(value.right_response_seconds)?,
        ),
        (
            "offdeltas",
            CanonicalValue::Array(
                value
                    .offdeltas
                    .iter()
                    .cloned()
                    .map(CanonicalValue::BigInt)
                    .collect(),
            ),
        ),
        (
            "tokenIds",
            CanonicalValue::Array(
                value
                    .token_ids
                    .iter()
                    .cloned()
                    .map(CanonicalValue::BigInt)
                    .collect(),
            ),
        ),
        (
            "transformers",
            CanonicalValue::Array(
                value
                    .transformers
                    .iter()
                    .map(transformer)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
    ]))
}

fn transformer(value: &ProofTransformerClause) -> Result<CanonicalValue, StateError> {
    Ok(object(vec![
        ("transformerAddress", text(&value.transformer_address)),
        ("encodedBatch", text(&value.encoded_batch)),
        (
            "allowances",
            CanonicalValue::Array(value.allowances.iter().map(allowance).collect()),
        ),
    ]))
}

fn allowance(value: &ProofAllowance) -> CanonicalValue {
    object(vec![
        (
            "deltaIndex",
            CanonicalValue::BigInt(value.delta_index.clone()),
        ),
        (
            "rightAllowance",
            CanonicalValue::BigInt(value.right_allowance.clone()),
        ),
        (
            "leftAllowance",
            CanonicalValue::BigInt(value.left_allowance.clone()),
        ),
    ])
}

pub(crate) fn token_balance(value: &ExternalTokenBalance) -> Result<CanonicalValue, StateError> {
    let mut fields = vec![("tokenAddress", address(&value.token_address))];
    push_i64(&mut fields, "tokenId", value.token_id)?;
    fields.push(("balance", text(&value.balance.to_string())));
    Ok(object(fields))
}

pub(crate) fn external_allowance(value: &ExternalAllowance) -> CanonicalValue {
    object(vec![
        ("tokenAddress", address(&value.token_address)),
        ("spender", address(&value.spender)),
        ("allowance", text(&value.allowance.to_string())),
    ])
}

pub(crate) fn object(fields: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    )
}

pub(crate) fn text(value: &str) -> CanonicalValue {
    CanonicalValue::String(value.to_owned())
}

pub(crate) fn boolean(value: bool) -> CanonicalValue {
    CanonicalValue::Bool(value)
}

pub(crate) fn hash(value: &[u8; 32]) -> CanonicalValue {
    text(&crate::state::identity::render_hex(value))
}

pub(crate) fn bytes(value: &[u8]) -> CanonicalValue {
    text(&format!("0x{}", hex::encode(value)))
}

pub(crate) fn address(value: &[u8; 20]) -> CanonicalValue {
    text(&format!("0x{}", hex::encode(value)))
}

pub(crate) fn entity(value: &crate::EntityId) -> CanonicalValue {
    text(&value.as_hex())
}

pub(crate) fn u64_number(value: u64) -> Result<CanonicalValue, StateError> {
    if value > MAX_SAFE_INTEGER {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_SAFE_INTEGER_INVALID:{value}"
        )));
    }
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value)
            .map_err(|error| j_error(format!("ACCOUNT_J_CLAIM_NUMBER_INVALID:{error}")))?,
    ))
}

pub(crate) fn i64_number(value: i64) -> Result<CanonicalValue, StateError> {
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_i64(value)
            .map_err(|error| j_error(format!("ACCOUNT_J_CLAIM_NUMBER_INVALID:{error}")))?,
    ))
}

pub(crate) fn push_i64(
    fields: &mut Vec<(&str, CanonicalValue)>,
    name: &'static str,
    value: Option<i64>,
) -> Result<(), StateError> {
    if let Some(value) = value {
        fields.push((name, i64_number(value)?));
    }
    Ok(())
}

fn metadata_push_hash(
    fields: &mut Vec<(String, CanonicalValue)>,
    name: &str,
    value: Option<[u8; 32]>,
) {
    if let Some(value) = value {
        fields.push((name.into(), hash(&value)));
    }
}

fn metadata_push_u64(
    fields: &mut Vec<(String, CanonicalValue)>,
    name: &str,
    value: Option<u64>,
) -> Result<(), StateError> {
    if let Some(value) = value {
        fields.push((name.into(), u64_number(value)?));
    }
    Ok(())
}
