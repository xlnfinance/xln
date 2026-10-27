//! Content-addressed dispute bytes are committed with the watcher cursor.
use super::abi::{
    COUNTER_DISPUTE_REGISTERED_TOPIC, ContractEventKind, DISPUTE_STARTED_TOPIC, decode_dispute_log,
    decode_dispute_started, event_kind, hex, token_bytes, token_word,
};
use super::receipt::{fixed_hex, parse_hex, safe_u64};
use super::types::{JWatcherConfig, JWatcherError, JsonRpc, RpcLog, RpcReceipt};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisputeReferences {
    pub bodies: BTreeMap<String, ReferenceBytes>,
    pub arguments: BTreeMap<String, ReferenceBytes>,
    pub start_blocks: BTreeMap<String, u64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceBytes {
    pub bytes: String,
    pub block_number: u64,
    pub log_index: u64,
}

impl DisputeReferences {
    pub fn through(&self, height: u64) -> Self {
        Self {
            bodies: self
                .bodies
                .iter()
                .filter(|(_, v)| v.block_number <= height)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            arguments: self
                .arguments
                .iter()
                .filter(|(_, v)| v.block_number <= height)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            start_blocks: self
                .start_blocks
                .iter()
                .filter(|(_, v)| **v <= height)
                .map(|(k, v)| (k.clone(), *v))
                .collect(),
        }
    }
    pub fn merge(&mut self, other: &Self) {
        for (target, source) in [
            (&mut self.bodies, &other.bodies),
            (&mut self.arguments, &other.arguments),
        ] {
            for (key, entry) in source {
                retain(target, key.clone(), entry.clone());
            }
        }
        for (key, height) in &other.start_blocks {
            self.start_blocks
                .entry(key.clone())
                .and_modify(|old| *old = (*old).min(*height))
                .or_insert(*height);
        }
    }
    pub fn validate(&self, height: u64) -> Result<(), JWatcherError> {
        for (map, count) in [(&self.bodies, 3), (&self.arguments, 5)] {
            for (key, entry) in map {
                let parts: Vec<_> = key.split(':').collect();
                if parts.len() != count
                    || parts[0] >= parts[1]
                    || entry.block_number == 0
                    || entry.block_number > height
                    || entry.log_index > super::types::MAX_SAFE_INTEGER
                {
                    return Err(JWatcherError::Cursor);
                }
                for (index, part) in parts.iter().enumerate() {
                    if count == 5 && index == 2 {
                        if part
                            .parse::<num_bigint::BigUint>()
                            .map(|n| n.to_string() != *part)
                            .unwrap_or(true)
                        {
                            return Err(JWatcherError::Cursor);
                        }
                    } else if hex(&fixed_hex::<32>(part, "referenceKey")?) != *part {
                        return Err(JWatcherError::Cursor);
                    }
                }
                let bytes = parse_hex(&entry.bytes, None, "referenceBytes")?;
                if hex(&bytes) != entry.bytes || hex(&Keccak256::digest(bytes)) != parts[count - 1]
                {
                    return Err(JWatcherError::DisputeEvidence("reference-hash"));
                }
            }
        }
        for (key, block) in &self.start_blocks {
            let parts: Vec<_> = key.split(':').collect();
            if parts.len() != 2 || parts[0] >= parts[1] || *block == 0 || *block > height {
                return Err(JWatcherError::Cursor);
            }
            for part in parts {
                if hex(&fixed_hex::<32>(part, "referencePair")?) != part {
                    return Err(JWatcherError::Cursor);
                }
            }
        }
        Ok(())
    }
}
fn pair(log: &RpcLog) -> Result<String, JWatcherError> {
    if log.topics.len() != 4 {
        return Err(JWatcherError::EventAbi("disputeTopics"));
    }
    let mut ids = [
        hex(&fixed_hex::<32>(&log.topics[1], "sender")?),
        hex(&fixed_hex::<32>(&log.topics[2], "peer")?),
    ];
    ids.sort();
    Ok(ids.join(":"))
}
fn position(log: &RpcLog) -> Result<(u64, u64), JWatcherError> {
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
}
fn retain(map: &mut BTreeMap<String, ReferenceBytes>, key: String, value: ReferenceBytes) {
    if map
        .get(&key)
        .is_none_or(|old| (old.block_number, old.log_index) > (value.block_number, value.log_index))
    {
        map.insert(key, value);
    }
}
pub(super) fn remember(state: &mut DisputeReferences, log: &RpcLog) -> Result<(), JWatcherError> {
    let (hash, bytes, start) = match event_kind(log)? {
        Some(ContractEventKind::DisputeStarted) => {
            let start = decode_dispute_started(log)?;
            (start.proofbody_hash, start.proofbody.clone(), Some(start))
        }
        Some(ContractEventKind::CounterDisputeRegistered) => {
            let fields = decode_dispute_log(
                log,
                &[
                    ethabi::ParamType::Bool,
                    ethabi::ParamType::FixedBytes(32),
                    ethabi::ParamType::Bytes,
                ],
            )?;
            (token_word(&fields[1])?, token_bytes(&fields[2])?, None)
        }
        _ => return Ok(()),
    };
    let pair = pair(log)?;
    let (block_number, log_index) = position(log)?;
    if !bytes.is_empty() {
        super::watcher::decode_log_proof_body(&bytes, &hash)?;
        retain(
            &mut state.bodies,
            format!("{pair}:{}", hex(&hash)),
            ReferenceBytes {
                bytes: hex(&bytes),
                block_number,
                log_index,
            },
        );
    }
    if let Some(start) = start {
        state
            .start_blocks
            .entry(pair.clone())
            .and_modify(|old| *old = (*old).min(block_number))
            .or_insert(block_number);
        for bytes in [
            start.starter_initial_arguments,
            start.starter_counter_arguments,
        ] {
            retain(
                &mut state.arguments,
                format!(
                    "{pair}:{}:{}:{}",
                    start.nonce,
                    hex(&hash),
                    hex(&Keccak256::digest(&bytes))
                ),
                ReferenceBytes {
                    bytes: hex(&bytes),
                    block_number,
                    log_index,
                },
            );
        }
    }
    Ok(())
}
pub(super) fn read_history(
    config: &JWatcherConfig,
    receipts: &[RpcReceipt],
    state: &mut DisputeReferences,
) -> Result<(), JWatcherError> {
    for log in receipts.iter().flat_map(|r| &r.logs) {
        if fixed_hex::<20>(&log.address, "logAddress")? != config.depository_address
            || log.topics.len() != 4
        {
            continue;
        }
        let local = hex(config.entity_id.as_bytes());
        if log.topics[1].to_lowercase() == local || log.topics[2].to_lowercase() == local {
            remember(state, log)?;
        }
    }
    Ok(())
}
fn lookup(
    log: &RpcLog,
    map: &BTreeMap<String, ReferenceBytes>,
    key: String,
    missing: &'static str,
) -> Result<Vec<u8>, JWatcherError> {
    if let Some(entry) = map.get(&key) {
        if (entry.block_number, entry.log_index) < position(log)? {
            return parse_hex(&entry.bytes, None, "referenceBytes");
        }
    }
    Err(JWatcherError::DisputeReferenceUnavailable(missing))
}
pub(super) fn body_bytes(
    log: &RpcLog,
    emitted: &[u8],
    hash: &[u8; 32],
    state: &DisputeReferences,
) -> Result<Vec<u8>, JWatcherError> {
    if !emitted.is_empty() {
        return Ok(emitted.to_vec());
    }
    lookup(
        log,
        &state.bodies,
        format!("{}:{}", pair(log)?, hex(hash)),
        "proofbody-log-missing",
    )
}
pub(super) fn starter_arguments(
    log: &RpcLog,
    initial_hash: &[u8; 32],
    hash: &[u8; 32],
    state: &DisputeReferences,
) -> Result<Vec<u8>, JWatcherError> {
    if <[u8; 32]>::from(Keccak256::digest([])) == *hash {
        return Ok(Vec::new());
    }
    let nonce = num_bigint::BigUint::from_bytes_be(&fixed_hex::<32>(&log.topics[3], "nonce")?);
    lookup(
        log,
        &state.arguments,
        format!("{}:{nonce}:{}:{}", pair(log)?, hex(initial_hash), hex(hash)),
        "starter-arguments-log-missing",
    )
}

// A cache miss can query only a recorded dispute interval, in bounded pages.
// No deployment/genesis guess can replace a missing start coordinate.
pub(super) fn refill(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    receipts: &[RpcReceipt],
    state: &mut DisputeReferences,
) -> Result<(), JWatcherError> {
    for log in receipts.iter().flat_map(|r| &r.logs) {
        if fixed_hex::<20>(&log.address, "logAddress")? != config.depository_address
            || !matches!(
                event_kind(log)?,
                Some(
                    ContractEventKind::DisputeFinalized
                        | ContractEventKind::CounterDisputeRegistered
                )
            )
        {
            continue;
        }
        let local = hex(config.entity_id.as_bytes());
        if log.topics.len() != 4
            || (log.topics[1].to_lowercase() != local && log.topics[2].to_lowercase() != local)
        {
            continue;
        }
        let start = *state.start_blocks.get(&pair(log)?).ok_or(
            JWatcherError::DisputeReferenceUnavailable("start-block-missing"),
        )?;
        let end = position(log)?.0;
        for from in (start..=end).step_by(256) {
            let response = rpc.call("eth_getLogs",serde_json::json!([{
                "address":hex(&config.depository_address),"fromBlock":format!("0x{from:x}"),"toBlock":format!("0x{:x}",end.min(from+255)),
                "topics":[[DISPUTE_STARTED_TOPIC,COUNTER_DISPUTE_REGISTERED_TOPIC],[log.topics[1],log.topics[2]],[log.topics[1],log.topics[2]]]
            }]))?;
            let sources: Vec<RpcLog> = serde_json::from_value(response)
                .map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
            for source in sources {
                if source.removed != Some(true)
                    && source.address.eq_ignore_ascii_case(&log.address)
                    && pair(&source)? == pair(log)?
                    && position(&source)? < position(log)?
                {
                    remember(state, &source)?;
                }
            }
        }
    }
    Ok(())
}
