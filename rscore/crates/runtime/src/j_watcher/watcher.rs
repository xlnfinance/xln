use super::dispute_reference::DisputeReferences;
use std::collections::{BTreeMap, BTreeSet};

use super::abi::{
    ContractEventKind, address_word, bigint, bool_word, decode_account_settled, decode_dispute_log,
    decode_dispute_started, decode_static_words, entity_word_value, event_kind, hex, into_event,
    require_current_depository_money_abi, safe_uint, token_bool, token_bytes, token_word, uint512,
};
use super::receipt::{block_height, fixed_hex, safe_u64, validate_block, validate_receipts};
use super::types::{
    FinalizedJHeader, FinalizedWatcherCursor, JWatcherConfig, JWatcherError, JWatcherPoll, JsonRpc,
    RpcBlock, RpcReceipt,
};
use serde_json::json;
use xln_rscore_engine::{
    BoardActivatedEvent, CounterDisputeRegisteredEvent, DebtCreatedEvent, DebtEnforcedEvent,
    DebtForgivenEvent, DisputeFinalizationEvidence, DisputeFinalizedEvent, DisputeStartedEvent,
    EntityId, EntityProviderActionCancelledEvent, EntityProviderActionExecutedEvent,
    EntityRegisteredEvent, ExternalWalletDeltaEvent, FoundationBootstrappedEvent,
    HankoBatchProcessedEvent, HashLadderRevealRegisteredEvent, JEventMetadata, JurisdictionEvent,
    ProofAllowance, ProofBody, ProofTransformerClause, ReserveUpdatedEvent, SecretRevealedEvent,
};
use xln_rscore_entity_kernel::{
    FinalizedJEventBatch, j_batch::ProofBody as JBatchProofBody, project_finalized_j_event_batch,
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
    // Resolve the current registry after fixing the range, as the TS watcher
    // does. A token registered within this range must already be in its filter;
    // a failed read returns before any receipt or cursor can be committed.
    let mut config = config.clone();
    config.erc20_tokens = super::read_erc20_token_registry(rpc, &config.depository_address)?;
    config.validate()?;
    read_and_authenticate_range(rpc, &config, cursor, from, to)
}

/// Rebuild the cache lost between Entity certification and shared-cursor fsync.
/// Authenticate every receipt and link bounded pages to the certified Entity
/// anchor before returning any cache or publishing a cursor. Old events are
/// remembered but never resolved/delivered, including hash-only finalizations.
pub(crate) fn recover_dispute_references(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    anchor: &FinalizedWatcherCursor,
    durable_height: u64,
) -> Result<FinalizedWatcherCursor, JWatcherError> {
    let mut result = anchor.clone();
    result.dispute_references = result.dispute_references.through(anchor.scanned_through);
    if durable_height >= anchor.scanned_through {
        return Ok(result);
    }
    config.validate()?;
    assert_chain_id(rpc, config.chain_id)?;
    let floor = match (durable_height, config.entity_provider_deployment_block) {
        (0, None) => {
            return Err(JWatcherError::DisputeReferenceUnavailable(
                "start-block-missing",
            ));
        }
        (_, floor) => floor.unwrap_or(durable_height + 1),
    };
    let from = (durable_height + 1).max(floor);
    if from > anchor.scanned_through {
        return Ok(result);
    }
    let mut recovery_config = config.clone();
    recovery_config.last_finalized_j_height = anchor.scanned_through;
    let mut cursor = FinalizedWatcherCursor {
        scanned_through: from - 1,
        block_hash: read_initial_watcher_anchor(rpc, from - 1)?,
        dispute_references: result.dispute_references,
    };
    for start in (from..=anchor.scanned_through).step_by(256) {
        cursor = read_and_authenticate_range(
            rpc,
            &recovery_config,
            &cursor,
            start,
            anchor.scanned_through.min(start + 255),
        )?
        .cursor;
    }
    if cursor.block_hash != anchor.block_hash {
        return Err(JWatcherError::FinalizedReorg(anchor.scanned_through));
    }
    Ok(cursor)
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
        headers: Vec::new(),
        batches: Vec::new(),
    }
}

fn read_head(rpc: &impl JsonRpc) -> Result<u64, JWatcherError> {
    safe_u64(&rpc.call("eth_blockNumber", json!([]))?, "head")
}

/// Capture the startup boundary once. Later polls authenticate its headers;
/// a moving chain head must not extend the startup obligation indefinitely.
pub(crate) fn capture_startup_target(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
) -> Result<u64, JWatcherError> {
    config.validate()?;
    assert_chain_id(rpc, config.chain_id)?;
    Ok(read_head(rpc)?.saturating_sub(config.confirmation_depth))
}

fn block_parameter(height: u64) -> String {
    format!("0x{height:x}")
}

