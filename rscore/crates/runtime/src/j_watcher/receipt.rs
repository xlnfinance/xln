use std::cmp::Ordering;

use keccak_hasher::KeccakHasher;
use num_bigint::BigUint;
use rlp::RlpStream;
use serde_json::Value;
use triehash::ordered_trie_root;

use super::types::{JWatcherError, MAX_SAFE_INTEGER, RpcBlock, RpcLog, RpcReceipt};

pub(crate) fn parse_quantity(value: &Value, field: &'static str) -> Result<BigUint, JWatcherError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .map(BigUint::from)
            .ok_or(JWatcherError::Quantity(field)),
        Value::String(text) => {
            let (radix, digits) = text
                .strip_prefix("0x")
                .map_or((10, text.as_str()), |digits| (16, digits));
            if digits.is_empty() {
                return Err(JWatcherError::Quantity(field));
            }
            BigUint::parse_bytes(digits.as_bytes(), radix).ok_or(JWatcherError::Quantity(field))
        }
        _ => Err(JWatcherError::Quantity(field)),
    }
}

pub(crate) fn safe_u64(value: &Value, field: &'static str) -> Result<u64, JWatcherError> {
    let parsed = parse_quantity(value, field)?;
    let bytes = parsed.to_bytes_be();
    if bytes.len() > 8 {
        return Err(JWatcherError::SafeInteger(field));
    }
    let result = bytes
        .iter()
        .fold(0_u64, |total, byte| (total << 8) | u64::from(*byte));
    if result > MAX_SAFE_INTEGER {
        return Err(JWatcherError::SafeInteger(field));
    }
    Ok(result)
}

