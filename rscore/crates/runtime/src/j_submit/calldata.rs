use ethabi::Token;
use ethabi::ethereum_types::U256;
use sha3::{Digest, Keccak256};
use xln_rscore_entity_kernel::j_batch::{
    FinalDisputeProof, JBatch, decode_final_dispute_token, decode_j_batch, final_dispute_param,
};

use super::JSubmitError;
use super::submission::process_batch_calldata;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchtowerCounterDisputeCall {
    pub entity_id: [u8; 32],
    pub proof: FinalDisputeProof,
    pub last_resort_window_seconds: U256,
    pub appointment_sequence: U256,
    pub owner_authorization_hanko: Vec<u8>,
}

pub fn decode_process_batch_calldata(
    calldata: &[u8],
) -> Result<(Vec<u8>, Vec<u8>, U256, JBatch), JSubmitError> {
    let selector = &Keccak256::digest(b"processBatch(bytes,bytes,uint256)")[..4];
    if calldata.len() < 4 || &calldata[..4] != selector {
        return Err(JSubmitError::Transaction("process-batch-selector"));
    }
    let values = ethabi::decode(
        &[
            ethabi::ParamType::Bytes,
            ethabi::ParamType::Bytes,
            ethabi::ParamType::Uint(256),
        ],
        &calldata[4..],
    )
    .map_err(|error| JSubmitError::Rpc(error.to_string()))?;
    let (Token::Bytes(encoded), Token::Bytes(hanko), Token::Uint(nonce)) =
        (&values[0], &values[1], &values[2])
    else {
        return Err(JSubmitError::Transaction("process-batch-arity"));
    };
    if process_batch_calldata(encoded, hanko, *nonce) != calldata {
        return Err(JSubmitError::Transaction("process-batch-non-canonical"));
    }
    let batch = decode_j_batch(encoded)?;
    Ok((encoded.clone(), hanko.clone(), *nonce, batch))
}

pub fn decode_watchtower_counter_dispute_calldata(
    calldata: &[u8],
) -> Result<WatchtowerCounterDisputeCall, JSubmitError> {
    let selector = &Keccak256::digest(
        b"watchtowerCounterDispute(bytes32,(bytes32,uint256,uint256,bool,bytes32,(bytes32,uint32,uint32,int256[],uint256[],(address,bytes,(uint256,uint256,uint256)[])[]),bytes,bytes,bytes,bool,bool),uint256,uint256,bytes)",
    )[..4];
    if calldata.len() < 4 || &calldata[..4] != selector {
        return Err(JSubmitError::Transaction("watchtower-selector"));
    }
    let params = [
        ethabi::ParamType::FixedBytes(32),
        final_dispute_param(),
        ethabi::ParamType::Uint(256),
        ethabi::ParamType::Uint(256),
        ethabi::ParamType::Bytes,
    ];
    let values = ethabi::decode(&params, &calldata[4..])
        .map_err(|error| JSubmitError::Rpc(error.to_string()))?;
    if ethabi::encode(&values) != calldata[4..] {
        return Err(JSubmitError::Transaction("watchtower-non-canonical"));
    }
    let Token::FixedBytes(entity_id) = &values[0] else {
        return Err(JSubmitError::Transaction("watchtower-entity"));
    };
    let Token::Uint(last_resort_window_seconds) = &values[2] else {
        return Err(JSubmitError::Transaction("watchtower-window"));
    };
    let Token::Uint(appointment_sequence) = &values[3] else {
        return Err(JSubmitError::Transaction("watchtower-sequence"));
    };
    let Token::Bytes(owner_authorization_hanko) = &values[4] else {
        return Err(JSubmitError::Transaction("watchtower-hanko"));
    };
    Ok(WatchtowerCounterDisputeCall {
        entity_id: entity_id
            .clone()
            .try_into()
            .map_err(|_| JSubmitError::Transaction("watchtower-entity"))?,
        proof: decode_final_dispute_token(values[1].clone())?,
        last_resort_window_seconds: *last_resort_window_seconds,
        appointment_sequence: *appointment_sequence,
        owner_authorization_hanko: owner_authorization_hanko.clone(),
    })
}
