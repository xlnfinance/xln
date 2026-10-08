//! Native TriggerSmartContract signing. The node supplies only a TAPOS head;
//! owner, contract, calldata and fee are constructed locally before signing.
use super::{Address, JSubmitError, Word};
use crate::j_watcher::JsonRpc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use xln_rscore_crypto::{address_of_private_key, sign_digest};

fn uint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
fn number(out: &mut Vec<u8>, field: u64, value: u64) {
    uint(out, field << 3);
    uint(out, value);
}
fn bytes(out: &mut Vec<u8>, field: u64, value: &[u8]) {
    uint(out, (field << 3) | 2);
    uint(out, value.len() as u64);
    out.extend_from_slice(value);
}
fn address(value: &Address) -> Vec<u8> {
    let mut out = vec![0x41];
    out.extend_from_slice(value);
    out
}
fn call(rpc: &dyn JsonRpc, method: &str, value: Value) -> Result<Value, JSubmitError> {
    rpc.tron_call(method, value)
        .map_err(|e| JSubmitError::Rpc(e.to_string()))
}

pub(super) fn sign_call(
    head: &Value,
    to: &Address,
    data: &[u8],
    fee: u64,
    key: &Word,
) -> Result<(Vec<u8>, Word), JSubmitError> {
    let fail = || JSubmitError::Transaction("tron-head");
    let height = head
        .pointer("/block_header/raw_data/number")
        .and_then(Value::as_u64)
        .ok_or_else(fail)?;
    let timestamp = head
        .pointer("/block_header/raw_data/timestamp")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v <= i64::MAX as u64 - 60_000)
        .ok_or_else(fail)?;
    let block = head
        .get("blockID")
        .and_then(Value::as_str)
        .and_then(|v| hex::decode(v).ok())
        .filter(|v| v.len() == 32)
        .ok_or_else(fail)?;
    if block[..8] != height.to_be_bytes() || fee == 0 || fee > 15_000_000_000 || data.len() < 4 {
        return Err(JSubmitError::Transaction("tron-call"));
    }
    let owner = address_of_private_key(key).ok_or(JSubmitError::Transaction("operator-key"))?;
    let mut trigger = Vec::new();
    bytes(&mut trigger, 1, &address(&owner));
    bytes(&mut trigger, 2, &address(to));
    bytes(&mut trigger, 4, data);
    let mut any = Vec::new();
    bytes(
        &mut any,
        1,
        b"type.googleapis.com/protocol.TriggerSmartContract",
    );
    bytes(&mut any, 2, &trigger);
    let mut contract = Vec::new();
    number(&mut contract, 1, 31);
    bytes(&mut contract, 2, &any);
    let mut raw = Vec::new();
    bytes(&mut raw, 1, &height.to_be_bytes()[6..]);
    bytes(&mut raw, 4, &block[8..16]);
    number(&mut raw, 8, timestamp + 60_000);
    bytes(&mut raw, 11, &contract);
    number(&mut raw, 14, timestamp);
    number(&mut raw, 18, fee);
    let hash: Word = Sha256::digest(&raw).into();
    let mut signature = sign_digest(key, &hash).ok_or(JSubmitError::Transaction("sign"))?;
    // TronWeb wire signatures use the legacy 27/28 recovery byte.
    signature[64] += 27;
    let mut signed = Vec::new();
    bytes(&mut signed, 1, &raw);
    bytes(&mut signed, 2, &signature);
    Ok((signed, hash))
}

pub(super) fn prepare(
    rpc: &dyn JsonRpc,
    to: &Address,
    data: &[u8],
    key: &Word,
    headroom: u32,
) -> Result<String, JSubmitError> {
    let owner = address_of_private_key(key).ok_or(JSubmitError::Transaction("operator-key"))?;
    let estimate = call(
        rpc,
        "estimateenergy",
        json!({"owner_address":hex::encode(address(&owner)), "contract_address":hex::encode(address(to)), "data":hex::encode(data), "visible":false}),
    )?;
    if estimate.pointer("/result/result").and_then(Value::as_bool) != Some(true) {
        return Err(JSubmitError::Rpc(format!(
            "tron-energy-estimate:{estimate}"
        )));
    }
    let energy = estimate
        .get("energy_required")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .ok_or(JSubmitError::Transaction("tron-energy"))?;
    let parameters = call(rpc, "getchainparameters", json!({}))?;
    let price = parameters
        .get("chainParameter")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|r| r.get("key").and_then(Value::as_str) == Some("getEnergyFee"))
        })
        .and_then(|r| r.get("value"))
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .ok_or(JSubmitError::Transaction("tron-energy-price"))?;
    let fee = energy
        .checked_mul(headroom as u64)
        .and_then(|v| v.checked_add(9999))
        .map(|v| v / 10000)
        .and_then(|v| v.checked_mul(price))
        .ok_or(JSubmitError::Transaction("tron-fee-overflow"))?;
    let head = call(rpc, "getnowblock", json!({}))?;
    super::native_expiry::bind_rpc_header(rpc, &head)?;
    let (signed, _) = sign_call(&head, to, data, fee, key)?;
    Ok(format!("0x{}", hex::encode(signed)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_tron_signed_call_matches_tronweb_protobuf_and_signature() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/tron-signed-call-v1.json"
        ))
        .unwrap();
        let key: Word = hex::decode(fixture["key"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let to: Address = hex::decode(fixture["to"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let data = hex::decode(fixture["data"].as_str().unwrap()).unwrap();
        let (raw, hash) = sign_call(
            &fixture["head"],
            &to,
            &data,
            fixture["fee"].as_u64().unwrap(),
            &key,
        )
        .unwrap();
        assert_eq!(hex::encode(raw), fixture["raw"].as_str().unwrap());
        assert_eq!(hex::encode(hash), fixture["hash"].as_str().unwrap());
        let mut wrong = fixture["head"].clone();
        wrong["block_header"]["raw_data"]["number"] = json!(
            fixture["head"]["block_header"]["raw_data"]["number"]
                .as_u64()
                .unwrap()
                + 1
        );
        assert!(sign_call(&wrong, &to, &data, 1000, &key).is_err());
        assert!(sign_call(&fixture["head"], &to, &data, 15_000_000_001, &key).is_err());
    }
}