pub(crate) fn read_initial_watcher_anchor(
    rpc: &impl JsonRpc,
    height: u64,
) -> Result<Option<[u8; 32]>, JWatcherError> {
    if height == 0 {
        return Ok(None);
    }
    let block = read_block(rpc, height)?;
    Ok(Some(fixed_hex::<32>(&block.hash, "initialParentHash")?))
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
    let mut references = cursor.dispute_references.clone();
    let batches = authenticate_blocks(rpc, config, &before, from, &mut references)?;
    let after = read_blocks(rpc, anchor, to)?;
    assert_exact_range(&before, &after)?;
    let tip = before.last().ok_or(JWatcherError::BlockMissing(to))?;
    let headers = before
        .iter()
        .filter(|block| block_height(block).is_ok_and(|height| height >= from))
        .map(|block| {
            Ok(FinalizedJHeader {
                j_height: block_height(block)?,
                j_block_hash: fixed_hex::<32>(&block.hash, "headerHash")?,
            })
        })
        .collect::<Result<Vec<_>, JWatcherError>>()?;
    Ok(JWatcherPoll {
        cursor: FinalizedWatcherCursor {
            dispute_references: references,
            scanned_through: to,
            block_hash: Some(fixed_hex::<32>(&tip.hash, "tipHash")?),
        },
        headers,
        batches,
    })
}

fn authenticate_blocks(
    rpc: &impl JsonRpc,
    config: &JWatcherConfig,
    blocks: &[RpcBlock],
    from: u64,
    references: &mut DisputeReferences,
) -> Result<Vec<FinalizedJEventBatch>, JWatcherError> {
    let mut batches = Vec::new();
    for block in blocks {
        if block_height(block)? < from {
            continue;
        }
        let receipts = if rpc.tron_rpc_attested() {
            super::tron::read_receipts(rpc, config, block)?
        } else {
            let mut receipts = block
                .transactions
                .iter()
                .map(|hash| read_receipt(rpc, hash))
                .collect::<Result<Vec<_>, _>>()?;
            validate_receipts(block, &mut receipts)?;
            receipts
        };
        super::dispute_reference::read_history(config, &receipts, references)?;
        let result = build_block_batch_with_references(config, block, &receipts, references);
        let result = if matches!(result, Err(JWatcherError::DisputeReferenceUnavailable(_))) {
            super::dispute_reference::refill(rpc, config, &receipts, references)?;
            build_block_batch_with_references(config, block, &receipts, references)
        } else {
            result
        };
        if let Some(batch) = result? {
            batches.push(batch);
        }
    }
    Ok(batches)
}

#[cfg(test)]
pub(super) fn build_block_batch(
    config: &JWatcherConfig,
    block: &RpcBlock,
    receipts: &[RpcReceipt],
) -> Result<Option<FinalizedJEventBatch>, JWatcherError> {
    let history = receipts
        .iter()
        .flat_map(|receipt| receipt.logs.iter().cloned())
        .collect::<Vec<_>>();
    build_block_batch_with_history(config, block, receipts, &history)
}

#[cfg(test)]
pub(super) fn build_block_batch_with_history(
    config: &JWatcherConfig,
    block: &RpcBlock,
    receipts: &[RpcReceipt],
    history: &[super::types::RpcLog],
) -> Result<Option<FinalizedJEventBatch>, JWatcherError> {
    let mut references = DisputeReferences::default();
    for log in history {
        super::dispute_reference::remember(&mut references, log)?;
    }
    build_block_batch_with_references(config, block, receipts, &references)
}

pub(super) fn build_block_batch_with_references(
    config: &JWatcherConfig,
    block: &RpcBlock,
    receipts: &[RpcReceipt],
    history: &DisputeReferences,
) -> Result<Option<FinalizedJEventBatch>, JWatcherError> {
    let height = block_height(block)?;
    // read_history already retained authenticated bytes. Finality suppresses
    // resolution too: otherwise a rescan can stall forever on an old cache miss.
    if height <= config.last_finalized_j_height {
        return Ok(None);
    }
    let block_hash = fixed_hex::<32>(&block.hash, "blockHash")?;
    let mut events = Vec::new();
    let mut dispute_finalization_evidence = Vec::new();
    let mut seen = BTreeSet::new();
    let mut global_log_index = 0_u64;
    for receipt in receipts {
        let batch_nonces = receipt_batch_nonces(config, receipt)?;
        for log in &receipt.logs {
            collect_log(
                config,
                height,
                block_hash,
                log,
                global_log_index,
                &mut events,
                &mut dispute_finalization_evidence,
                &mut seen,
                &batch_nonces,
                history,
            )?;
            global_log_index = global_log_index
                .checked_add(1)
                .ok_or(JWatcherError::Cursor)?;
        }
    }
    if events.is_empty() {
        return Ok(None);
    }
    project_finalized_j_event_batch(
        &config.entity_id,
        height,
        block_hash,
        events,
        dispute_finalization_evidence,
    )
    .map(Some)
    .map_err(|error| JWatcherError::Account(error.to_string()))
}