pub(crate) fn parse_hex(
    value: &str,
    bytes: Option<usize>,
    field: &'static str,
) -> Result<Vec<u8>, JWatcherError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len().is_multiple_of(2))
        .ok_or(JWatcherError::Hex(field))?;
    if bytes.is_some_and(|expected| payload.len() != expected * 2) {
        return Err(JWatcherError::Hex(field));
    }
    payload
        .as_bytes()
        .chunks_exact(2)
        .map(|digits| {
            let high = hex_nibble(digits[0]).ok_or(JWatcherError::Hex(field))?;
            let low = hex_nibble(digits[1]).ok_or(JWatcherError::Hex(field))?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn fixed_hex<const N: usize>(
    value: &str,
    field: &'static str,
) -> Result<[u8; N], JWatcherError> {
    parse_hex(value, Some(N), field)?
        .try_into()
        .map_err(|_| JWatcherError::Hex(field))
}

pub(crate) fn block_height(block: &RpcBlock) -> Result<u64, JWatcherError> {
    safe_u64(&block.number, "blockNumber")
}

pub(crate) fn validate_block(block: &RpcBlock, expected_height: u64) -> Result<(), JWatcherError> {
    let actual = block_height(block)?;
    if actual != expected_height {
        return Err(JWatcherError::BlockNumber {
            expected: expected_height,
            actual,
        });
    }
    fixed_hex::<32>(&block.hash, "blockHash")?;
    fixed_hex::<32>(&block.parent_hash, "parentHash")?;
    fixed_hex::<32>(&block.receipts_root, "receiptsRoot")?;
    for transaction in &block.transactions {
        fixed_hex::<32>(transaction, "transactionHash")?;
    }
    Ok(())
}

pub(crate) fn assert_same_block(before: &RpcBlock, after: &RpcBlock) -> Result<(), JWatcherError> {
    let height = block_height(before)?;
    if before != after {
        return Err(JWatcherError::RangeChanged(height));
    }
    Ok(())
}

fn quantity_bytes(value: &Value, field: &'static str) -> Result<Vec<u8>, JWatcherError> {
    Ok(parse_quantity(value, field)?.to_bytes_be())
}

fn append_bytes(stream: &mut RlpStream, bytes: &[u8]) {
    stream.append(&bytes);
}

fn encode_log(stream: &mut RlpStream, log: &RpcLog) -> Result<(), JWatcherError> {
    stream.begin_list(3);
    append_bytes(stream, &parse_hex(&log.address, Some(20), "logAddress")?);
    stream.begin_list(log.topics.len());
    for topic in &log.topics {
        append_bytes(stream, &parse_hex(topic, Some(32), "logTopic")?);
    }
    append_bytes(stream, &parse_hex(&log.data, None, "logData")?);
    Ok(())
}

fn append_outcome(stream: &mut RlpStream, receipt: &RpcReceipt) -> Result<(), JWatcherError> {
    match (&receipt.status, &receipt.root) {
        // Match the canonical TypeScript codec: post-Byzantium `status` wins
        // if an over-complete RPC response also includes the legacy root.
        (Some(status), _) => append_bytes(stream, &quantity_bytes(status, "status")?),
        (None, Some(root)) => append_bytes(stream, &parse_hex(root, Some(32), "stateRoot")?),
        (None, None) => return Err(JWatcherError::ReceiptOutcome),
    }
    Ok(())
}

pub(crate) fn encode_receipt(receipt: &RpcReceipt) -> Result<Vec<u8>, JWatcherError> {
    let receipt_type = receipt
        .receipt_type
        .as_ref()
        .map(|value| safe_u64(value, "receiptType"))
        .transpose()?
        .unwrap_or(0);
    if receipt_type > 0x7f {
        return Err(JWatcherError::ReceiptType(receipt_type.to_string()));
    }
    let mut stream = RlpStream::new_list(
        4 + usize::from(receipt.deposit_nonce.is_some())
            + usize::from(receipt.deposit_receipt_version.is_some()),
    );
    append_outcome(&mut stream, receipt)?;
    append_bytes(
        &mut stream,
        &quantity_bytes(&receipt.cumulative_gas_used, "cumulativeGasUsed")?,
    );
    append_bytes(
        &mut stream,
        &parse_hex(&receipt.logs_bloom, Some(256), "logsBloom")?,
    );
    stream.begin_list(receipt.logs.len());
    for log in &receipt.logs {
        encode_log(&mut stream, log)?;
    }
    append_deposit_fields(&mut stream, receipt, receipt_type)?;
    let payload = stream.out().to_vec();
    if receipt_type == 0 {
        return Ok(payload);
    }
    let mut typed = Vec::with_capacity(payload.len() + 1);
    typed.push(
        u8::try_from(receipt_type)
            .map_err(|_| JWatcherError::ReceiptType(receipt_type.to_string()))?,
    );
    typed.extend_from_slice(&payload);
    Ok(typed)
}

fn append_deposit_fields(
    stream: &mut RlpStream,
    receipt: &RpcReceipt,
    receipt_type: u64,
) -> Result<(), JWatcherError> {
    if receipt_type != 0x7e
        && (receipt.deposit_nonce.is_some() || receipt.deposit_receipt_version.is_some())
    {
        return Err(JWatcherError::ReceiptType(receipt_type.to_string()));
    }
    if receipt.deposit_receipt_version.is_some() && receipt.deposit_nonce.is_none() {
        return Err(JWatcherError::ReceiptType(
            "depositVersionWithoutNonce".into(),
        ));
    }
    if let Some(nonce) = &receipt.deposit_nonce {
        append_bytes(stream, &quantity_bytes(nonce, "depositNonce")?);
    }
    if let Some(version) = &receipt.deposit_receipt_version {
        if safe_u64(version, "depositReceiptVersion")? != 1 {
            return Err(JWatcherError::ReceiptType("depositVersion".into()));
        }
        append_bytes(stream, &quantity_bytes(version, "depositReceiptVersion")?);
    }
    Ok(())
}

pub(crate) fn validate_receipts(
    block: &RpcBlock,
    receipts: &mut [RpcReceipt],
) -> Result<(), JWatcherError> {
    if receipts.len() != block.transactions.len() {
        return Err(JWatcherError::ReceiptCount {
            expected: block.transactions.len(),
            actual: receipts.len(),
        });
    }
    receipts.sort_by(receipt_order);
    for (index, receipt) in receipts.iter().enumerate() {
        validate_receipt(block, receipt, index)?;
    }
    let encoded = receipts
        .iter()
        .map(encode_receipt)
        .collect::<Result<Vec<_>, _>>()?;
    let computed = ordered_trie_root::<KeccakHasher, _>(&encoded);
    let expected = fixed_hex::<32>(&block.receipts_root, "receiptsRoot")?;
    if computed.as_ref() != expected {
        return Err(JWatcherError::ReceiptRootMismatch);
    }
    Ok(())
}

fn receipt_order(left: &RpcReceipt, right: &RpcReceipt) -> Ordering {
    let left = safe_u64(&left.transaction_index, "transactionIndex").unwrap_or(u64::MAX);
    let right = safe_u64(&right.transaction_index, "transactionIndex").unwrap_or(u64::MAX);
    left.cmp(&right)
}

fn validate_receipt(
    block: &RpcBlock,
    receipt: &RpcReceipt,
    index: usize,
) -> Result<(), JWatcherError> {
    let actual = safe_u64(&receipt.transaction_index, "transactionIndex")?;
    let expected = u64::try_from(index).map_err(|_| JWatcherError::ReceiptIndex {
        expected: index,
        actual,
    })?;
    if actual != expected {
        return Err(JWatcherError::ReceiptIndex {
            expected: index,
            actual,
        });
    }
    let expected_tx = fixed_hex::<32>(&block.transactions[index], "transactionHash")?;
    let actual_tx = fixed_hex::<32>(&receipt.transaction_hash, "receiptTransactionHash")?;
    if expected_tx != actual_tx {
        return Err(JWatcherError::ReceiptCoordinates(
            receipt.transaction_hash.clone(),
        ));
    }
    assert_receipt_block(block, receipt)?;
    for log in &receipt.logs {
        assert_log_coordinates(block, receipt, log, index)?;
    }
    Ok(())
}

fn assert_receipt_block(block: &RpcBlock, receipt: &RpcReceipt) -> Result<(), JWatcherError> {
    if fixed_hex::<32>(&receipt.block_hash, "receiptBlockHash")?
        != fixed_hex::<32>(&block.hash, "blockHash")?
        || safe_u64(&receipt.block_number, "receiptBlockNumber")? != block_height(block)?
    {
        return Err(JWatcherError::ReceiptCoordinates(
            receipt.transaction_hash.clone(),
        ));
    }
    Ok(())
}

fn assert_log_coordinates(
    block: &RpcBlock,
    receipt: &RpcReceipt,
    log: &RpcLog,
    transaction_index: usize,
) -> Result<(), JWatcherError> {
    if log.removed == Some(true) {
        return Err(JWatcherError::RemovedLog);
    }
    let coordinates_match = fixed_hex::<32>(&log.block_hash, "logBlockHash")?
        == fixed_hex::<32>(&block.hash, "blockHash")?
        && safe_u64(&log.block_number, "logBlockNumber")? == block_height(block)?
        && fixed_hex::<32>(&log.transaction_hash, "logTransactionHash")?
            == fixed_hex::<32>(&receipt.transaction_hash, "receiptTransactionHash")?
        && safe_u64(&log.transaction_index, "logTransactionIndex")?
            == u64::try_from(transaction_index)
                .map_err(|_| JWatcherError::LogCoordinates(receipt.transaction_hash.clone()))?;
    if !coordinates_match {
        return Err(JWatcherError::LogCoordinates(
            receipt.transaction_hash.clone(),
        ));
    }
    if let (Some(index), Some(log_index)) = (&log.index, &log.log_index)
        && safe_u64(index, "logIndex")? != safe_u64(log_index, "logIndex")?
    {
        return Err(JWatcherError::LogCoordinates(
            receipt.transaction_hash.clone(),
        ));
    }
    Ok(())
}
