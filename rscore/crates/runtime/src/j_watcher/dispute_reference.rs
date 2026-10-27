//! Content-addressed earlier logs supply bytes omitted from finalization.
use super::abi::{
    COUNTER_DISPUTE_REGISTERED_TOPIC, ContractEventKind, DISPUTE_STARTED_TOPIC, decode_dispute_log,
    decode_dispute_started, event_kind, hex, token_bytes, token_word,
};
use super::receipt::{fixed_hex, safe_u64};
use super::types::{JWatcherConfig, JWatcherError, JsonRpc, RpcLog, RpcReceipt};
use serde_json::json;
use sha3::{Digest, Keccak256};

pub(super) fn read_history(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    receipts: &[RpcReceipt],
) -> Result<Vec<RpcLog>, JWatcherError> {
    let mut history = Vec::new();
    for log in receipts.iter().flat_map(|receipt| &receipt.logs) {
        if fixed_hex::<20>(&log.address, "logAddress")? != config.depository_address
            || log.topics.len() != 4
        {
            continue;
        }
        let local = hex(config.entity_id.as_bytes());
        if log.topics[1].to_lowercase() != local && log.topics[2].to_lowercase() != local {
            continue;
        }
        match event_kind(log)? {
            Some(ContractEventKind::DisputeFinalized) => (),
            Some(ContractEventKind::CounterDisputeRegistered) => {
                let fields = decode_dispute_log(
                    log,
                    &[
                        ethabi::ParamType::Bool,
                        ethabi::ParamType::FixedBytes(32),
                        ethabi::ParamType::Bytes,
                    ],
                )?;
                if !token_bytes(&fields[2])?.is_empty() {
                    continue;
                }
            }
            _ => continue,
        }
        // Both directions are selected at the carrier; hashes below authenticate every recovered byte.
        for (sender, peer) in [
            (&log.topics[1], &log.topics[2]),
            (&log.topics[2], &log.topics[1]),
        ] {
            let response = rpc.call("eth_getLogs", json!([{
                "address": hex(&config.depository_address), "fromBlock": "0x0", "toBlock": log.block_number,
                "topics": [[DISPUTE_STARTED_TOPIC, COUNTER_DISPUTE_REGISTERED_TOPIC], sender, peer]
            }]))?;
            let logs: Vec<RpcLog> = serde_json::from_value(response)
                .map_err(|error| JWatcherError::RpcResponse(error.to_string()))?;
            history.extend(logs);
        }
    }
    history.extend(
        receipts
            .iter()
            .flat_map(|receipt| receipt.logs.iter().cloned()),
    );
    Ok(history)
}

fn earlier_same_pair(source: &RpcLog, final_log: &RpcLog) -> Result<bool, JWatcherError> {
    if source.address.to_lowercase() != final_log.address.to_lowercase()
        || source.topics.len() != 4
        || source.removed == Some(true)
    {
        return Ok(false);
    }
    let first = [&source.topics[1], &source.topics[2]];
    let second = [&final_log.topics[1], &final_log.topics[2]];
    if !(first == second || first == [second[1], second[0]]) {
        return Ok(false);
    }
    let position = |log: &RpcLog| -> Result<(u64, u64), JWatcherError> {
        Ok((
            safe_u64(&log.block_number, "referenceBlock")?,
            safe_u64(
                log.log_index
                    .as_ref()
                    .or(log.index.as_ref())
                    .ok_or(JWatcherError::EventAbi("referenceIndex"))?,
                "referenceIndex",
            )?,
        ))
    };
    Ok(position(source)? < position(final_log)?)
}

pub(super) fn body_bytes(
    log: &RpcLog,
    emitted: &[u8],
    hash: &[u8; 32],
    history: &[RpcLog],
) -> Result<Vec<u8>, JWatcherError> {
    if !emitted.is_empty() {
        return Ok(emitted.to_vec());
    }
    for source in history {
        if !earlier_same_pair(source, log)? {
            continue;
        }
        let (source_hash, bytes) = match event_kind(source)? {
            Some(ContractEventKind::DisputeStarted) => {
                let decoded = decode_dispute_started(source)?;
                (decoded.proofbody_hash, decoded.proofbody)
            }
            Some(ContractEventKind::CounterDisputeRegistered) => {
                let fields = decode_dispute_log(
                    source,
                    &[
                        ethabi::ParamType::Bool,
                        ethabi::ParamType::FixedBytes(32),
                        ethabi::ParamType::Bytes,
                    ],
                )?;
                (token_word(&fields[1])?, token_bytes(&fields[2])?)
            }
            _ => continue,
        };
        if source_hash == *hash && !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    Err(JWatcherError::DisputeEvidence("proofbody-log-missing"))
}

pub(super) fn starter_arguments(
    log: &RpcLog,
    initial_hash: &[u8; 32],
    hash: &[u8; 32],
    history: &[RpcLog],
) -> Result<Vec<u8>, JWatcherError> {
    if <[u8; 32]>::from(Keccak256::digest([])) == *hash {
        return Ok(Vec::new());
    }
    for source in history {
        if !earlier_same_pair(source, log)?
            || source.topics[3] != log.topics[3]
            || event_kind(source)? != Some(ContractEventKind::DisputeStarted)
        {
            continue;
        }
        let decoded = decode_dispute_started(source)?;
        if decoded.proofbody_hash != *initial_hash {
            continue;
        }
        for arguments in [
            decoded.starter_initial_arguments,
            decoded.starter_counter_arguments,
        ] {
            if <[u8; 32]>::from(Keccak256::digest(&arguments)) == *hash {
                return Ok(arguments);
            }
        }
    }
    Err(JWatcherError::DisputeEvidence(
        "starter-arguments-log-missing",
    ))
}