/// The audience of every dispute event: its sender and its counterentity, as
/// in TS `isEventRelevantToEntity`. This watcher serves `config.entity_id`, so
/// any other dispute is never emitted.
fn dispute_log_is_local(
    config: &JWatcherConfig,
    log: &super::types::RpcLog,
) -> Result<bool, JWatcherError> {
    if log.topics.len() != 4 {
        return Err(JWatcherError::EventAbi("disputeTopics"));
    }
    let sender = entity_word_value(
        &fixed_hex::<32>(&log.topics[1], "disputeSender")?,
        "disputeSender",
    )?;
    let counterentity = entity_word_value(
        &fixed_hex::<32>(&log.topics[2], "disputeCounterentity")?,
        "disputeCounterentity",
    )?;
    Ok(local_entity(config, &sender) || local_entity(config, &counterentity))
}

fn receipt_batch_nonces(
    config: &JWatcherConfig,
    receipt: &RpcReceipt,
) -> Result<BTreeMap<EntityId, i64>, JWatcherError> {
    let mut nonces = BTreeMap::new();
    for log in &receipt.logs {
        if fixed_hex::<20>(&log.address, "logAddress")? != config.depository_address
            || event_kind(log)? != Some(ContractEventKind::HankoBatchProcessed)
        {
            continue;
        }
        let words = decode_static_words(log, 2, 1)?;
        let nonce = i64::try_from(safe_uint(&words.data[0], "batchNonce")?)
            .map_err(|_| JWatcherError::SafeInteger("batchNonce"))?;
        nonces.insert(entity_word_value(&words.topics[0], "batchEntity")?, nonce);
    }
    Ok(nonces)
}

#[allow(clippy::too_many_arguments)]
fn collect_log(
    config: &JWatcherConfig,
    height: u64,
    block_hash: [u8; 32],
    log: &super::types::RpcLog,
    log_index: u64,
    events: &mut Vec<JurisdictionEvent>,
    dispute_finalization_evidence: &mut Vec<DisputeFinalizationEvidence>,
    seen: &mut BTreeSet<([u8; 32], u64, u64, EntityId)>,
    batch_nonces: &BTreeMap<EntityId, i64>,
    history: &DisputeReferences,
) -> Result<(), JWatcherError> {
    let address = fixed_hex::<20>(&log.address, "logAddress")?;
    require_current_depository_money_abi(log, &address, &config.depository_address)?;
    let Some(kind) = event_kind(log)? else {
        return Ok(());
    };
    let allowed = match kind {
        ContractEventKind::FoundationBootstrapped
        | ContractEventKind::EntityRegistered
        | ContractEventKind::BoardActivated
        | ContractEventKind::EntityProviderActionExecuted
        | ContractEventKind::EntityProviderActionCancelled => {
            address == config.entity_provider_address
        }
        ContractEventKind::Erc20Transfer | ContractEventKind::Erc20Approval => {
            config.erc20_tokens.contains_key(&address)
        }
        _ => address == config.depository_address,
    };
    if !allowed {
        return Ok(());
    }
    let tx_hash = fixed_hex::<32>(&log.transaction_hash, "transactionHash")?;
    let metadata = event_metadata(height, block_hash, tx_hash, log_index, None);
    if kind != ContractEventKind::AccountSettled {
        collect_single_event(
            config,
            address,
            kind,
            log,
            metadata,
            events,
            dispute_finalization_evidence,
            batch_nonces,
            history,
        )?;
        return Ok(());
    }
    let relevant = relevant_settlements(config, decode_account_settled(log)?);
    let include_index = relevant.len() > 1;
    for (index, (settled, account_id)) in relevant.into_iter().enumerate() {
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
        let event = JurisdictionEvent::AccountSettled(into_event(
            settled,
            height,
            block_hash,
            tx_hash,
            log_index,
            event_index,
        ));
        events.push(event);
    }
    Ok(())
}

fn event_metadata(
    block_number: u64,
    block_hash: [u8; 32],
    transaction_hash: [u8; 32],
    log_index: u64,
    event_index: Option<u64>,
) -> JEventMetadata {
    JEventMetadata {
        block_number: Some(block_number),
        block_hash: Some(block_hash),
        transaction_hash: Some(transaction_hash),
        log_index: Some(log_index),
        event_index,
    }
}

fn i64_word(word: &[u8; 32], field: &'static str) -> Result<i64, JWatcherError> {
    i64::try_from(safe_uint(word, field)?).map_err(|_| JWatcherError::SafeInteger(field))
}

fn local_entity(config: &JWatcherConfig, value: &EntityId) -> bool {
    value == &config.entity_id
}

