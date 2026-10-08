//! Post-WAL native RPC attestation. No absence claim is inferred from wall time.
use super::{JSubmitError, prepared_wire::decode_prepared_transaction};
use crate::j_watcher::JsonRpc;
use serde_json::{Value, json};

fn fail(detail: impl ToString) -> JSubmitError {
    JSubmitError::Rpc(format!("TRON_EXPIRY:{}", detail.to_string()))
}
fn header(value: &Value) -> Result<(u64, u64, String), JSubmitError> {
    let fields = value
        .pointer("/block_header/raw_data")
        .ok_or_else(|| fail("HEADER"))?;
    let integer = |key| {
        fields
            .get(key)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .ok_or_else(|| fail(key))
    };
    let height = integer("number")?;
    let timestamp = integer("timestamp")?;
    let hash = value["blockID"]
        .as_str()
        .and_then(|v| hex::decode(v).ok())
        .filter(|v| v.len() == 32 && v[..8] == height.to_be_bytes())
        .ok_or_else(|| fail("BLOCK_ID"))?;
    Ok((height, timestamp, format!("0x{}", hex::encode(hash))))
}
fn rpc_number(value: &Value) -> Result<u64, JSubmitError> {
    value
        .as_str()
        .and_then(|v| v.strip_prefix("0x"))
        .and_then(|v| u64::from_str_radix(v, 16).ok())
        .ok_or_else(|| fail("RPC_NUMBER"))
}
pub(super) fn bind_rpc_header(rpc: &dyn JsonRpc, native: &Value) -> Result<(), JSubmitError> {
    let (height, timestamp, hash) = header(native)?;
    let block = rpc
        .call(
            "eth_getBlockByNumber",
            json!([format!("0x{height:x}"), false]),
        )
        .map_err(fail)?;
    if block["hash"] != hash
        || rpc_number(&block["number"])? != height
        || rpc_number(&block["timestamp"])? != timestamp / 1000
    {
        return Err(fail("RPC_HEADER_MISMATCH"));
    }
    Ok(())
}
pub(super) fn read_expiry_evidence(
    rpc: &dyn JsonRpc,
    raw: &str,
) -> Result<Option<Value>, JSubmitError> {
    if !rpc.tron_rpc_attested() {
        return Ok(None);
    }
    let old = decode_prepared_transaction(raw, true)?;
    let solid = rpc
        .tron_solidity_call("getnowblock", json!({}))
        .map_err(fail)?;
    let (height, timestamp, hash) = header(&solid)?;
    let full = rpc
        .tron_call("getblockbynum", json!({"num":height}))
        .map_err(fail)?;
    if header(&full)? != (height, timestamp, hash.clone()) {
        return Err(fail("SOLID_FULL_HEADER_MISMATCH"));
    }
    bind_rpc_header(rpc, &solid)?;
    if timestamp <= old.expires_at.ok_or_else(|| fail("NATIVE_EXPIRATION"))? {
        return Ok(None);
    }
    let id = hex::encode(old.hash);
    let tx_hash = format!("0x{id}");
    let native = rpc
        .tron_call("gettransactioninfobyid", json!({"value":id}))
        .map_err(fail)?;
    let solid = rpc
        .tron_solidity_call("gettransactioninfobyid", json!({"value":id}))
        .map_err(fail)?;
    let receipt = rpc
        .call("eth_getTransactionReceipt", json!([tx_hash]))
        .map_err(fail)?;
    let exists = !native
        .as_object()
        .ok_or_else(|| fail("RECEIPT_OBJECT"))?
        .is_empty();
    let solid_exists = !solid
        .as_object()
        .ok_or_else(|| fail("SOLID_RECEIPT_OBJECT"))?
        .is_empty();
    if exists == receipt.is_null() || (solid_exists && !exists) {
        return Err(fail("RECEIPT_INDEX_INCONSISTENT"));
    }
    if exists {
        if native["id"] != id
            || receipt["transactionHash"] != tx_hash
            || (solid_exists && solid["id"] != id)
        {
            return Err(fail("RECEIPT_ID_MISMATCH"));
        }
        let included = native["blockNumber"]
            .as_u64()
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            .ok_or_else(|| fail("RECEIPT_BLOCK"))?;
        if rpc_number(&receipt["blockNumber"])? != included || (included <= height && !solid_exists)
        {
            return Err(fail("RECEIPT_INDEX_INCONSISTENT"));
        }
        return Ok(None);
    }
    Ok(Some(
        json!({"oldTransactionHash":tx_hash,"blockNumber":height,"blockHash":hash,"timestamp":timestamp}),
    ))
}
