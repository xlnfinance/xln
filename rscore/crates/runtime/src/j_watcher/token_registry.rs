use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::abi::{address_word, safe_uint};
use super::receipt::fixed_hex;
use super::{JWatcherError, JsonRpc};

/// Match rpc-watcher-inputs.ts: the Depository registry defines the complete
/// ERC20 log filter for this range. Never substitute a checkpoint catalog or
/// an empty filter after a failed read: that would permanently skip receipts.
pub(crate) fn read_erc20_token_registry(
    rpc: &impl JsonRpc,
    depository: &[u8; 20],
) -> Result<BTreeMap<[u8; 20], u64>, JWatcherError> {
    let length_call = ethabi::short_signature("getTokensLength", &[]);
    let row_call = ethabi::short_signature("_tokens", &[ethabi::ParamType::Uint(256)]);
    let target = format!("0x{}", hex::encode(depository));
    let length = decode_token_count(&rpc.call(
        "eth_call",
        json!([{"to": target, "data": format!("0x{}", hex::encode(length_call))}, "latest"]),
    )?)?;
    let mut registry = BTreeMap::new();
    // Token zero is the native-currency sentinel. ERC721/ERC1155 rows and the
    // zero address cannot emit the ERC20 transfers this filter selects.
    for token_id in 1..length {
        let row = rpc.call(
            "eth_call",
            json!([{"to": target, "data": format!("0x{}{:064x}", hex::encode(row_call), token_id)}, "latest"]),
        )?;
        if let Some(address) = decode_erc20_token(&row)? {
            registry.insert(address, token_id);
        }
    }
    Ok(registry)
}

pub(super) fn decode_token_count(value: &Value) -> Result<u64, JWatcherError> {
    let encoded = value
        .as_str()
        .ok_or(JWatcherError::Hex("tokenRegistryLength"))?;
    safe_uint(
        &fixed_hex::<32>(encoded, "tokenRegistryLength")?,
        "tokenRegistryLength",
    )
}

pub(super) fn decode_erc20_token(value: &Value) -> Result<Option<[u8; 20]>, JWatcherError> {
    let encoded = value
        .as_str()
        .ok_or(JWatcherError::Hex("tokenRegistryRow"))?;
    let row = fixed_hex::<96>(encoded, "tokenRegistryRow")?;
    let address_word_bytes: [u8; 32] = row[..32]
        .try_into()
        .map_err(|_| JWatcherError::EventAbi("tokenRegistryAddress"))?;
    let address = address_word(&address_word_bytes, "tokenRegistryAddress")?;
    if row[64..95] != [0; 31] {
        return Err(JWatcherError::EventAbi("tokenRegistryType"));
    }
    Ok((row[95] == 0 && address != [0; 20]).then_some(address))
}

/// Live adapter metadata is deliberately absent from canonical checkpoints.
/// Restore it from the same committed contract/transport before serving reads;
/// never put RPC calls into the deterministic replay path.
pub(crate) fn hydrate_live_catalogs(rows: &mut Value) -> Result<(), JWatcherError> {
    let mut hydrated = rows.clone();
    for pair in hydrated
        .as_array_mut()
        .ok_or(JWatcherError::EventAbi("jReplicas"))?
    {
        let row = pair.get_mut(1).ok_or(JWatcherError::EventAbi("jReplica"))?;
        let endpoint = row["rpcs"]
            .as_array()
            .and_then(|v| v.iter().find_map(Value::as_str))
            .ok_or(JWatcherError::EventAbi("tokenRegistryRpc"))?;
        let depository = fixed_hex::<20>(
            row["contracts"]["depository"]
                .as_str()
                .ok_or(JWatcherError::EventAbi("tokenRegistryDepository"))?,
            "tokenRegistryDepository",
        )?;
        let provider = fixed_hex::<20>(
            row["contracts"]["entityProvider"]
                .as_str()
                .ok_or(JWatcherError::EventAbi("tokenRegistryProvider"))?,
            "tokenRegistryProvider",
        )?;
        let rpc = super::HttpJsonRpc::for_committed_j(
            endpoint,
            row.as_object().ok_or(JWatcherError::EventAbi("jReplica"))?,
        )?;
        let catalog = read_token_catalog(&rpc, &depository, &provider)?;
        row.as_object_mut()
            .ok_or(JWatcherError::EventAbi("jReplica"))?
            .insert("tokenRegistry".into(), Value::Array(catalog));
    }
    *rows = hydrated;
    Ok(())
}

fn call_token(
    rpc: &impl JsonRpc,
    target: &[u8; 20],
    data: Vec<u8>,
) -> Result<Value, JWatcherError> {
    rpc.call("eth_call", json!([{"to":format!("0x{}",hex::encode(target)),"data":format!("0x{}",hex::encode(data))},"latest"]))
}