#[allow(clippy::too_many_arguments)]
fn collect_single_event(
    config: &JWatcherConfig,
    address: [u8; 20],
    kind: ContractEventKind,
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    events: &mut Vec<JurisdictionEvent>,
    dispute_finalization_evidence: &mut Vec<DisputeFinalizationEvidence>,
    batch_nonces: &BTreeMap<EntityId, i64>,
    history: &DisputeReferences,
) -> Result<(), JWatcherError> {
    let event = match kind {
        ContractEventKind::ReserveUpdated => {
            let words = decode_static_words(log, 2, 1)?;
            let entity = entity_word_value(&words.topics[0], "reserveEntity")?;
            if !local_entity(config, &entity) {
                return Ok(());
            }
            let token_id = i64_word(&words.topics[1], "reserveTokenId")?;
            let own_reserve = bigint(&words.data[0]);
            JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
                metadata,
                entity: entity.as_hex(),
                token_id,
                new_balance: own_reserve,
            })
        }
        ContractEventKind::SecretRevealed => {
            let words = decode_static_words(log, 2, 1)?;
            JurisdictionEvent::SecretRevealed(SecretRevealedEvent {
                metadata,
                hashlock: hex(&words.topics[0]),
                revealer: hex(&words.topics[1]),
                secret: hex(&words.data[0]),
            })
        }
        ContractEventKind::HashLadderRevealRegistered => {
            let words = decode_static_words(log, 2, 9)?;
            let writer = entity_word_value(&words.topics[0], "ladderWriter")?;
            let counterparty = entity_word_value(&words.topics[1], "ladderCounterparty")?;
            let fill_ratio = u16::try_from(safe_uint(&words.data[1], "fillRatio")?)
                .map_err(|_| JWatcherError::SafeInteger("fillRatio"))?;
            let target_role = bool_word(&words.data[7], "targetRole")?;
            let revealed_at = safe_uint(&words.data[8], "revealedAt")?;
            if fill_ratio == 0 || revealed_at == 0 {
                return Err(JWatcherError::EventAbi("hashLadderDomain"));
            }
            let relevant = writer == config.entity_id
                || config
                    .hash_ladders
                    .contains(&super::types::WatchedHashLadder {
                        writer: writer.clone(),
                        counterparty: counterparty.clone(),
                        ladder_hash: words.data[0],
                        target_role,
                    });
            if !relevant {
                return Ok(());
            }
            JurisdictionEvent::HashLadderRevealRegistered(HashLadderRevealRegisteredEvent {
                metadata,
                entity: writer.as_hex(),
                counterparty_entity: counterparty.as_hex(),
                ladder_hash: words.data[0],
                fill_ratio,
                full_secret: words.data[2],
                reveals: [words.data[3], words.data[4], words.data[5], words.data[6]],
                target_role,
                revealed_at,
            })
        }
        ContractEventKind::DebtCreated => {
            let words = decode_static_words(log, 3, 4)?;
            let debtor = entity_word_value(&words.topics[0], "debtor")?;
            let creditor = entity_word_value(&words.topics[1], "creditor")?;
            if !local_entity(config, &debtor) && !local_entity(config, &creditor) {
                return Ok(());
            }
            JurisdictionEvent::DebtCreated(DebtCreatedEvent {
                metadata,
                debtor: debtor.as_hex(),
                creditor: creditor.as_hex(),
                token_id: i64_word(&words.topics[2], "debtTokenId")?,
                amount: uint512(&words.data[0], &words.data[1]),
                debt_index: i64_word(&words.data[2], "debtIndex")?,
                debt_seq: super::abi::bigint(&words.data[3]),
            })
        }
        ContractEventKind::DebtEnforced => {
            let words = decode_static_words(log, 3, 4)?;
            let debtor = entity_word_value(&words.topics[0], "debtor")?;
            let creditor = entity_word_value(&words.topics[1], "creditor")?;
            if !local_entity(config, &debtor) && !local_entity(config, &creditor) {
                return Ok(());
            }
            JurisdictionEvent::DebtEnforced(DebtEnforcedEvent {
                metadata,
                debtor: debtor.as_hex(),
                creditor: creditor.as_hex(),
                token_id: i64_word(&words.topics[2], "debtTokenId")?,
                amount_paid: bigint(&words.data[0]),
                remaining_amount: uint512(&words.data[1], &words.data[2]),
                new_debt_index: i64_word(&words.data[3], "newDebtIndex")?,
            })
        }
        ContractEventKind::DebtForgiven => {
            let words = decode_static_words(log, 3, 3)?;
            let debtor = entity_word_value(&words.topics[0], "debtor")?;
            let creditor = entity_word_value(&words.topics[1], "creditor")?;
            if !local_entity(config, &debtor) && !local_entity(config, &creditor) {
                return Ok(());
            }
            JurisdictionEvent::DebtForgiven(DebtForgivenEvent {
                metadata,
                debtor: debtor.as_hex(),
                creditor: creditor.as_hex(),
                token_id: i64_word(&words.topics[2], "debtTokenId")?,
                amount_forgiven: uint512(&words.data[0], &words.data[1]),
                debt_index: i64_word(&words.data[2], "debtIndex")?,
            })
        }
        ContractEventKind::HankoBatchProcessed => {
            let words = decode_static_words(log, 2, 1)?;
            let entity_id = entity_word_value(&words.topics[0], "batchEntity")?;
            if !local_entity(config, &entity_id) {
                return Ok(());
            }
            let nonce = safe_uint(&words.data[0], "batchNonce")?;
            if nonce == 0 {
                return Err(JWatcherError::EventAbi("batchNonce"));
            }
            JurisdictionEvent::HankoBatchProcessed(HankoBatchProcessedEvent {
                metadata,
                entity_id,
                batch_hash: words.topics[1],
                nonce,
            })
        }
        ContractEventKind::FoundationBootstrapped => {
            let words = decode_static_words(log, 2, 2)?;
            JurisdictionEvent::FoundationBootstrapped(FoundationBootstrappedEvent {
                metadata,
                recipient: address_word(&words.topics[0], "foundationRecipient")?,
                board_hash: words.topics[1],
                control_token_id: bigint(&words.data[0]),
                dividend_token_id: bigint(&words.data[1]),
            })
        }
        ContractEventKind::EntityRegistered => {
            let words = decode_static_words(log, 2, 1)?;
            JurisdictionEvent::EntityRegistered(EntityRegisteredEvent {
                metadata,
                entity_id: entity_word_value(&words.topics[0], "registeredEntity")?,
                entity_number: bigint(&words.topics[1]),
                board_hash: words.data[0],
            })
        }
        ContractEventKind::BoardActivated => {
            let words = decode_static_words(log, 1, 4)?;
            let until = bigint(&words.data[2]);
            if until <= 0.into() {
                return Err(JWatcherError::EventAbi("previousBoardValidUntil"));
            }
            let board_epoch = bigint(&words.data[3]);
            if board_epoch <= 0.into() {
                return Err(JWatcherError::EventAbi("boardEpoch"));
            }
            JurisdictionEvent::BoardActivated(BoardActivatedEvent {
                metadata,
                entity_id: entity_word_value(&words.topics[0], "boardEntity")?,
                previous_board_hash: words.data[0],
                new_board_hash: words.data[1],
                previous_board_valid_until: until,
                board_epoch,
            })
        }
        ContractEventKind::EntityProviderActionExecuted => {
            let words = decode_static_words(log, 3, 1)?;
            let entity_id = entity_word_value(&words.topics[0], "actionEntity")?;
            if !local_entity(config, &entity_id) {
                return Ok(());
            }
            let action_nonce = bigint(&words.topics[1]);
            if action_nonce <= 0.into() {
                return Err(JWatcherError::EventAbi("actionNonce"));
            }
            let kind = u8::try_from(safe_uint(&words.data[0], "actionKind")?)
                .map_err(|_| JWatcherError::EventAbi("actionKind"))?;
            if kind > 1 {
                return Err(JWatcherError::EventAbi("actionKind"));
            }
            JurisdictionEvent::EntityProviderActionExecuted(EntityProviderActionExecutedEvent {
                metadata,
                entity_id,
                action_nonce,
                action_hash: words.topics[2],
                action_kind: kind,
            })
        }
        ContractEventKind::EntityProviderActionCancelled => {
            let words = decode_static_words(log, 3, 2)?;
            let entity_id = entity_word_value(&words.topics[0], "cancelEntity")?;
            if !local_entity(config, &entity_id) {
                return Ok(());
            }
            let action_nonce = bigint(&words.topics[1]);
            if action_nonce <= 0.into() {
                return Err(JWatcherError::EventAbi("actionNonce"));
            }
            let kind = u8::try_from(safe_uint(&words.data[0], "cancelledActionKind")?)
                .map_err(|_| JWatcherError::EventAbi("cancelledActionKind"))?;
            if kind > 1 {
                return Err(JWatcherError::EventAbi("cancelledActionKind"));
            }
            JurisdictionEvent::EntityProviderActionCancelled(EntityProviderActionCancelledEvent {
                metadata,
                entity_id,
                action_nonce,
                cancelled_action_hash: words.topics[2],
                cancelled_action_kind: kind,
                cancel_hash: words.data[1],
            })
        }
        ContractEventKind::Erc20Transfer | ContractEventKind::Erc20Approval => {
            collect_wallet_events(config, address, kind, log, metadata, events)?;
            return Ok(());
        }
        ContractEventKind::DisputeStarted
        | ContractEventKind::DisputeFinalized
        | ContractEventKind::CounterDisputeRegistered => {
            if !dispute_log_is_local(config, log)? {
                return Ok(());
            }
            let decoded = decode_dispute_event(kind, log, metadata, batch_nonces, history)?;
            if let Some(evidence) = decoded.evidence {
                dispute_finalization_evidence.push(evidence);
            }
            decoded.event
        }
        ContractEventKind::AccountSettled => return Err(JWatcherError::EventAbi("dispatch")),
    };
    events.push(event);
    Ok(())
}

