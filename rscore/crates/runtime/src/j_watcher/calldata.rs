use num_bigint::BigUint;
use rlp::RlpStream;
use serde_json::{Map, Value, json};
use sha3::{Digest, Keccak256};

use xln_rscore_engine::EntityId;
use xln_rscore_entity_kernel::{JBatch, j_batch::CounterDisputeProof};

use super::abi::hex;
use super::receipt::{fixed_hex, parse_hex, parse_quantity};
use super::types::{JWatcherError, JsonRpc};

fn field<'a>(tx: &'a Map<String, Value>, name: &'static str) -> Result<&'a Value, JWatcherError> {
    tx.get(name).ok_or(JWatcherError::TransactionField(name))
}

fn rlp_quantity(value: &Value, name: &'static str) -> Result<Vec<u8>, JWatcherError> {
    let value = parse_quantity(value, name)?;
    // Ethereum transaction RLP encodes the integer zero as the empty byte
    // string (0x80), never as the byte 0x00. BigUint deliberately retains a
    // zero byte, so normalize at this one scalar-encoding boundary.
    Ok(if value == BigUint::from(0_u8) {
        Vec::new()
    } else {
        value.to_bytes_be()
    })
}

fn quantity_bytes(tx: &Map<String, Value>, name: &'static str) -> Result<Vec<u8>, JWatcherError> {
    rlp_quantity(field(tx, name)?, name)
}

fn destination(tx: &Map<String, Value>) -> Result<Vec<u8>, JWatcherError> {
    match tx.get("to") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(value)) => parse_hex(value, Some(20), "to"),
        _ => Err(JWatcherError::TransactionField("to")),
    }
}

fn append_access_list(
    stream: &mut RlpStream,
    tx: &Map<String, Value>,
) -> Result<(), JWatcherError> {
    let list = tx
        .get("accessList")
        .and_then(Value::as_array)
        .ok_or(JWatcherError::TransactionField("accessList"))?;
    stream.begin_list(list.len());
    for entry in list {
        let entry = entry
            .as_object()
            .ok_or(JWatcherError::TransactionField("accessList"))?;
        let address = entry
            .get("address")
            .and_then(Value::as_str)
            .ok_or(JWatcherError::TransactionField("accessList.address"))?;
        let address = parse_hex(address, Some(20), "accessList.address")?;
        let keys = entry
            .get("storageKeys")
            .and_then(Value::as_array)
            .ok_or(JWatcherError::TransactionField("accessList.storageKeys"))?;
        stream.begin_list(2);
        stream.append(&address);
        stream.begin_list(keys.len());
        for key in keys {
            let key = key
                .as_str()
                .ok_or(JWatcherError::TransactionField("accessList.storageKey"))?;
            stream.append(&parse_hex(key, Some(32), "accessList.storageKey")?);
        }
    }
    Ok(())
}