fn read_token_catalog(
    rpc: &impl JsonRpc,
    target: &[u8; 20],
    provider: &[u8; 20],
) -> Result<Vec<Value>, JWatcherError> {
    let length = decode_token_count(&call_token(
        rpc,
        target,
        ethabi::short_signature("getTokensLength", &[]).to_vec(),
    )?)?;
    if length == 0 {
        return Err(JWatcherError::EventAbi("tokenRegistryLength"));
    }
    let mut catalog = Vec::new();
    for id in 1..length {
        let mut data = ethabi::short_signature("_tokens", &[ethabi::ParamType::Uint(256)]).to_vec();
        data.extend(ethabi::encode(&[ethabi::Token::Uint(id.into())]));
        let value = call_token(rpc, target, data)?;
        let row = fixed_hex::<96>(
            value
                .as_str()
                .ok_or(JWatcherError::Hex("tokenRegistryRow"))?,
            "tokenRegistryRow",
        )?;
        let address = address_word(&row[..32].try_into().unwrap(), "tokenRegistryAddress")?;
        let kind = safe_uint(&row[64..].try_into().unwrap(), "tokenRegistryType")?;
        if address == [0; 20] || kind > 2 {
            return Err(JWatcherError::EventAbi("tokenRegistryEntry"));
        }
        let external = ethabi::ethereum_types::U256::from_big_endian(&row[32..64]);
        let (symbol, name, decimals) = if kind == 0 {
            let symbol = read_token_string(rpc, &address, "symbol")?;
            let name = read_token_string(rpc, &address, "name")?;
            let value = call_token(
                rpc,
                &address,
                ethabi::short_signature("decimals", &[]).to_vec(),
            )?;
            let decimals = decode_token_count(&value)?;
            if decimals > 255 {
                return Err(JWatcherError::EventAbi("tokenDecimals"));
            }
            (symbol, name, decimals)
        } else {
            non_fungible_metadata(id, kind, &address, provider, external)?
        };
        catalog.push(json!({"tokenId":id,"tokenType":kind,"externalTokenId":{"__xlnType":"BigInt","value":external.to_string()},"address":checksum_address(&address),"symbol":symbol,"name":name,"decimals":decimals}));
    }
    Ok(catalog)
}

fn checksum_address(address: &[u8; 20]) -> String {
    use sha3::{Digest, Keccak256};
    let lower = hex::encode(address);
    let hash = hex::encode(Keccak256::digest(lower.as_bytes()));
    let checksum: String = lower
        .chars()
        .zip(hash.bytes())
        .map(|(c, h)| if h >= b'8' { c.to_ascii_uppercase() } else { c })
        .collect();
    format!("0x{checksum}")
}

fn read_token_string(
    rpc: &impl JsonRpc,
    address: &[u8; 20],
    method: &str,
) -> Result<String, JWatcherError> {
    let value = call_token(rpc, address, ethabi::short_signature(method, &[]).to_vec())?;
    let text = value
        .as_str()
        .and_then(|v| v.strip_prefix("0x"))
        .ok_or(JWatcherError::Hex("tokenMetadata"))?;
    let bytes = hex::decode(text).map_err(|_| JWatcherError::Hex("tokenMetadata"))?;
    let tokens = ethabi::decode(&[ethabi::ParamType::String], &bytes)
        .map_err(|_| JWatcherError::EventAbi("tokenMetadata"))?;
    match tokens.first() {
        Some(ethabi::Token::String(text)) if !text.trim().is_empty() => Ok(text.trim().to_owned()),
        _ => Err(JWatcherError::EventAbi("tokenMetadata")),
    }
}

fn non_fungible_metadata(
    id: u64,
    kind: u64,
    address: &[u8; 20],
    provider: &[u8; 20],
    external: ethabi::ethereum_types::U256,
) -> Result<(String, String, u64), JWatcherError> {
    use ethabi::ethereum_types::U256;
    if kind == 2 && address == provider {
        let dividend = external.bit(255);
        let number = external & !(U256::one() << 255);
        if number.is_zero() || number >= (U256::one() << 160) {
            return Err(JWatcherError::EventAbi("entityShareTokenId"));
        }
        let (symbol, name) = if dividend {
            ("DIVIDEND", "Dividend")
        } else {
            ("CONTROL", "Control")
        };
        return Ok((
            format!("{symbol}-{number}"),
            format!("{name} shares · Entity {number}"),
            0,
        ));
    }
    let standard = if kind == 1 { "ERC721" } else { "ERC1155" };
    Ok((
        format!("{standard}-{id}"),
        format!("{standard} asset #{external}"),
        0,
    ))
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    #[test]
    fn native_registry_metadata_matches_canonical_token_classes() {
        use ethabi::ethereum_types::U256;
        assert_eq!(
            checksum_address(
                &hex::decode("52908400098527886e0f7030069857d2e4169ee7")
                    .unwrap()
                    .try_into()
                    .unwrap()
            ),
            "0x52908400098527886E0F7030069857D2E4169EE7"
        );
        let provider = [7; 20];
        assert_eq!(
            non_fungible_metadata(4, 2, &provider, &provider, 9.into()).unwrap(),
            ("CONTROL-9".into(), "Control shares · Entity 9".into(), 0)
        );
        assert_eq!(
            non_fungible_metadata(4, 2, &provider, &provider, (U256::one() << 255) + 9).unwrap(),
            ("DIVIDEND-9".into(), "Dividend shares · Entity 9".into(), 0)
        );
        assert!(non_fungible_metadata(4, 2, &provider, &provider, U256::zero()).is_err());
        assert!(non_fungible_metadata(4, 2, &provider, &provider, U256::one() << 160).is_err());
        assert_eq!(
            non_fungible_metadata(5, 1, &[8; 20], &provider, 42.into()).unwrap(),
            ("ERC721-5".into(), "ERC721 asset #42".into(), 0)
        );
    }
}