fn collect_wallet_events(
    config: &JWatcherConfig,
    token_address: [u8; 20],
    kind: ContractEventKind,
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    events: &mut Vec<JurisdictionEvent>,
) -> Result<(), JWatcherError> {
    let token_id = config
        .erc20_tokens
        .get(&token_address)
        .copied()
        .ok_or(JWatcherError::WalletCursor)?;
    let words = decode_static_words(log, 2, 1)?;
    let first = address_word(&words.topics[0], "erc20Owner")?;
    let second = address_word(&words.topics[1], "erc20Peer")?;
    let amount = bigint(&words.data[0]);
    for wallet in &config.external_wallets {
        let event = match kind {
            ContractEventKind::Erc20Transfer => {
                if first == second {
                    continue;
                }
                let baseline = wallet.balances.get(&token_address);
                let Some((tracked_token, snapshot_height)) = baseline else {
                    continue;
                };
                if *tracked_token != token_id
                    || metadata.block_number.unwrap_or_default()
                        <= wallet.watch_after_block.max(*snapshot_height)
                {
                    continue;
                }
                let balance_delta = if wallet.owner == first {
                    -amount.clone()
                } else if wallet.owner == second {
                    amount.clone()
                } else {
                    continue;
                };
                JurisdictionEvent::ExternalWalletDelta(ExternalWalletDeltaEvent {
                    metadata: metadata.clone(),
                    entity_id: wallet.entity_id.as_hex(),
                    owner: wallet.owner,
                    token_address,
                    token_id: Some(
                        i64::try_from(token_id)
                            .map_err(|_| JWatcherError::SafeInteger("walletTokenId"))?,
                    ),
                    balance_delta: Some(balance_delta),
                    spender: None,
                    allowance: None,
                })
            }
            ContractEventKind::Erc20Approval => {
                if wallet.owner != first {
                    continue;
                }
                let Some(snapshot_height) = wallet.allowances.get(&(token_address, second)) else {
                    continue;
                };
                if metadata.block_number.unwrap_or_default()
                    <= wallet.watch_after_block.max(*snapshot_height)
                {
                    continue;
                }
                JurisdictionEvent::ExternalWalletDelta(ExternalWalletDeltaEvent {
                    metadata: metadata.clone(),
                    entity_id: wallet.entity_id.as_hex(),
                    owner: wallet.owner,
                    token_address,
                    token_id: Some(
                        i64::try_from(token_id)
                            .map_err(|_| JWatcherError::SafeInteger("walletTokenId"))?,
                    ),
                    balance_delta: None,
                    spender: Some(second),
                    allowance: Some(amount.clone()),
                })
            }
            _ => return Err(JWatcherError::EventAbi("walletDispatch")),
        };
        events.push(event);
    }
    Ok(())
}