fn append_common(
    stream: &mut RlpStream,
    tx: &Map<String, Value>,
    fee_names: &[&'static str],
) -> Result<(), JWatcherError> {
    stream.append(&quantity_bytes(tx, "chainId")?);
    stream.append(&quantity_bytes(tx, "nonce")?);
    for fee in fee_names {
        stream.append(&quantity_bytes(tx, fee)?);
    }
    stream.append(&quantity_bytes(tx, "gas")?);
    stream.append(&destination(tx)?);
    stream.append(&quantity_bytes(tx, "value")?);
    let input = tx
        .get("input")
        .or_else(|| tx.get("data"))
        .and_then(Value::as_str)
        .ok_or(JWatcherError::TransactionField("input"))?;
    stream.append(&parse_hex(input, None, "input")?);
    append_access_list(stream, tx)
}

fn typed_signed_transaction(
    tx_type: u64,
    tx: &Map<String, Value>,
) -> Result<Vec<u8>, JWatcherError> {
    let field_count = match tx_type {
        1 => 11,
        2 => 12,
        3 => 14,
        _ => return Err(JWatcherError::TransactionType(tx_type)),
    };
    let mut stream = RlpStream::new_list(field_count);
    match tx_type {
        1 => append_common(&mut stream, tx, &["gasPrice"])?,
        2 | 3 => append_common(&mut stream, tx, &["maxPriorityFeePerGas", "maxFeePerGas"])?,
        _ => unreachable!("transaction type was checked above"),
    }
    if tx_type == 3 {
        stream.append(&quantity_bytes(tx, "maxFeePerBlobGas")?);
        let hashes = field(tx, "blobVersionedHashes")?
            .as_array()
            .ok_or(JWatcherError::TransactionField("blobVersionedHashes"))?;
        stream.begin_list(hashes.len());
        for hash in hashes {
            let hash = hash
                .as_str()
                .ok_or(JWatcherError::TransactionField("blobVersionedHashes"))?;
            stream.append(&parse_hex(hash, Some(32), "blobVersionedHashes")?);
        }
    }
    let parity = tx
        .get("yParity")
        .or_else(|| tx.get("v"))
        .ok_or(JWatcherError::TransactionField("yParity"))?;
    stream.append(&rlp_quantity(parity, "yParity")?);
    stream.append(&quantity_bytes(tx, "r")?);
    stream.append(&quantity_bytes(tx, "s")?);
    let mut raw = Vec::with_capacity(stream.as_raw().len() + 1);
    raw.push(u8::try_from(tx_type).map_err(|_| JWatcherError::TransactionType(tx_type))?);
    raw.extend_from_slice(stream.as_raw());
    Ok(raw)
}

fn legacy_signed_transaction(tx: &Map<String, Value>) -> Result<Vec<u8>, JWatcherError> {
    let mut stream = RlpStream::new_list(9);
    stream.append(&quantity_bytes(tx, "nonce")?);
    stream.append(&quantity_bytes(tx, "gasPrice")?);
    stream.append(&quantity_bytes(tx, "gas")?);
    stream.append(&destination(tx)?);
    stream.append(&quantity_bytes(tx, "value")?);
    let input = tx
        .get("input")
        .or_else(|| tx.get("data"))
        .and_then(Value::as_str)
        .ok_or(JWatcherError::TransactionField("input"))?;
    stream.append(&parse_hex(input, None, "input")?);
    stream.append(&quantity_bytes(tx, "v")?);
    stream.append(&quantity_bytes(tx, "r")?);
    stream.append(&quantity_bytes(tx, "s")?);
    Ok(stream.out().to_vec())
}

fn authenticated_input(expected_hash: &[u8; 32], value: Value) -> Result<Vec<u8>, JWatcherError> {
    let tx = value.as_object().ok_or(JWatcherError::TransactionMissing)?;
    if fixed_hex::<32>(
        field(tx, "hash")?
            .as_str()
            .ok_or(JWatcherError::TransactionField("hash"))?,
        "transactionHash",
    )? != *expected_hash
    {
        return Err(JWatcherError::TransactionHashMismatch);
    }
    let tx_type = tx
        .get("type")
        .map(|value| parse_quantity(value, "transactionType"))
        .transpose()?
        .unwrap_or_else(|| BigUint::from(0_u8));
    let tx_type = u64::try_from(tx_type).map_err(|_| JWatcherError::TransactionType(u64::MAX))?;
    let raw = if tx_type == 0 {
        legacy_signed_transaction(tx)?
    } else {
        typed_signed_transaction(tx_type, tx)?
    };
    let actual: [u8; 32] = Keccak256::digest(&raw).into();
    if actual != *expected_hash {
        return Err(JWatcherError::TransactionHashMismatch);
    }
    let input = tx
        .get("input")
        .or_else(|| tx.get("data"))
        .and_then(Value::as_str)
        .ok_or(JWatcherError::TransactionField("input"))?;
    parse_hex(input, None, "input")
}

/// Selector hits decoded per transaction; a decoy flood cannot cost more.
const DISPUTE_CALLDATA_SCAN_MAX_HITS: usize = 64;

/// One Depository dispute call carried by a transaction. A watchtower call
/// names its Entity explicitly; a processBatch Entity is the Hanko signer.
pub(super) struct DisputeCall {
    pub sender: Option<EntityId>,
    pub batch: JBatch,
}

fn decode_dispute_call(calldata: &[u8]) -> Result<DisputeCall, JWatcherError> {
    if calldata.get(..4) == Some(&crate::j_submit::dispute_call_selectors()[0][..]) {
        let (_, _, _, batch) = crate::j_submit::decode_process_batch_calldata(calldata)
            .map_err(|error| JWatcherError::DisputeCalldata(error.to_string()))?;
        return Ok(DisputeCall {
            sender: None,
            batch,
        });
    }
    let watchtower = crate::j_submit::decode_watchtower_counter_dispute_calldata(calldata)
        .map_err(|error| JWatcherError::DisputeCalldata(error.to_string()))?;
    let proof = watchtower.proof;
    let counter = CounterDisputeProof {
        counterentity: proof.counterentity,
        initial_nonce: proof.initial_nonce,
        initial_proofbody_hash: proof.initial_proofbody_hash,
        counter_nonce: proof.final_nonce,
        proposer_is_left: proof.proposer_is_left,
        counter_proofbody: proof.final_proofbody.clone(),
        sig: proof.sig.clone(),
    };
    Ok(DisputeCall {
        sender: Some(
            EntityId::parse(&hex(&watchtower.entity_id))
                .map_err(|error| JWatcherError::Account(error.to_string()))?,
        ),
        batch: JBatch {
            counter_disputes: vec![counter],
            dispute_finalizations: vec![proof],
            ..JBatch::default()
        },
    })
}

/// Every Depository dispute call one transaction carries.
///
/// A direct processBatch/watchtowerCounterDispute call keeps its strict
/// decoder. A wrapper (Safe, ERC-4337, forwarder, packed MultiSend) places the
/// call at any byte offset, so each selector hit is decoded and kept only when
/// its canonical re-encoding is a byte prefix there and its batch decodes; an
/// embedded call that does not could never have executed. A hit proves nothing
/// about execution: the caller accepts a body only when it matches the
/// authenticated event exactly, proofbodyHash included. Mirrors the TS
/// `extractEmbeddedDisputeCalls` scan so both engines resolve the same body.
pub(super) fn decode_dispute_calls(calldata: &[u8]) -> Result<Vec<DisputeCall>, JWatcherError> {
    let selectors = crate::j_submit::dispute_call_selectors();
    let is_selector = |bytes: &[u8]| selectors.iter().any(|selector| bytes.starts_with(selector));
    if is_selector(calldata) {
        return Ok(vec![decode_dispute_call(calldata)?]);
    }
    let calls: Vec<DisputeCall> = (1..=calldata.len().saturating_sub(4))
        .filter(|offset| is_selector(&calldata[*offset..]))
        .take(DISPUTE_CALLDATA_SCAN_MAX_HITS)
        .filter_map(|offset| crate::j_submit::canonical_dispute_call_prefix(&calldata[offset..]))
        .filter_map(|call| decode_dispute_call(call).ok())
        .collect();
    if calls.is_empty() {
        return Err(JWatcherError::DisputeCalldata(
            "DISPUTE_CALL_NOT_FOUND".into(),
        ));
    }
    Ok(calls)
}

/// Calldata of a receipt-attested native TRON transaction. The RPC names it by
/// 0x-prefixed txID; the SolidityNode returns raw_data_hex, and sha256(raw_data)
/// must equal that txID before its TriggerSmartContract data is trusted. The
/// eth-compatible view cannot serve this: it carries no raw_data, and an
/// Ethereum envelope hash never equals a TRON txID. Mirrors the TS
/// `readIncludedTronCalldata`.
fn native_tron_calldata(
    rpc: &impl JsonRpc,
    transaction_hash: &[u8; 32],
) -> Result<Vec<u8>, JWatcherError> {
    let tx_id = super::abi::hex(transaction_hash);
    let value = rpc.tron_solidity_call(
        "gettransactionbyid",
        json!({ "value": tx_id.trim_start_matches("0x") }),
    )?;
    let tx = value
        .as_object()
        .filter(|tx| !tx.is_empty())
        .ok_or(JWatcherError::TransactionMissing)?;
    let claimed = field(tx, "txID")?
        .as_str()
        .ok_or(JWatcherError::TransactionField("txID"))?;
    if fixed_hex::<32>(&format!("0x{claimed}"), "txID")? != *transaction_hash {
        return Err(JWatcherError::TransactionHashMismatch);
    }
    let raw = field(tx, "raw_data_hex")?
        .as_str()
        .ok_or(JWatcherError::TransactionField("raw_data_hex"))?;
    let raw = parse_hex(&format!("0x{raw}"), None, "raw_data_hex")?;
    crate::j_submit::prepared_wire::decode_included_tron_call(transaction_hash, &raw)
        .map_err(|_| JWatcherError::TransactionHashMismatch)
}

pub(crate) fn read_authenticated_calldata(
    rpc: &impl JsonRpc,
    transaction_hash: &[u8; 32],
) -> Result<Vec<u8>, JWatcherError> {
    if rpc.tron_rpc_attested() {
        return native_tron_calldata(rpc, transaction_hash);
    }
    let value = rpc.call(
        "eth_getTransactionByHash",
        json!([super::abi::hex(transaction_hash)]),
    )?;
    if value.is_null() {
        return Err(JWatcherError::TransactionMissing);
    }
    authenticated_input(transaction_hash, value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{authenticated_input, fixed_hex};

    fn assert_vector(hash: &str, transaction: serde_json::Value) {
        let expected = fixed_hex::<32>(hash, "testHash").expect("hash");
        assert_eq!(
            authenticated_input(&expected, transaction)
                .unwrap_or_else(|error| panic!("authenticated transaction {hash}: {error:?}")),
            [0x12, 0x34]
        );
    }

    #[test]
    fn authenticates_ethers_legacy_type1_and_type2_vectors() {
        assert_vector(
            "0xf0529bcf0e3a2485694a18b1ee7337858022d4a8694835cd3ebd7b223b1c8d84",
            json!({
                "hash": "0xf0529bcf0e3a2485694a18b1ee7337858022d4a8694835cd3ebd7b223b1c8d84",
                "type": "0x0", "nonce": "0x7", "gasPrice": "0x9", "gas": "0x1d4c0",
                "to": "0x2222222222222222222222222222222222222222", "value": "0x3",
                "input": "0x1234", "v": "0xf4f5",
                "r": "0x036341a1480efeff0563f2670cc40d911fcabe01d99ed9f5039f90ccaa33b463",
                "s": "0x140b658fa1bdb2b16d7bdc2560310ac15c39670ef1fdf93bd59c71962e26b8db"
            }),
        );
        assert_vector(
            "0xedcd493f0db03973926b6c4506ac00b290e02bdf780265092550ed756b116f1d",
            json!({
                "hash": "0xedcd493f0db03973926b6c4506ac00b290e02bdf780265092550ed756b116f1d",
                "type": "0x1", "chainId": "0x7a69", "nonce": "0x7", "gasPrice": "0x9",
                "gas": "0x1d4c0", "to": "0x2222222222222222222222222222222222222222",
                "value": "0x3", "input": "0x1234", "yParity": "0x0",
                "accessList": [{"address": "0x3333333333333333333333333333333333333333",
                    "storageKeys": ["0x4444444444444444444444444444444444444444444444444444444444444444"]}],
                "r": "0xa81e43be9d243e037373348453cfc968412a6270a72ab6b5346bfc3320bfc993",
                "s": "0x3f9f4e2e3a506fde455275719eac69040256df4b045994720f0ca198187e9f0f"
            }),
        );
        assert_vector(
            "0x7dabcfae3fbeaa73de1a018f7ebaea279b916f7f9236fb6cb0cb8130c739f50c",
            json!({
                "hash": "0x7dabcfae3fbeaa73de1a018f7ebaea279b916f7f9236fb6cb0cb8130c739f50c",
                "type": "0x2", "chainId": "0x7a69", "nonce": "0x7",
                "maxPriorityFeePerGas": "0x2", "maxFeePerGas": "0xa", "gas": "0x1d4c0",
                "to": "0x2222222222222222222222222222222222222222", "value": "0x3",
                "input": "0x1234", "accessList": [], "yParity": "0x1",
                "r": "0x4ead2b6ec6be02cd8ac066bbdbb4df502995509cf6300c060a1184cc7e0832ef",
                "s": "0x0d661fa18dc9f8256ceae282135244e2f28639df26b6e52d806d8a469eac1289"
            }),
        );
    }

    #[test]
    fn rejects_rpc_transaction_fields_that_do_not_match_the_receipt_hash() {
        let hash = fixed_hex::<32>(
            "0x7dabcfae3fbeaa73de1a018f7ebaea279b916f7f9236fb6cb0cb8130c739f50c",
            "testHash",
        )
        .expect("hash");
        let transaction = json!({
            "hash": "0x7dabcfae3fbeaa73de1a018f7ebaea279b916f7f9236fb6cb0cb8130c739f50c",
            "type": "0x2", "chainId": "0x7a69", "nonce": "0x7",
            "maxPriorityFeePerGas": "0x2", "maxFeePerGas": "0xa", "gas": "0x1d4c0",
            "to": "0x2222222222222222222222222222222222222222", "value": "0x4",
            "input": "0x1234", "accessList": [], "yParity": "0x1",
            "r": "0x4ead2b6ec6be02cd8ac066bbdbb4df502995509cf6300c060a1184cc7e0832ef",
            "s": "0x0d661fa18dc9f8256ceae282135244e2f28639df26b6e52d806d8a469eac1289"
        });
        assert!(authenticated_input(&hash, transaction).is_err());
    }
}
