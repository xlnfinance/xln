use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;
use xln_rscore_engine::{AccountTx, EntityId, JEventClaimTx, JurisdictionEvent};
use xln_rscore_entity_kernel::{FinalizedJEventBatch, JClaimIngress, JReserveUpdate};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::storage::native::RuntimeWatcherCursorRow;

use super::abi::{decode_account_settled, into_event, is_account_settled};
use super::receipt::{block_height, fixed_hex, safe_u64, validate_block, validate_receipts};
use super::types::{
    FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc, RpcBlock,
    RpcReceipt,
};

pub fn poll_finalized_j_events(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    cursor: &FinalizedWatcherCursor,
) -> Result<JWatcherPoll, JWatcherError> {
    config.validate()?;
    validate_cursor(cursor)?;
    assert_chain_id(rpc, config.chain_id)?;
    let head = read_head(rpc)?;
    let Some(safe_head) = head.checked_sub(config.confirmation_depth) else {
        return Ok(unchanged(cursor));
    };
    let from = cursor
        .scanned_through
        .checked_add(1)
        .ok_or(JWatcherError::Cursor)?;
    if from > safe_head {
        verify_cursor_anchor(rpc, cursor)?;
        return Ok(unchanged(cursor));
    }
    let to = safe_head.min(
        from.checked_add(config.max_blocks_per_poll - 1)
            .ok_or(JWatcherError::Cursor)?,
    );
    read_and_authenticate_range(rpc, config, cursor, from, to)
}

fn assert_chain_id(rpc: &impl JsonRpc, expected: u64) -> Result<(), JWatcherError> {
    let actual = safe_u64(&rpc.call("eth_chainId", json!([]))?, "chainId")?;
    if actual != expected {
        return Err(JWatcherError::ChainIdMismatch { expected, actual });
    }
    Ok(())
}

fn unchanged(cursor: &FinalizedWatcherCursor) -> JWatcherPoll {
    JWatcherPoll {
        cursor: cursor.clone(),
        batches: Vec::new(),
    }
}

fn read_head(rpc: &impl JsonRpc) -> Result<u64, JWatcherError> {
    safe_u64(&rpc.call("eth_blockNumber", json!([]))?, "head")
}

fn block_parameter(height: u64) -> String {
    format!("0x{height:x}")
}

fn read_block(rpc: &impl JsonRpc, height: u64) -> Result<RpcBlock, JWatcherError> {
    let value = rpc.call(
        "eth_getBlockByNumber",
        json!([block_parameter(height), false]),
    )?;
    if value.is_null() {
        return Err(JWatcherError::BlockMissing(height));
    }
    let block: RpcBlock = serde_json::from_value(value)
        .map_err(|error| JWatcherError::RpcResponse(error.to_string()))?;
    validate_block(&block, height)?;
    Ok(block)
}

fn read_receipt(rpc: &impl JsonRpc, tx_hash: &str) -> Result<RpcReceipt, JWatcherError> {
    let value = rpc.call("eth_getTransactionReceipt", json!([tx_hash]))?;
    if value.is_null() {
        return Err(JWatcherError::ReceiptMissing(tx_hash.to_string()));
    }
    serde_json::from_value(value).map_err(|error| JWatcherError::RpcResponse(error.to_string()))
}

fn read_blocks(rpc: &impl JsonRpc, from: u64, to: u64) -> Result<Vec<RpcBlock>, JWatcherError> {
    (from..=to).map(|height| read_block(rpc, height)).collect()
}

fn range_anchor(from: u64) -> u64 {
    if from > 1 { from - 1 } else { 1 }
}

fn read_and_authenticate_range(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    cursor: &FinalizedWatcherCursor,
    from: u64,
    to: u64,
) -> Result<JWatcherPoll, JWatcherError> {
    let anchor = range_anchor(from);
    let before = read_blocks(rpc, anchor, to)?;
    assert_contiguous(&before)?;
    assert_cursor_anchor(cursor, before.first())?;
    let batches = authenticate_blocks(rpc, config, &before, from)?;
    let after = read_blocks(rpc, anchor, to)?;
    assert_exact_range(&before, &after)?;
    let tip = before.last().ok_or(JWatcherError::BlockMissing(to))?;
    Ok(JWatcherPoll {
        cursor: FinalizedWatcherCursor {
            scanned_through: to,
            block_hash: Some(fixed_hex::<32>(&tip.hash, "tipHash")?),
        },
        batches,
    })
}

