//! Native TRON receipts are RPC-attested, never Ethereum receipt-trie proofs.
//! The committed JReplica policy selects this path; the solidified block range,
//! complete ordered receipts and an independent getLogs read bind the event set.
use super::abi::hex;
use super::receipt::{fixed_hex, parse_hex, safe_u64, validate_receipt_set, validate_receipts};
use super::types::{JWatcherConfig, JWatcherError, JsonRpc, RpcBlock, RpcLog, RpcReceipt};
use serde_json::json;
use std::collections::BTreeSet;

fn log_key(log: &RpcLog) -> Result<String, JWatcherError> {
    if log.removed == Some(true) {
        return Err(JWatcherError::RemovedLog);
    }
    let index = log
        .log_index
        .as_ref()
        .or(log.index.as_ref())
        .ok_or(JWatcherError::Quantity("logIndex"))?;
    let topics = log
        .topics
        .iter()
        .map(|value| fixed_hex::<32>(value, "topic").map(|v| hex(&v)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        hex(&fixed_hex::<20>(&log.address, "address")?),
        topics.join(","),
        hex(&parse_hex(&log.data, None, "data")?),
        safe_u64(&log.block_number, "blockNumber")?,
        hex(&fixed_hex::<32>(&log.block_hash, "blockHash")?),
        hex(&fixed_hex::<32>(&log.transaction_hash, "transactionHash")?),
        safe_u64(&log.transaction_index, "transactionIndex")?,
        safe_u64(index, "logIndex")?
    ))
}

pub(super) fn authenticate_receipts(
    block: &RpcBlock,
    receipts: &mut [RpcReceipt],
    logs: &[RpcLog],
    addresses: &BTreeSet<[u8; 20]>,
) -> Result<(), JWatcherError> {
    validate_receipt_set(block, receipts)?;
    // A real nonzero root must still verify, as in the TS native adapter.
    if fixed_hex::<32>(&block.receipts_root, "receiptsRoot")? != [0; 32] {
        validate_receipts(block, receipts)?;
    }
    let mut expected = Vec::new();
    for receipt in receipts.iter() {
        for log in &receipt.logs {
            if addresses.contains(&fixed_hex::<20>(&log.address, "address")?) {
                expected.push(log_key(log)?);
            }
        }
    }
    let mut actual = Vec::new();
    for log in logs {
        if !addresses.contains(&fixed_hex::<20>(&log.address, "address")?) {
            return Err(JWatcherError::RpcResponse("TRON_UNWATCHED_LOG".into()));
        }
        actual.push(log_key(log)?);
    }
    expected.sort();
    actual.sort();
    if expected != actual {
        return Err(JWatcherError::RpcResponse(
            "TRON_LOG_CROSSCHECK_MISMATCH".into(),
        ));
    }
    Ok(())
}

pub(super) fn read_receipts(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    block: &RpcBlock,
) -> Result<Vec<RpcReceipt>, JWatcherError> {
    let height = safe_u64(&block.number, "blockNumber")?;
    let mut receipts: Vec<RpcReceipt> =
        serde_json::from_value(rpc.call("eth_getBlockReceipts", json!([format!("0x{height:x}")]))?)
            .map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
    let addresses = config
        .erc20_tokens
        .keys()
        .copied()
        .chain([config.depository_address, config.entity_provider_address])
        .collect::<BTreeSet<_>>();
    let logs: Vec<RpcLog> = serde_json::from_value(rpc.call(
        "eth_getLogs",
        json!([{
            "fromBlock":format!("0x{height:x}"),"toBlock":format!("0x{height:x}"),
            "address":addresses.iter().map(|v|hex(v)).collect::<Vec<_>>()
        }]),
    )?)
    .map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
    authenticate_receipts(block, &mut receipts, &logs, &addresses)?;
    Ok(receipts)
}

