//! SolidityNode reads are accepted only while the exact solid block remains fixed.
use super::*;

fn native_call(rpc: &HttpJsonRpc, method: &str, args: Value) -> Result<Value, WalletSnapshotError> {
    rpc.tron_solidity_call(method, args)
        .map_err(|e| error(500, format!("EXTERNAL_WALLET_SNAPSHOT_SOLIDITY:{e}")))
}

pub(super) fn verify_head(rpc: &HttpJsonRpc, block: &Value) -> Result<(), WalletSnapshotError> {
    let native = native_call(rpc, "getnowblock", json!({}))?;
    crate::j_watcher::tron::validate_solidified_block(&native, block)
        .map_err(|e| error(503, format!("EXTERNAL_WALLET_SNAPSHOT_SOURCE_CHANGED:{e}")))
}

pub(super) fn balance(rpc: &HttpJsonRpc, owner: &str) -> Result<String, WalletSnapshotError> {
    let result = native_call(
        rpc,
        "getaccount",
        json!({"address":format!("41{}", &owner[2..]),"visible":false}),
    )?;
    // An absent account is the canonical zero balance; malformed/error objects are not.
    if result.as_object().is_some_and(Map::is_empty) {
        return Ok("0".into());
    }
    if result["address"]
        .as_str()
        .is_none_or(|address| !address.eq_ignore_ascii_case(&format!("41{}", &owner[2..])))
    {
        return Err(error(500, "EXTERNAL_WALLET_SNAPSHOT_SOLIDITY_ACCOUNT"));
    }
    parse_balance(&result)
}

fn parse_balance(result: &Value) -> Result<String, WalletSnapshotError> {
    match result.get("balance") {
        None => Ok("0".into()),
        Some(value) => value
            .as_u64()
            .filter(|n| *n <= i64::MAX as u64)
            .map(|n| n.to_string())
            .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_SOLIDITY_BALANCE")),
    }
}

pub(super) fn token(
    rpc: &HttpJsonRpc,
    owner: &str,
    to: &str,
    data: &str,
) -> Result<Value, WalletSnapshotError> {
    let selector = match data.get(..10) {
        Some("0x70a08231") => "balanceOf(address)",
        Some("0xdd62ed3e") => "allowance(address,address)",
        _ => return Err(error(500, "EXTERNAL_WALLET_SNAPSHOT_SELECTOR")),
    };
    let result = native_call(
        rpc,
        "triggerconstantcontract",
        json!({
            "owner_address":format!("41{}", &owner[2..]),
            "contract_address":format!("41{}", &to[2..]),
            "function_selector":selector,"parameter":&data[10..],"visible":false
        }),
    )?;
    let rows = result["constant_result"].as_array();
    if result.pointer("/result/result").and_then(Value::as_bool) != Some(true)
        || rows.is_none_or(|v| v.len() != 1)
    {
        return Err(error(500, "EXTERNAL_WALLET_SNAPSHOT_SOLIDITY_CALL"));
    }
    let word = result["constant_result"][0]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error(500, "EXTERNAL_WALLET_SNAPSHOT_ABI_UINT_INVALID"))?;
    Ok(json!(format!("0x{word}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn solidity_protobuf_int64_balance_is_exact_and_rejects_invalid_numbers() {
        assert_eq!(
            parse_balance(&json!({"balance":9_007_199_254_740_993u64})).unwrap(),
            "9007199254740993"
        );
        assert_eq!(
            parse_balance(&json!({"balance":i64::MAX})).unwrap(),
            i64::MAX.to_string()
        );
        assert_eq!(parse_balance(&json!({})).unwrap(), "0");
        for value in [
            json!(-1),
            json!(1.5),
            json!(i64::MAX as u64 + 1),
            json!("100"),
        ] {
            assert!(parse_balance(&json!({"balance":value})).is_err());
        }
    }
}