fn authenticate_blocks(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    blocks: &[RpcBlock],
    from: u64,
) -> Result<Vec<FinalizedJEventBatch>, JWatcherError> {
    let mut batches = Vec::new();
    for block in blocks {
        if block_height(block)? < from {
            continue;
        }
        let mut receipts = block
            .transactions
            .iter()
            .map(|hash| read_receipt(rpc, hash))
            .collect::<Result<Vec<_>, _>>()?;
        validate_receipts(block, &mut receipts)?;
        if let Some(batch) = build_block_batch(config, block, &receipts)? {
            batches.push(batch);
        }
    }
    Ok(batches)
}

fn build_block_batch(
    config: &JWatcherConfig,
    block: &RpcBlock,
    receipts: &[RpcReceipt],
) -> Result<Option<FinalizedJEventBatch>, JWatcherError> {
    let height = block_height(block)?;
    let block_hash = fixed_hex::<32>(&block.hash, "blockHash")?;
    let mut by_account: BTreeMap<EntityId, Vec<JurisdictionEvent>> = BTreeMap::new();
    let mut reserve_updates = Vec::new();
    let mut seen = BTreeSet::new();
    let mut global_log_index = 0_u64;
    for receipt in receipts {
        for log in &receipt.logs {
            collect_log(
                config,
                height,
                block_hash,
                log,
                global_log_index,
                &mut by_account,
                &mut reserve_updates,
                &mut seen,
            )?;
            global_log_index = global_log_index
                .checked_add(1)
                .ok_or(JWatcherError::Cursor)?;
        }
    }
    if by_account.is_empty() {
        return Ok(None);
    }
    let account_claims = by_account
        .into_iter()
        .map(|(account_id, events)| JClaimIngress {
            account_id,
            tx: AccountTx::JEventClaim(JEventClaimTx {
                j_height: height,
                j_block_hash: block_hash,
                events,
                left_proof: None,
                right_proof: None,
            }),
        })
        .collect();
    Ok(Some(FinalizedJEventBatch {
        j_height: height,
        j_block_hash: block_hash,
        reserve_updates,
        account_claims,
    }))
}

#[allow(clippy::too_many_arguments)]
fn collect_log(
    config: &JWatcherConfig,
    height: u64,
    block_hash: [u8; 32],
    log: &super::types::RpcLog,
    log_index: u64,
    by_account: &mut BTreeMap<EntityId, Vec<JurisdictionEvent>>,
    reserve_updates: &mut Vec<JReserveUpdate>,
    seen: &mut BTreeSet<([u8; 32], u64, u64, EntityId)>,
) -> Result<(), JWatcherError> {
    if fixed_hex::<20>(&log.address, "logAddress")? != config.depository_address
        || !is_account_settled(log)?
    {
        return Ok(());
    }
    let tx_hash = fixed_hex::<32>(&log.transaction_hash, "transactionHash")?;
    let relevant = relevant_settlements(config, decode_account_settled(log)?);
    let include_index = relevant.len() > 1;
    for (index, (settled, account_id, own_reserve)) in relevant.into_iter().enumerate() {
        let event_index = include_index
            .then(|| u64::try_from(index).map_err(|_| JWatcherError::Cursor))
            .transpose()?;
        if !seen.insert((
            tx_hash,
            log_index,
            event_index.unwrap_or(0),
            account_id.clone(),
        )) {
            return Err(JWatcherError::DuplicateEvent);
        }
        reserve_updates.push(JReserveUpdate {
            token_id: settled.token_id.get(),
            own_reserve,
            counterparty_id: account_id.clone(),
        });
        by_account
            .entry(account_id)
            .or_default()
            .push(JurisdictionEvent::AccountSettled(into_event(
                settled,
                height,
                block_hash,
                tx_hash,
                log_index,
                event_index,
            )));
    }
    Ok(())
}

fn relevant_settlements(
    config: &JWatcherConfig,
    values: Vec<super::abi::DecodedSettlement>,
) -> Vec<(super::abi::DecodedSettlement, EntityId, num_bigint::BigInt)> {
    values
        .into_iter()
        .filter_map(|value| {
            if value.left == config.entity_id {
                Some((
                    value.clone(),
                    value.right.clone(),
                    value.left_reserve.clone(),
                ))
            } else if value.right == config.entity_id {
                Some((
                    value.clone(),
                    value.left.clone(),
                    value.right_reserve.clone(),
                ))
            } else {
                None
            }
        })
        .collect()
}

fn assert_contiguous(blocks: &[RpcBlock]) -> Result<(), JWatcherError> {
    for pair in blocks.windows(2) {
        let parent = &pair[0];
        let child = &pair[1];
        let child_height = block_height(child)?;
        if child_height != block_height(parent)? + 1
            || fixed_hex::<32>(&child.parent_hash, "parentHash")?
                != fixed_hex::<32>(&parent.hash, "blockHash")?
        {
            return Err(JWatcherError::ParentMismatch(child_height));
        }
    }
    Ok(())
}