fn u256_bigint(value: &ethabi::ethereum_types::U256) -> num_bigint::BigInt {
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    num_bigint::BigInt::from_bytes_be(num_bigint::Sign::Plus, &bytes)
}

fn proof_body(value: &JBatchProofBody) -> ProofBody {
    ProofBody {
        watch_seed: hex(&value.watch_seed),
        left_response_seconds: u64::from(value.left_response_seconds),
        right_response_seconds: u64::from(value.right_response_seconds),
        offdeltas: value.offdeltas.clone(),
        token_ids: value.token_ids.iter().map(u256_bigint).collect(),
        transformers: value
            .transformers
            .iter()
            .map(|clause| ProofTransformerClause {
                transformer_address: hex(&clause.transformer_address),
                encoded_batch: hex(&clause.encoded_batch),
                allowances: clause
                    .allowances
                    .iter()
                    .map(|allowance| ProofAllowance {
                        delta_index: u256_bigint(&allowance.delta_index),
                        right_allowance: u256_bigint(&allowance.right_allowance),
                        left_allowance: u256_bigint(&allowance.left_allowance),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn finalization_evidence_hash(
    value: &xln_rscore_entity_kernel::j_batch::FinalDisputeProof,
) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    let mut final_nonce = [0_u8; 32];
    value.final_nonce.to_big_endian(&mut final_nonce);
    let mut proposer = [0_u8; 32];
    proposer[31] = u8::from(value.proposer_is_left);
    let mut started = [0_u8; 32];
    started[31] = u8::from(value.started_by_left);
    let mut bytes = Vec::with_capacity(7 * 32);
    bytes.extend_from_slice(&value.initial_proofbody_hash);
    bytes.extend_from_slice(&final_nonce);
    bytes.extend_from_slice(&proposer);
    bytes.extend_from_slice(&started);
    bytes.extend_from_slice(&Keccak256::digest(&value.starter_arguments));
    bytes.extend_from_slice(&Keccak256::digest(&value.other_arguments));
    bytes.extend_from_slice(&Keccak256::digest(&value.sig));
    Keccak256::digest(bytes).into()
}

struct DecodedDisputeEvent {
    event: JurisdictionEvent,
    evidence: Option<DisputeFinalizationEvidence>,
}

// Current logs bind bodies and starter arguments from earlier logs by hash; no transaction lookup.
fn decode_dispute_event(
    kind: ContractEventKind,
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    batch_nonces: &BTreeMap<EntityId, i64>,
    history: &DisputeReferences,
) -> Result<DecodedDisputeEvent, JWatcherError> {
    match kind {
        ContractEventKind::DisputeStarted => {
            decode_dispute_started_event(log, metadata, batch_nonces)
        }
        ContractEventKind::CounterDisputeRegistered => {
            decode_counter_dispute_event(log, metadata, batch_nonces, history)
        }
        ContractEventKind::DisputeFinalized => {
            decode_dispute_finalized_event(log, metadata, batch_nonces, history)
        }
        _ => Err(JWatcherError::EventAbi("disputeDispatch")),
    }
}

fn decode_dispute_started_event(
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    batch_nonces: &BTreeMap<EntityId, i64>,
) -> Result<DecodedDisputeEvent, JWatcherError> {
    let decoded = decode_dispute_started(log)?;
    if decoded.dispute_start_timestamp == 0
        || decoded.dispute_timeout
            != decoded
                .dispute_start_timestamp
                .checked_add(decoded.left_response_seconds)
                .and_then(|value| value.checked_add(decoded.right_response_seconds))
                .ok_or(JWatcherError::EventAbi("disputeClock"))?
    {
        return Err(JWatcherError::DisputeEvidence("start-binding"));
    }
    let body = decode_log_proof_body(&decoded.proofbody, &decoded.proofbody_hash)?;
    if body.watch_seed != decoded.watch_seed
        || u64::from(body.left_response_seconds) != decoded.left_response_seconds
        || u64::from(body.right_response_seconds) != decoded.right_response_seconds
    {
        return Err(JWatcherError::DisputeEvidence("start-binding"));
    }
    Ok(DecodedDisputeEvent {
        event: JurisdictionEvent::DisputeStarted(DisputeStartedEvent {
            metadata,
            sender: decoded.sender.as_hex(),
            counterentity: decoded.counterentity.as_hex(),
            nonce: num_bigint::BigInt::from_biguint(num_bigint::Sign::Plus, decoded.nonce),
            proposer_is_left: decoded.proposer_is_left,
            proofbody_hash: hex(&decoded.proofbody_hash),
            watch_seed: decoded.watch_seed,
            starter_initial_arguments: decoded.starter_initial_arguments,
            starter_counter_arguments: decoded.starter_counter_arguments,
            starter_counter_proof_commitment: decoded.starter_counter_proof_commitment,
            initial_proofbody: proof_body(&body),
            dispute_timeout: decoded.dispute_timeout,
            dispute_start_timestamp: decoded.dispute_start_timestamp,
            left_response_seconds: decoded.left_response_seconds,
            right_response_seconds: decoded.right_response_seconds,
            batch_nonce: batch_nonces.get(&decoded.sender).copied(),
        }),
        evidence: None,
    })
}

fn decode_counter_dispute_event(
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    _batch_nonces: &BTreeMap<EntityId, i64>,
    history: &DisputeReferences,
) -> Result<DecodedDisputeEvent, JWatcherError> {
    let values = decode_dispute_log(
        log,
        &[
            ethabi::ParamType::Bool,
            ethabi::ParamType::FixedBytes(32),
            ethabi::ParamType::Bytes,
        ],
    )?;
    let sender = entity_word_value(
        &fixed_hex::<32>(&log.topics[1], "counterSender")?,
        "counterSender",
    )?;
    let counterentity = entity_word_value(
        &fixed_hex::<32>(&log.topics[2], "counterEntity")?,
        "counterEntity",
    )?;
    let nonce = safe_uint(
        &fixed_hex::<32>(&log.topics[3], "counterNonce")?,
        "counterNonce",
    )?;
    let proposer_is_left = token_bool(&values[0])?;
    let proofbody_hash = token_word(&values[1])?;
    let encoded = super::dispute_reference::body_bytes(
        log,
        &token_bytes(&values[2])?,
        &proofbody_hash,
        history,
    )?;
    let body = decode_log_proof_body(&encoded, &proofbody_hash)?;
    Ok(DecodedDisputeEvent {
        event: JurisdictionEvent::CounterDisputeRegistered(CounterDisputeRegisteredEvent {
            metadata,
            sender: sender.as_hex(),
            counterentity: counterentity.as_hex(),
            nonce: i64::try_from(nonce).map_err(|_| JWatcherError::SafeInteger("counterNonce"))?,
            proposer_is_left,
            proofbody_hash,
            counter_proofbody: proof_body(&body),
        }),
        evidence: None,
    })
}

fn decode_dispute_finalized_event(
    log: &super::types::RpcLog,
    metadata: JEventMetadata,
    batch_nonces: &BTreeMap<EntityId, i64>,
    history: &DisputeReferences,
) -> Result<DecodedDisputeEvent, JWatcherError> {
    use ethabi::{ParamType as P, Token};
    let values = decode_dispute_log(
        log,
        &[
            P::FixedBytes(32),
            P::FixedBytes(32),
            P::Bytes,
            P::Tuple(vec![
                P::FixedBytes(32),
                P::Uint(256),
                P::Bool,
                P::Bool,
                P::FixedBytes(32),
                P::Bytes,
                P::Bytes,
            ]),
        ],
    )?;
    let sender = entity_word_value(
        &fixed_hex::<32>(&log.topics[1], "finalSender")?,
        "finalSender",
    )?;
    let counterentity = entity_word_value(
        &fixed_hex::<32>(&log.topics[2], "finalCounterentity")?,
        "finalCounterentity",
    )?;
    let initial_nonce = bigint(&fixed_hex::<32>(&log.topics[3], "initialNonce")?);
    let final_proofbody_hash = token_word(&values[0])?;
    let evidence_hash = token_word(&values[1])?;
    let encoded = super::dispute_reference::body_bytes(
        log,
        &token_bytes(&values[2])?,
        &final_proofbody_hash,
        history,
    )?;
    let body = decode_log_proof_body(&encoded, &final_proofbody_hash)?;
    let Token::Tuple(fields) = &values[3] else {
        return Err(JWatcherError::EventAbi("finalizationData"));
    };
    let Token::Uint(final_nonce) = fields[1] else {
        return Err(JWatcherError::EventAbi("finalNonce"));
    };
    let candidate = xln_rscore_entity_kernel::j_batch::FinalDisputeProof {
        counterentity: *counterentity.as_bytes(),
        initial_nonce: ethabi::ethereum_types::U256::from_big_endian(&fixed_hex::<32>(
            &log.topics[3],
            "initialNonce",
        )?),
        final_nonce,
        proposer_is_left: token_bool(&fields[2])?,
        initial_proofbody_hash: token_word(&fields[0])?,
        final_proofbody: body,
        starter_arguments: super::dispute_reference::starter_arguments(
            log,
            &token_word(&fields[0])?,
            &token_word(&fields[4])?,
            history,
        )?,
        other_arguments: token_bytes(&fields[5])?,
        sig: token_bytes(&fields[6])?,
        started_by_left: token_bool(&fields[3])?,
        cooperative: false,
        submit_not_before_timestamp: None,
    };
    if finalization_evidence_hash(&candidate) != evidence_hash {
        return Err(JWatcherError::DisputeEvidence("finalized"));
    }
    let starter_arguments = hex(&candidate.starter_arguments);
    let other_arguments = hex(&candidate.other_arguments);
    let (left_arguments, right_arguments) = if candidate.started_by_left {
        (starter_arguments, other_arguments)
    } else {
        (other_arguments, starter_arguments)
    };
    Ok(DecodedDisputeEvent {
        event: JurisdictionEvent::DisputeFinalized(DisputeFinalizedEvent {
            metadata,
            sender: sender.as_hex(),
            counterentity: counterentity.as_hex(),
            initial_nonce: initial_nonce.clone(),
            initial_proofbody_hash: hex(&candidate.initial_proofbody_hash),
            final_proofbody_hash: hex(&final_proofbody_hash),
            finalization_evidence_hash: hex(&evidence_hash),
            final_proofbody: proof_body(&candidate.final_proofbody),
            batch_nonce: batch_nonces.get(&sender).copied(),
        }),
        evidence: Some(DisputeFinalizationEvidence {
            sender: sender.as_hex(),
            counterentity: counterentity.as_hex(),
            initial_nonce: initial_nonce.to_string(),
            final_nonce: u256_bigint(&candidate.final_nonce).to_string(),
            initial_proofbody_hash: hex(&candidate.initial_proofbody_hash),
            final_proofbody_hash: hex(&final_proofbody_hash),
            proposer_is_left: candidate.proposer_is_left,
            left_arguments,
            right_arguments,
            started_by_left: candidate.started_by_left,
            sig: hex(&candidate.sig),
        }),
    })
}

fn relevant_settlements(
    config: &JWatcherConfig,
    values: Vec<super::abi::DecodedSettlement>,
) -> Vec<(super::abi::DecodedSettlement, EntityId)> {
    values
        .into_iter()
        .filter_map(|value| {
            if value.left == config.entity_id {
                Some((value.clone(), value.right.clone()))
            } else if value.right == config.entity_id {
                Some((value.clone(), value.left.clone()))
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
    cursor.dispute_references.validate(cursor.scanned_through)?;
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

pub(super) fn decode_log_proof_body(
    bytes: &[u8],
    hash: &[u8; 32],
) -> Result<JBatchProofBody, JWatcherError> {
    use sha3::{Digest, Keccak256};
    if <[u8; 32]>::from(Keccak256::digest(bytes)) != *hash {
        return Err(JWatcherError::DisputeEvidence("proofbody-hash"));
    }
    xln_rscore_entity_kernel::decode_proof_body(bytes)
        .map_err(|_| JWatcherError::DisputeEvidence("proofbody-abi"))
}
