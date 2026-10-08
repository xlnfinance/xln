//! Public read-only wallet evidence. All balances share one committed-J source height.
use crate::j_watcher::{HttpJsonRpc, JsonRpc};
use num_bigint::BigUint;
use serde_json::{Map, Value, json};
use sha3::{Digest, Keccak256};
use std::collections::BTreeSet;

#[path = "wallet_snapshot_tron.rs"]
mod tron_snapshot;

#[derive(Debug)]
pub struct WalletSnapshotError {
    pub status: u16,
    pub message: String,
}
fn error(status: u16, message: impl Into<String>) -> WalletSnapshotError {
    WalletSnapshotError {
        status,
        message: message.into(),
    }
}
fn address(value: &Value) -> Result<String, WalletSnapshotError> {
    let text = value
        .as_str()
        .ok_or_else(|| error(400, "EXTERNAL_WALLET_SNAPSHOT_ADDRESS_INVALID"))?
        .trim();
    let raw = text
        .strip_prefix("0x")
        .filter(|v| v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error(400, "EXTERNAL_WALLET_SNAPSHOT_ADDRESS_INVALID"))?;
    let lower = raw.to_ascii_lowercase();
    if raw != lower && raw != raw.to_ascii_uppercase() {
        let digest = hex::encode(Keccak256::digest(lower.as_bytes()));
        for (letter, nibble) in raw.bytes().zip(digest.bytes()) {
            let uppercase = (nibble as char).to_digit(16).unwrap_or(0) >= 8;
            if letter.is_ascii_alphabetic() && letter.is_ascii_uppercase() != uppercase {
                return Err(error(400, "EXTERNAL_WALLET_SNAPSHOT_ADDRESS_CHECKSUM"));
            }
        }
    }
    Ok(format!("0x{lower}"))
}
fn array<'a>(body: &'a Value, key: &str) -> Result<&'a [Value], WalletSnapshotError> {
    match body.get(key) {
        None => Ok(&[]),
        Some(Value::Array(rows)) if rows.len() <= 128 => Ok(rows),
        Some(Value::Array(_)) => Err(error(413, "EXTERNAL_WALLET_SNAPSHOT_CARDINALITY_EXCEEDED")),
        _ => Err(error(400, "EXTERNAL_WALLET_SNAPSHOT_FIELD_INVALID")),
    }
}
fn quantity(value: &Value) -> Result<BigUint, WalletSnapshotError> {
    let raw = value
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_RPC_UINT_INVALID"))?;
    BigUint::parse_bytes(raw.as_bytes(), 16)
        .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_RPC_UINT_INVALID"))
}
fn call(rpc: &HttpJsonRpc, method: &str, params: Value) -> Result<Value, WalletSnapshotError> {
    rpc.call(method, params)
        .map_err(|e| error(500, format!("EXTERNAL_WALLET_SNAPSHOT_RPC:{e}")))
}
fn height(value: &Value) -> Result<u64, WalletSnapshotError> {
    quantity(value)?
        .to_string()
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_HEIGHT_INVALID"))
}
fn block_hash(value: &Value) -> Result<String, WalletSnapshotError> {
    value["hash"]
        .as_str()
        .filter(|s| {
            s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .map(str::to_lowercase)
        .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_BLOCK_HASH_MISSING"))
}
fn token_call(
    rpc: &HttpJsonRpc,
    to: &str,
    data: String,
    tag: &str,
    owner: &str,
) -> Result<String, WalletSnapshotError> {
    let result = if rpc.tron_rpc_attested() {
        tron_snapshot::token(rpc, owner, to, &data)?
    } else {
        call(rpc, "eth_call", json!([{ "to":to,"data":data },tag]))?
    };
    // ABI uint256 must be one complete word; empty contract returndata is not zero.
    if result.as_str().map(str::len) != Some(66) {
        return Err(error(500, "EXTERNAL_WALLET_SNAPSHOT_ABI_UINT_INVALID"));
    }
    Ok(quantity(&result)?.to_string())
}
type WalletSnapshotRequest = (String, String, Vec<String>, Vec<(String, String)>);

fn requests(body: &Value, catalog: &[Value]) -> Result<WalletSnapshotRequest, WalletSnapshotError> {
    if !body.is_object() {
        return Err(error(400, "EXTERNAL_WALLET_SNAPSHOT_BODY_INVALID"));
    }
    let entity = body["entityId"]
        .as_str()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| {
            s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .ok_or_else(|| error(400, "Invalid entityId"))?;
    let owner = address(&body["owner"])?;
    let rows = array(body, "tokenAddresses")?;
    let tokens = if rows.is_empty() {
        catalog
            .iter()
            .map(|t| address(&t["address"]))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        rows.iter().map(address).collect::<Result<Vec<_>, _>>()?
    };
    if tokens.len() > 128 {
        return Err(error(413, "EXTERNAL_WALLET_SNAPSHOT_CARDINALITY_EXCEEDED"));
    }
    let mut seen = BTreeSet::new();
    if tokens.iter().any(|t| !seen.insert(t.clone())) {
        return Err(error(400, "EXTERNAL_WALLET_SNAPSHOT_DUPLICATE"));
    }
    let mut allowances = Vec::new();
    let mut pairs = BTreeSet::new();
    for row in array(body, "allowances")? {
        if row.as_object().is_none_or(|m| {
            m.len() != 2 || !m.contains_key("tokenAddress") || !m.contains_key("spender")
        }) {
            return Err(error(
                400,
                "EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_FIELDS_INVALID",
            ));
        }
        let pair = (address(&row["tokenAddress"])?, address(&row["spender"])?);
        if !pairs.insert(pair.clone()) {
            return Err(error(400, "EXTERNAL_WALLET_SNAPSHOT_DUPLICATE"));
        }
        allowances.push(pair);
    }
    Ok((entity, owner, tokens, allowances))
}

pub fn read_wallet_snapshot(
    j: &Map<String, Value>,
    body: &Value,
) -> Result<Value, WalletSnapshotError> {
    let catalog = j
        .get("tokenRegistry")
        .and_then(Value::as_array)
        .ok_or_else(|| error(503, "EXTERNAL_WALLET_SNAPSHOT_TOKEN_REGISTRY"))?;
    let (entity, owner, tokens, allowances) = requests(body, catalog)?;
    let endpoint = j
        .get("rpcs")
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .and_then(Value::as_str)
        .ok_or_else(|| error(503, "EXTERNAL_WALLET_SNAPSHOT_RPC_MISSING"))?;
    let rpc = HttpJsonRpc::for_committed_j(endpoint, j).map_err(|e| error(503, e.to_string()))?;
    let head = height(&call(&rpc, "eth_blockNumber", json!([]))?)?;
    let depth = j
        .get("watcherConfirmationDepth")
        .and_then(Value::as_u64)
        .ok_or_else(|| error(503, "EXTERNAL_WALLET_SNAPSHOT_FINALITY_INVALID"))?;
    let source = head
        .checked_sub(depth)
        .ok_or_else(|| error(503, "EXTERNAL_WALLET_SNAPSHOT_FINALITY_UNAVAILABLE"))?;
    let tag = format!("0x{source:x}");
    let block = call(&rpc, "eth_getBlockByNumber", json!([tag, false]))?;
    if height(&block["number"])? != source {
        return Err(error(500, "EXTERNAL_WALLET_SNAPSHOT_BLOCK_NUMBER"));
    }
    let hash = block_hash(&block)?;
    let native = if rpc.tron_rpc_attested() {
        tron_snapshot::verify_head(&rpc, &block)?;
        tron_snapshot::balance(&rpc, &owner)?
    } else {
        quantity(&call(&rpc, "eth_getBalance", json!([owner, tag]))?)?.to_string()
    };
    let mut token_values = Vec::new();
    let mut token_errors = Vec::new();
    for token in tokens {
        let result = token_call(
            &rpc,
            &token,
            format!("0x70a08231{:0>64}", &owner[2..]),
            &tag,
            &owner,
        );
        let mut row = json!({"tokenAddress":token});
        if let Some(id) = catalog
            .iter()
            .find(|t| {
                t["address"]
                    .as_str()
                    .is_some_and(|a| a.eq_ignore_ascii_case(&token))
            })
            .and_then(|t| t["tokenId"].as_u64())
        {
            row["tokenId"] = json!(id);
        }
        match result {
            Ok(balance) => row["balance"] = json!(balance),
            Err(e) => {
                row["balance"] = json!("0");
                row["error"] = json!(e.message);
                token_errors.push(json!({"tokenAddress":token,"error":e.message}));
            }
        }
        token_values.push(row);
    }
    let mut allowance_values = Vec::new();
    let mut allowance_errors = Vec::new();
    for (token, spender) in allowances {
        let result = token_call(
            &rpc,
            &token,
            format!("0xdd62ed3e{:0>64}{:0>64}", &owner[2..], &spender[2..]),
            &tag,
            &owner,
        );
        let mut row = json!({"tokenAddress":token,"spender":spender});
        match result {
            Ok(amount) => row["allowance"] = json!(amount),
            Err(e) => {
                row["allowance"] = json!("0");
                row["error"] = json!(e.message);
                allowance_errors
                    .push(json!({"tokenAddress":token,"spender":spender,"error":e.message}));
            }
        }
        allowance_values.push(row);
    }
    if rpc.tron_rpc_attested() {
        tron_snapshot::verify_head(&rpc, &block)?;
    }
    // Re-read the pinned block: a reorg during sequential I/O cannot produce a mixed snapshot.
    if block_hash(&call(&rpc, "eth_getBlockByNumber", json!([tag, false]))?)? != hash {
        return Err(error(503, "EXTERNAL_WALLET_SNAPSHOT_SOURCE_CHANGED"));
    }
    let mut result = json!({"success":true,"entityId":entity,"owner":owner,"blockNumber":source,"blockHash":hash,
        "headBlockNumber":head,"sourceHeight":source,"sourceHash":hash,"finalityDepth":depth,
        "transactionHash":format!("external-wallet-snapshot:{source}:{entity}:{owner}"),
        "nativeBalance":native,"tokenBalances":token_values,"allowances":allowance_values});
    if !token_errors.is_empty() {
        result["tokenErrors"] = json!(token_errors);
    }
    if !allowance_errors.is_empty() {
        result["allowanceErrors"] = json!(allowance_errors);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "wallet_snapshot_tests.rs"]
mod tests;