fn assert_exact_range(before: &[RpcBlock], after: &[RpcBlock]) -> Result<(), JWatcherError> {
    if before.len() != after.len() {
        return Err(JWatcherError::RangeChanged(0));
    }
    for (left, right) in before.iter().zip(after) {
        super::receipt::assert_same_block(left, right)?;
    }
    Ok(())
}

fn validate_cursor(cursor: &FinalizedWatcherCursor) -> Result<(), JWatcherError> {
    match (cursor.scanned_through, cursor.block_hash) {
        (0, None) | (1.., Some(_)) => Ok(()),
        _ => Err(JWatcherError::Cursor),
    }
}

fn verify_cursor_anchor(
    rpc: &impl JsonRpc,
    cursor: &FinalizedWatcherCursor,
) -> Result<(), JWatcherError> {
    if cursor.scanned_through == 0 {
        return Ok(());
    }
    let block = read_block(rpc, cursor.scanned_through)?;
    assert_cursor_anchor(cursor, Some(&block))
}

fn assert_cursor_anchor(
    cursor: &FinalizedWatcherCursor,
    block: Option<&RpcBlock>,
) -> Result<(), JWatcherError> {
    if cursor.scanned_through == 0 {
        return Ok(());
    }
    let block = block.ok_or(JWatcherError::BlockMissing(cursor.scanned_through))?;
    if block_height(block)? != cursor.scanned_through
        || Some(fixed_hex::<32>(&block.hash, "blockHash")?) != cursor.block_hash
    {
        return Err(JWatcherError::FinalizedReorg(cursor.scanned_through));
    }
    Ok(())
}

pub(crate) fn cursor_durable_change(
    cursor: &FinalizedWatcherCursor,
    entity_id: &[u8; 32],
    chain_id: u64,
    depository_address: &[u8; 20],
) -> Result<RuntimeWatcherCursorRow, JWatcherError> {
    validate_cursor(cursor)?;
    let canonical_chain_id =
        CanonicalNumber::try_from_u64(chain_id).map_err(|_| JWatcherError::Cursor)?;
    let height =
        CanonicalNumber::try_from_u64(cursor.scanned_through).map_err(|_| JWatcherError::Cursor)?;
    let value = CanonicalValue::Object(vec![
        ("chainId".into(), CanonicalValue::Number(canonical_chain_id)),
        (
            "depositoryAddress".into(),
            CanonicalValue::String(render_hex(depository_address)),
        ),
        ("scannedThrough".into(), CanonicalValue::Number(height)),
        (
            "blockHash".into(),
            cursor.block_hash.map_or(CanonicalValue::Null, |hash| {
                CanonicalValue::String(render_hex(&hash))
            }),
        ),
    ]);
    let value = crate::encode_storage_payload(&value)
        .map_err(|error| JWatcherError::Storage(error.to_string()))?;
    Ok(RuntimeWatcherCursorRow {
        entity_id: *entity_id,
        chain_id,
        depository_address: *depository_address,
        value_bytes: value,
    })
}

pub(crate) fn restore_cursor_durable_change(
    change: &RuntimeWatcherCursorRow,
    entity_id: &[u8; 32],
    chain_id: u64,
    depository_address: &[u8; 20],
) -> Result<FinalizedWatcherCursor, JWatcherError> {
    if change.entity_id != *entity_id
        || change.chain_id != chain_id
        || change.depository_address != *depository_address
    {
        return Err(JWatcherError::Storage("j-watcher-key".into()));
    }
    let decoded = crate::decode_storage_payload(&change.value_bytes)
        .map_err(|error| JWatcherError::Storage(error.to_string()))?;
    let object = decoded
        .as_object()
        .filter(|object| object.len() == 4)
        .ok_or_else(|| JWatcherError::Storage("j-watcher-object".into()))?;
    let stored_chain_id = object
        .get("chainId")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| JWatcherError::Storage("j-watcher-chain".into()))?;
    let stored_address = object
        .get("depositoryAddress")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| JWatcherError::Storage("j-watcher-address".into()))?;
    if stored_chain_id != chain_id || stored_address != render_hex(depository_address) {
        return Err(JWatcherError::Storage("j-watcher-binding".into()));
    }
    let scanned_through = object
        .get("scannedThrough")
        .and_then(serde_json::Value::as_u64)
        .ok_or(JWatcherError::Cursor)?;
    let block_hash = match object.get("blockHash") {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => Some(fixed_hex::<32>(value, "cursorHash")?),
        _ => return Err(JWatcherError::Cursor),
    };
    let cursor = FinalizedWatcherCursor {
        scanned_through,
        block_hash,
    };
    validate_cursor(&cursor)?;
    Ok(cursor)
}

fn render_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 15)] as char);
    }
    output
}