pub(super) fn transport_endpoints(
    row: &serde_json::Map<String, serde_json::Value>,
    rpc: &str,
) -> Result<(String, String), JWatcherError> {
    let path = std::env::var("XLN_JURISDICTIONS_PATH")
        .unwrap_or_else(|_| "jurisdictions/jurisdictions.json".into());
    let bytes =
        std::fs::read(&path).map_err(|e| JWatcherError::Rpc(format!("TRON_CONFIG:{path}:{e}")))?;
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
    let entries = config
        .get("jurisdictions")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_JURISDICTIONS_CONFIG".into()))?;
    let address = row
        .get("contracts")
        .and_then(|v| v.get("depository"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_DEPOSITORY".into()))?;
    let matches = entries
        .values()
        .filter(|v| {
            v.get("chainId") == row.get("chainId")
                && v.get("contracts")
                    .and_then(|v| v.get("depository"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v.eq_ignore_ascii_case(address))
        })
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(JWatcherError::RpcResponse(
            "TRON_TRANSPORT_AMBIGUOUS".into(),
        ));
    }
    let default_host = rpc
        .trim_end_matches('/')
        .strip_suffix("/jsonrpc")
        .unwrap_or(rpc);
    let (full, solid) = if let Some(entry) = matches.first() {
        match entry.get("mode").and_then(|v| v.as_str()) {
            None => (default_host, default_host),
            Some("tron") => {
                let full = entry
                    .get("tronFullHost")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| JWatcherError::RpcResponse("TRON_FULL_HOST".into()))?;
                let solid = entry
                    .get("tronSolidityHost")
                    .and_then(|v| v.as_str())
                    .unwrap_or(full);
                (full, solid)
            }
            Some(_) => {
                return Err(JWatcherError::RpcResponse(
                    "TRON_TRANSPORT_MODE_CONFLICT".into(),
                ));
            }
        }
    } else {
        (default_host, default_host)
    };
    for host in [full, solid] {
        let url = url::Url::parse(host).map_err(|e| JWatcherError::RpcResponse(e.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(JWatcherError::RpcResponse("TRON_HOST_SCHEME".into()));
        }
    }
    Ok((
        full.trim_end_matches('/').to_owned(),
        format!("{}/walletsolidity/getnowblock", solid.trim_end_matches('/')),
    ))
}

pub(super) fn validate_solidified_block(
    native: &serde_json::Value,
    block: &serde_json::Value,
) -> Result<(), JWatcherError> {
    let number = native
        .pointer("/block_header/raw_data/number")
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_SOLIDIFIED_HEIGHT".into()))?;
    let height = safe_u64(number, "solidifiedHeight")?;
    let id = native
        .get("blockID")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_SOLIDIFIED_HASH".into()))?;
    let expected = fixed_hex::<32>(&format!("0x{id}"), "solidifiedHash")?;
    let actual = block
        .get("hash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_SOLIDIFIED_RPC_BLOCK".into()))?;
    let number = block
        .get("number")
        .ok_or_else(|| JWatcherError::RpcResponse("TRON_RPC_HEIGHT".into()))?;
    if fixed_hex::<32>(actual, "blockHash")? != expected
        || safe_u64(number, "blockNumber")? != height
    {
        return Err(JWatcherError::RpcResponse(
            "TRON_SOLIDIFIED_HASH_MISMATCH".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn captured() -> (RpcBlock, Vec<RpcReceipt>, Vec<RpcLog>, BTreeSet<[u8; 20]>) {
        let raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/native-tron-receipts-v1.json"
        ))
        .unwrap();
        let block = serde_json::from_value(raw["block"]["result"].clone()).unwrap();
        let receipts = serde_json::from_value(raw["receipts"]["result"].clone()).unwrap();
        let logs: Vec<RpcLog> = serde_json::from_value(raw["logs"]["result"].clone()).unwrap();
        let addresses = logs
            .iter()
            .map(|log| fixed_hex::<20>(&log.address, "address").unwrap())
            .collect();
        (block, receipts, logs, addresses)
    }
    #[test]
    fn actual_tvm_solidified_head_binds_rpc_hash_and_height() {
        let raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/native-tron-receipts-v1.json"
        ))
        .unwrap();
        let native = &raw["solid"];
        let mut block = raw["solidBlock"]["result"].clone();
        validate_solidified_block(native, &block).unwrap();
        block["number"] = json!("0x11");
        assert!(validate_solidified_block(native, &block).is_err());
        block = raw["solidBlock"]["result"].clone();
        block["hash"] = json!(format!("0x{}", "11".repeat(32)));
        assert!(validate_solidified_block(native, &block).is_err());
    }
    #[test]
    fn actual_tvm_complete_receipts_require_native_policy_and_exact_logs() {
        let (block, mut receipts, logs, addresses) = captured();
        assert_eq!(receipts.len(), 1);
        assert_eq!(logs.len(), 4);
        assert!(matches!(
            validate_receipts(&block, &mut receipts),
            Err(JWatcherError::ReceiptRootMismatch)
        ));
        authenticate_receipts(&block, &mut receipts, &logs, &addresses).unwrap();
        assert!(authenticate_receipts(&block, &mut receipts, &logs[..3], &addresses).is_err());
        let mut doubled = logs.clone();
        doubled.push(logs[0].clone());
        assert!(authenticate_receipts(&block, &mut receipts, &doubled, &addresses).is_err());
        let mut altered = logs.clone();
        altered[0].data.push_str("00");
        assert!(authenticate_receipts(&block, &mut receipts, &altered, &addresses).is_err());
        assert!(authenticate_receipts(&block, &mut [], &logs, &addresses).is_err());
        receipts[0].transaction_hash = format!("0x{}", "11".repeat(32));
        assert!(authenticate_receipts(&block, &mut receipts, &logs, &addresses).is_err());
    }
}
