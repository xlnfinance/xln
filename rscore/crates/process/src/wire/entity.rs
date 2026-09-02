//! Entity snapshot and resident-round process wire codec.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_engine::{AccountDomain, DepositoryAddress, OpaqueHtlcCiphertext};
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookStateSnapshot, CrontabState,
    CrontabTaskMethod, CrontabTaskParam, CrontabTaskState, DeterministicContext,
    EntityCanonicalCollection, EntityCommandNonceRecord, EntityCommandNonceState,
    EntityConsensusSection, EntityKernelCommitments, EntityKernelOutput, EntityReferral,
    EntityStateSnapshot, HtlcPreparedBinding, HtlcPreparedOutcome, HubProfile,
    OrderbookConsensusMetadata, OrderbookStateSnapshot, PairDimensions, PairPolicy, PaybookEntry,
    PaybookState, PreparedHtlcEntry, ResidentEntityResult, ScheduledHook, ScheduledHookKind,
    ScheduledHookMap, SpreadDistribution,
};
use xln_rscore_protocol::CanonicalNumber;

use crate::ProcessError;
use crate::wire_value::{
    bigint, boolean, bounded_u32, exact, fixed_bytes, hex_fixed, js_number, optional_text, text,
    text_list, tuple, unsigned,
};

fn optional_bigint(value: &AbiValue, field: &'static str) -> Result<Option<BigInt>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(bigint(value, field)?)),
    }
}

fn optional_u64(value: &AbiValue, field: &'static str) -> Result<Option<u64>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(js_number(value, field)?)),
    }
}

fn optional_hex(
    value: &AbiValue,
    field: &'static str,
    length: usize,
) -> Result<Option<String>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(hex_fixed(value, field, length)?)),
    }
}

fn map_insert<K: Ord, V>(
    map: &mut BTreeMap<K, V>,
    key: K,
    value: V,
    field: &'static str,
) -> Result<(), ProcessError> {
    if map.insert(key, value).is_some() {
        return Err(ProcessError::Expected(field));
    }
    Ok(())
}

fn decode_paybook_entry(value: &AbiValue) -> Result<(String, PaybookEntry), ProcessError> {
    let row = exact(tuple(value)?, 16, "entityPaybookEntry")?;
    let hashlock = hex_fixed(&row[0], "hashlock", 32)?;
    Ok((
        hashlock.clone(),
        PaybookEntry {
            hashlock,
            description: optional_text(&row[15])?,
            token_id: match &row[1] {
                AbiValue::Nil => None,
                value => Some(
                    u16::try_from(bounded_u32(value, "tokenId")?)
                        .map_err(|_| ProcessError::Expected("tokenId"))?,
                ),
            },
            amount: optional_bigint(&row[2], "routeAmount")?,
            started_at_ms: optional_u64(&row[3], "startedAtMs")?,
            originated: boolean(&row[4], "originated")?,
            inbound_entity: optional_hex(&row[5], "inboundEntity", 32)?,
            outbound_entity: optional_hex(&row[6], "outboundEntity", 32)?,
            inbound_settled: boolean(&row[7], "inboundSettled")?,
            outbound_settled: boolean(&row[8], "outboundSettled")?,
            secret: optional_hex(&row[9], "secret", 32)?,
            secret_ack_pending: boolean(&row[10], "secretAckPending")?,
            secret_ack_started_at: optional_u64(&row[11], "secretAckStartedAt")?,
            secret_ack_deadline_at: optional_u64(&row[12], "secretAckDeadlineAt")?,
            pending_fee: optional_bigint(&row[13], "pendingFee")?,
            created_timestamp: js_number(&row[14], "createdTimestamp")?,
        },
    ))
}

fn decode_page_entry(value: &AbiValue) -> Result<Option<BookPricePageEntrySnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 4, "bookPageEntry")?;
    Ok(Some(BookPricePageEntrySnapshot {
        order_id: text(&row[0])?.to_string(),
        owner_id: hex_fixed(&row[1], "bookOwnerId", 32)?,
        qty_lots: bigint(&row[2], "bookQtyLots")?,
        seq: js_number(&row[3], "bookSeq")?,
    }))
}

fn decode_page(value: &AbiValue) -> Result<BookPricePageSnapshot, ProcessError> {
    let row = exact(tuple(value)?, 7, "bookPricePage")?;
    Ok(BookPricePageSnapshot {
        price_ticks: bigint(&row[0], "priceTicks")?,
        page_sequence: u16::try_from(unsigned(&row[1], "pageSequence")?)
            .map_err(|_| ProcessError::Expected("pageSequence"))?,
        head_slot: usize::try_from(unsigned(&row[2], "headSlot")?)
            .map_err(|_| ProcessError::Expected("headSlot"))?,
        next_slot: usize::try_from(unsigned(&row[3], "nextSlot")?)
            .map_err(|_| ProcessError::Expected("nextSlot"))?,
        live_count: usize::try_from(unsigned(&row[4], "liveCount")?)
            .map_err(|_| ProcessError::Expected("liveCount"))?,
        total_qty_lots: bigint(&row[5], "totalQtyLots")?,
        slots: tuple(&row[6])?
            .iter()
            .map(decode_page_entry)
            .collect::<Result<_, _>>()?,
    })
}

fn decode_book(value: &AbiValue) -> Result<BookStateSnapshot, ProcessError> {
    let row = exact(tuple(value)?, 14, "bookState")?;
    Ok(BookStateSnapshot {
        bucket_width_ticks: bigint(&row[0], "bucketWidthTicks")?,
        stp_policy: u8::try_from(unsigned(&row[1], "stpPolicy")?)
            .map_err(|_| ProcessError::Expected("stpPolicy"))?,
        max_orders: usize::try_from(unsigned(&row[2], "maxOrders")?)
            .map_err(|_| ProcessError::Expected("maxOrders"))?,
        next_seq: js_number(&row[3], "nextSeq")?,
        trade_count: js_number(&row[4], "tradeCount")?,
        trade_qty_sum: bigint(&row[5], "tradeQtySum")?,
        last_trade_price_ticks: bigint(&row[6], "lastTradePriceTicks")?,
        last_accepted_usd_ask_price_ticks: bigint(&row[7], "lastAcceptedUsdAskPriceTicks")?,
        event_hash: bigint(&row[8], "eventHash")?,
        bid_pages: tuple(&row[9])?
            .iter()
            .map(decode_page)
            .collect::<Result<_, _>>()?,
        ask_pages: tuple(&row[10])?
            .iter()
            .map(decode_page)
            .collect::<Result<_, _>>()?,
        expected_bid_pages_root: hex_fixed(&row[11], "bidPagesRoot", 32)?,
        expected_ask_pages_root: hex_fixed(&row[12], "askPagesRoot", 32)?,
        expected_commitment_hash: hex_fixed(&row[13], "bookCommitment", 16)?,
    })
}

fn decode_orderbook(value: &AbiValue) -> Result<Option<OrderbookStateSnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 3, "orderbookState")?;
    let mut books = BTreeMap::new();
    for value in tuple(&row[0])? {
        let entry = exact(tuple(value)?, 2, "orderbookBook")?;
        map_insert(
            &mut books,
            text(&entry[0])?.to_string(),
            decode_book(&entry[1])?,
            "orderbookBookDuplicate",
        )?;
    }
    let mut pair_dimensions = BTreeMap::new();
    for value in tuple(&row[1])? {
        let entry = exact(tuple(value)?, 3, "orderbookPairDimensions")?;
        map_insert(
            &mut pair_dimensions,
            text(&entry[0])?.to_string(),
            PairDimensions {
                base_token_decimals: bounded_u32(&entry[1], "baseTokenDecimals")?,
                quote_token_decimals: bounded_u32(&entry[2], "quoteTokenDecimals")?,
            },
            "orderbookPairDimensionsDuplicate",
        )?;
    }
    let mut pair_by_order = BTreeMap::new();
    for (pair_id, book) in &books {
        for page in book.bid_pages.iter().chain(&book.ask_pages) {
            for order in page.slots.iter().flatten() {
                map_insert(
                    &mut pair_by_order,
                    order.order_id.clone(),
                    pair_id.clone(),
                    "pairByOrderDuplicate",
                )?;
            }
        }
    }
    Ok(Some(OrderbookStateSnapshot {
        books,
        pair_dimensions,
        offers: BTreeMap::new(),
        resolving_offers: BTreeSet::new(),
        pair_by_order,
        max_orders_per_pair: usize::try_from(unsigned(&row[2], "maxOrdersPerPair")?)
            .map_err(|_| ProcessError::Expected("maxOrdersPerPair"))?,
    }))
}

fn decode_metadata(value: &AbiValue) -> Result<Option<OrderbookConsensusMetadata>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 2, "orderbookMetadata")?;
    let profile = exact(tuple(&row[0])?, 7, "hubProfile")?;
    let spread = exact(tuple(&profile[2])?, 5, "spreadDistribution")?;
    let hub_profile = HubProfile {
        entity_id: hex_fixed(&profile[0], "hubEntityId", 32)?,
        name: text(&profile[1])?.to_string(),
        spread_distribution: SpreadDistribution {
            maker_bps: bounded_u32(&spread[0], "makerBps")?,
            taker_bps: bounded_u32(&spread[1], "takerBps")?,
            hub_bps: bounded_u32(&spread[2], "hubBps")?,
            maker_referrer_bps: bounded_u32(&spread[3], "makerReferrerBps")?,
            taker_referrer_bps: bounded_u32(&spread[4], "takerReferrerBps")?,
        },
        reference_token_id: bounded_u32(&profile[3], "referenceTokenId")?,
        usd_quote_authority_entity_id: hex_fixed(&profile[4], "usdQuoteAuthority", 32)?,
        min_trade_size: bigint(&profile[5], "minTradeSize")?,
        supported_pairs: text_list(&profile[6])?,
    };
    let mut referrals = BTreeMap::new();
    for value in tuple(&row[1])? {
        let entry = exact(tuple(value)?, 4, "entityReferral")?;
        let key = hex_fixed(&entry[0], "referralKey", 32)?;
        map_insert(
            &mut referrals,
            key,
            EntityReferral {
                entity_id: hex_fixed(&entry[1], "referralEntity", 32)?,
                referrer_id: optional_hex(&entry[2], "referrerId", 32)?,
                timestamp: js_number(&entry[3], "referralTimestamp")?,
            },
            "entityReferralDuplicate",
        )?;
    }
    Ok(Some(OrderbookConsensusMetadata {
        hub_profile,
        referrals,
    }))
}

fn decode_task_param(value: &AbiValue) -> Result<(String, CrontabTaskParam), ProcessError> {
    let row = exact(tuple(value)?, 3, "crontabTaskParam")?;
    let name = text(&row[0])?.to_string();
    if name.is_empty() {
        return Err(ProcessError::Expected("crontabTaskParamName"));
    }
    let tag = unsigned(&row[1], "crontabTaskParamTag")?;
    let value = match tag {
        0 => CrontabTaskParam::String(text(&row[2])?.to_string()),
        1 => CrontabTaskParam::Number(
            CanonicalNumber::parse_js_canonical(text(&row[2])?)
                .map_err(|_| ProcessError::Expected("crontabTaskParamNumber"))?,
        ),
        2 => CrontabTaskParam::Bool(boolean(&row[2], "crontabTaskParamBool")?),
        value => {
            return Err(ProcessError::Tag {
                field: "crontabTaskParam",
                value: i128::from(value),
            });
        }
    };
    Ok((name, value))
}

fn decode_crontab_task(value: &AbiValue) -> Result<CrontabTaskState, ProcessError> {
    let row = exact(tuple(value)?, 5, "crontabTask")?;
    if text(&row[0])? != "hubRebalance" {
        return Err(ProcessError::Expected("crontabTaskMethod"));
    }
    let mut params = BTreeMap::new();
    for value in tuple(&row[4])? {
        let (name, value) = decode_task_param(value)?;
        map_insert(&mut params, name, value, "crontabTaskParamDuplicate")?;
    }
    Ok(CrontabTaskState {
        method: CrontabTaskMethod::HubRebalance,
        interval_ms: js_number(&row[1], "crontabIntervalMs")?,
        last_run: js_number(&row[2], "crontabLastRun")?,
        enabled: boolean(&row[3], "crontabEnabled")?,
        params,
    })
}

fn decode_hook_kind(
    value: &AbiValue,
    field: &'static str,
) -> Result<ScheduledHookKind, ProcessError> {
    let row = tuple(value)?;
    let tag = row
        .first()
        .ok_or(ProcessError::Expected(field))
        .and_then(crate::wire_value::integer)?;
    let text_at = |index: usize, name: &'static str| {
        row.get(index)
            .ok_or(ProcessError::Expected(field))
            .and_then(text)
            .map(str::to_string)
            .map_err(|_| ProcessError::Expected(name))
    };
    let number_at = |index: usize, name: &'static str| {
        row.get(index)
            .ok_or(ProcessError::Expected(field))
            .and_then(|value| js_number(value, name))
    };
    match tag {
        0 if row.len() == 3 => Ok(ScheduledHookKind::HtlcTimeout {
            account_id: text_at(1, "crontabHookAccountId")?,
            lock_id: text_at(2, "crontabHookLockId")?,
        }),
        1 if row.len() == 2 => Ok(ScheduledHookKind::DisputeDeadline {
            account_id: text_at(1, "crontabHookAccountId")?,
        }),
        2 if row.len() == 3 => Ok(ScheduledHookKind::HtlcSecretAckTimeout {
            hashlock: text_at(1, "crontabHookHashlock")?,
            counterparty_entity_id: text_at(2, "crontabHookCounterparty")?,
        }),
        3 if row.len() == 1 => Ok(ScheduledHookKind::SettlementWindow),
        4 if row.len() == 1 => Ok(ScheduledHookKind::Watchdog),
        5 if row.len() == 3 => Ok(ScheduledHookKind::HubRebalanceKick {
            reason: text_at(1, "crontabHookReason")?,
            counterparty_id: text_at(2, "crontabHookCounterparty")?,
        }),
        6 if row.len() == 4 => Ok(ScheduledHookKind::BoardHankoRefresh {
            activation_j_height: number_at(1, "crontabHookActivationJHeight")?,
            activation_log_index: number_at(2, "crontabHookActivationLogIndex")?,
            after_counterparty_id: text_at(3, "crontabHookAfterCounterparty")?,
        }),
        7 if row.len() == 4 => Ok(ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline {
            account_id: text_at(1, "crontabHookAccountId")?,
            activation_j_height: number_at(2, "crontabHookActivationJHeight")?,
            activation_log_index: number_at(3, "crontabHookActivationLogIndex")?,
        }),
        8 if row.len() == 2 => Ok(ScheduledHookKind::CrossJOrderbookSweep {
            reason: text_at(1, "crontabHookReason")?,
        }),
        _ => Err(ProcessError::Tag { field, value: tag }),
    }
}

fn decode_crontab(value: &AbiValue) -> Result<Option<CrontabState>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 2, "entityCrontab")?;
    let mut tasks = BTreeMap::new();
    for value in tuple(&row[0])? {
        let task = decode_crontab_task(value)?;
        map_insert(
            &mut tasks,
            CrontabTaskMethod::HubRebalance,
            task,
            "crontabTaskDuplicate",
        )?;
    }
    let mut hooks = BTreeMap::new();
    for value in tuple(&row[1])? {
        let hook = exact(tuple(value)?, 4, "crontabHook")?;
        let id = text(&hook[0])?.to_string();
        let scheduled = ScheduledHook {
            id: id.clone(),
            trigger_at: js_number(&hook[1], "crontabHookTriggerAt")?,
            kind: decode_hook_kind(&hook[3], "crontabHookKind")?,
        };
        if text(&hook[2])?
            != match &scheduled.kind {
                ScheduledHookKind::HtlcTimeout { .. } => "htlc_timeout",
                ScheduledHookKind::DisputeDeadline { .. } => "dispute_deadline",
                ScheduledHookKind::HtlcSecretAckTimeout { .. } => "htlc_secret_ack_timeout",
                ScheduledHookKind::SettlementWindow => "settlement_window",
                ScheduledHookKind::Watchdog => "watchdog",
                ScheduledHookKind::HubRebalanceKick { .. } => "hub_rebalance_kick",
                ScheduledHookKind::BoardHankoRefresh { .. } => "board_hanko_refresh",
                ScheduledHookKind::CounterpartyBoardHankoRefreshDeadline { .. } => {
                    "counterparty_board_hanko_refresh_deadline"
                }
                ScheduledHookKind::CrossJOrderbookSweep { .. } => "cross_j_orderbook_sweep",
            }
        {
            return Err(ProcessError::Expected("crontabHookType"));
        }
        map_insert(&mut hooks, id, scheduled, "crontabHookDuplicate")?;
    }
    Ok(Some(CrontabState {
        tasks,
        hooks: ScheduledHookMap::restore(hooks)?,
    }))
}

fn decode_entity_collection(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<EntityCanonicalCollection>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let entries = tuple(value)?
        .iter()
        .map(|value| {
            let row = exact(tuple(value)?, 2, field)?;
            let key = text(&row[0])?.to_string();
            if key.is_empty() {
                return Err(ProcessError::Expected(field));
            }
            Ok((key, crate::canonical::canonical_value(&row[1])?))
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    EntityCanonicalCollection::from_entries(entries)
        .map(Some)
        .map_err(ProcessError::from)
}

pub fn decode_entity_snapshot(value: &AbiValue) -> Result<EntityStateSnapshot, ProcessError> {
    let row = exact(tuple(value)?, 30, "entityStateSnapshot")?;
    let mut reserves = BTreeMap::new();
    for value in tuple(&row[4])? {
        let entry = exact(tuple(value)?, 2, "entityReserve")?;
        let token_id = u16::try_from(bounded_u32(&entry[0], "reserveTokenId")?)
            .map_err(|_| ProcessError::Expected("reserveTokenId"))?;
        let amount = bigint(&entry[1], "reserveAmount")?;
        if token_id == 0 || amount < BigInt::from(0) {
            return Err(ProcessError::Expected("entityReserveValue"));
        }
        map_insert(&mut reserves, token_id, amount, "entityReserveDuplicate")?;
    }
    let mut known_accounts = BTreeSet::new();
    for value in tuple(&row[5])? {
        if !known_accounts.insert(hex_fixed(value, "knownAccount", 32)?) {
            return Err(ProcessError::Expected("knownAccountDuplicate"));
        }
    }
    let paybook = exact(tuple(&row[6])?, 2, "entityPaybook")?;
    let mut paybook_entries = BTreeMap::new();
    for value in tuple(&paybook[0])? {
        let (key, entry) = decode_paybook_entry(value)?;
        map_insert(&mut paybook_entries, key, entry, "paybookEntryDuplicate")?;
    }
    let expected_owned_sections = tuple(&row[9])?
        .iter()
        .map(|value| {
            let entry = exact(tuple(value)?, 2, "entityOwnedSection")?;
            Ok(EntityConsensusSection {
                field: text(&entry[0])?.to_string(),
                digest: hex_fixed(&entry[1], "entitySectionDigest", 32)?,
            })
        })
        .collect::<Result<_, ProcessError>>()?;
    let profile = exact(tuple(&row[13])?, 7, "entityProfile")?;
    let entity_kind = if matches!(profile[2], AbiValue::Nil) {
        None
    } else {
        Some(text(&profile[2])?.to_string())
    };
    let sectors = text_list(&profile[3])?;
    Ok(EntityStateSnapshot {
        entity_id: hex_fixed(&row[0], "entityId", 32)?,
        height: js_number(&row[1], "entityHeight")?,
        timestamp: js_number(&row[2], "entityTimestamp")?,
        entity_command_nonces: decode_entity_command_nonces(&row[11])?,
        proposals: xln_rscore_entity_kernel::decode_canonical_entity_proposals(
            &crate::canonical::canonical_value(&row[20])?,
        )?,
        last_finalized_j_height: js_number(&row[3], "lastFinalizedJHeight")?,
        reserves,
        out_debts_by_token: if matches!(row[24], AbiValue::Nil) {
            None
        } else {
            Some(xln_rscore_entity_kernel::decode_canonical_debt_ledger(
                &crate::canonical::canonical_value(&row[24])?,
            )?)
        },
        in_debts_by_token: if matches!(row[25], AbiValue::Nil) {
            None
        } else {
            Some(xln_rscore_entity_kernel::decode_canonical_debt_ledger(
                &crate::canonical::canonical_value(&row[25])?,
            )?)
        },
        external_wallet: if matches!(row[26], AbiValue::Nil) {
            None
        } else {
            Some(xln_rscore_entity_kernel::decode_canonical_external_wallet(
                &crate::canonical::canonical_value(&row[26])?,
            )?)
        },
        deferred_account_proposals: decode_entity_collection(&row[27], "deferredAccountProposals")?,
        settlement_continuations: decode_entity_collection(&row[28], "settlementContinuations")?,
        entity_encryption_public_key: fixed_bytes(&row[29], "entityEncryptionPublicKey")?,
        profile: xln_rscore_entity_kernel::EntityProfile {
            name: text(&profile[0])?.to_string(),
            is_hub: boolean(&profile[1], "entityProfileIsHub")?,
            entity_kind,
            sectors,
            avatar: text(&profile[4])?.to_string(),
            bio: text(&profile[5])?.to_string(),
            website: text(&profile[6])?.to_string(),
        },
        j_batch_state: if matches!(row[14], AbiValue::Nil) {
            None
        } else {
            Some(xln_rscore_entity_kernel::decode_canonical_j_batch_state(
                &crate::canonical::canonical_value(&row[14])?,
            )?)
        },
        entity_provider_action_state: if matches!(row[21], AbiValue::Nil) {
            None
        } else {
            Some(
                xln_rscore_entity_kernel::decode_canonical_entity_provider_action_state(
                    &crate::canonical::canonical_value(&row[21])?,
                )?,
            )
        },
        certified_board_state: if matches!(row[23], AbiValue::Nil) {
            None
        } else {
            Some(
                xln_rscore_entity_kernel::decode_canonical_certified_board_state(
                    &crate::canonical::canonical_value(&row[23])?,
                )?,
            )
        },
        swap_trading_pairs: if matches!(row[22], AbiValue::Nil) {
            None
        } else {
            Some(
                xln_rscore_entity_kernel::decode_canonical_swap_trading_pairs(
                    &crate::canonical::canonical_value(&row[22])?,
                )?,
            )
        },
        lending: if matches!(row[15], AbiValue::Nil) {
            None
        } else {
            Some(xln_rscore_entity_kernel::decode_canonical_lending_state(
                &crate::canonical::canonical_value(&row[15])?,
            )?)
        },
        cross_jurisdiction_swaps: decode_entity_collection(&row[16], "crossJurisdictionSwaps")?,
        cross_jurisdiction_authorizations: decode_entity_collection(
            &row[17],
            "crossJurisdictionAuthorizations",
        )?,
        pending_cross_jurisdiction_fill_acks: decode_entity_collection(
            &row[18],
            "pendingCrossJurisdictionFillAcks",
        )?,
        cross_jurisdiction_book_admissions: decode_entity_collection(
            &row[19],
            "crossJurisdictionBookAdmissions",
        )?,
        known_accounts,
        paybook: PaybookState::from_entries(
            paybook_entries.into_values(),
            bigint(&paybook[1], "paybookFeesEarned")?,
        )?,
        orderbook: decode_orderbook(&row[7])?,
        orderbook_metadata: decode_metadata(&row[8])?,
        expected_owned_sections,
        crontab: decode_crontab(&row[10])?,
        hub_rebalance_config: if matches!(row[12], AbiValue::Nil) {
            None
        } else {
            Some(crate::canonical::canonical_value(&row[12])?)
        },
        // This control-plane ABI row does not carry the jHistoryFinality
        // anchor; only the checkpoint/WAL restore path
        // (`entity_snapshot_from_graph`) does. Threading it into this wire
        // shape is a separate transport change.
        j_history_finality: None,
    })
}

fn decode_entity_command_nonces(
    value: &AbiValue,
) -> Result<Option<EntityCommandNonceState>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 4, "entityCommandNonces")?;
    if bounded_u32(&row[0], "entityCommandNonceVersion")? != 1 {
        return Err(ProcessError::Expected("entityCommandNonceVersion"));
    }
    let entries = tuple(&row[3])?;
    if entries.len() > 100 {
        return Err(ProcessError::Expected("entityCommandNonceSignerLimit"));
    }
    let mut by_signer = BTreeMap::new();
    for value in entries {
        let entry = exact(tuple(value)?, 3, "entityCommandNonceRecord")?;
        let signer = text(&entry[0])?;
        if signer.is_empty() || signer.trim().to_lowercase() != signer {
            return Err(ProcessError::Expected("entityCommandNonceSigner"));
        }
        let nonce = bigint(&entry[1], "entityCommandNonce")?;
        if nonce < BigInt::from(1_u8) {
            return Err(ProcessError::Expected("entityCommandNonce"));
        }
        map_insert(
            &mut by_signer,
            signer.to_string(),
            EntityCommandNonceRecord {
                nonce,
                command_hash: hex_fixed(&entry[2], "entityCommandHash", 32)?,
            },
            "entityCommandNonceSignerDuplicate",
        )?;
    }
    Ok(Some(EntityCommandNonceState {
        version: 1,
        board_hash: hex_fixed(&row[1], "entityCommandBoardHash", 32)?,
        board_epoch: js_number(&row[2], "entityCommandBoardEpoch")?,
        by_signer,
    }))
}

fn decode_prepared_htlc(
    value: &AbiValue,
) -> Result<((String, String), PreparedHtlcEntry), ProcessError> {
    let row = exact(tuple(value)?, 2, "preparedHtlc")?;
    let binding = exact(tuple(&row[0])?, 11, "preparedHtlcBinding")?;
    let domain = exact(tuple(&binding[2])?, 2, "preparedHtlcDomain")?;
    let account_frame_hash = hex_fixed(&binding[3], "accountFrameHash", 32)?;
    let hashlock = hex_fixed(&binding[6], "hashlock", 32)?;
    let binding = HtlcPreparedBinding {
        from_entity_id: hex_fixed(&binding[0], "fromEntityId", 32)?,
        to_entity_id: hex_fixed(&binding[1], "toEntityId", 32)?,
        domain: AccountDomain::new(
            js_number(&domain[0], "chainId")?,
            DepositoryAddress::parse(&hex_fixed(&domain[1], "depositoryAddress", 20)?)?,
        )?,
        account_frame_hash: account_frame_hash.clone(),
        account_height: js_number(&binding[4], "accountHeight")?,
        envelope_hash: hex_fixed(&binding[5], "envelopeHash", 32)?,
        hashlock: hashlock.clone(),
        token_id: u16::try_from(bounded_u32(&binding[7], "tokenId")?)
            .map_err(|_| ProcessError::Expected("tokenId"))?,
        amount: bigint(&binding[8], "amount")?,
        timelock: bigint(&binding[9], "timelock")?,
        reveal_before_height: js_number(&binding[10], "revealBeforeHeight")?,
    };
    let outcome = tuple(&row[1])?;
    let tag = outcome
        .first()
        .ok_or(ProcessError::Expected("preparedHtlcOutcomeTag"))?;
    let outcome = match crate::wire_value::integer(tag)? {
        0 => {
            let outcome = exact(outcome, 2, "preparedHtlcReject")?;
            HtlcPreparedOutcome::Reject {
                reason: text(&outcome[1])?.to_string(),
            }
        }
        1 => {
            let outcome = exact(outcome, 4, "preparedHtlcFinal")?;
            HtlcPreparedOutcome::Final {
                secret: hex_fixed(&outcome[1], "secret", 32)?,
                description: optional_text(&outcome[2])?,
                started_at_ms: optional_u64(&outcome[3], "startedAtMs")?,
            }
        }
        2 => {
            let outcome = exact(outcome, 4, "preparedHtlcForward")?;
            let AbiValue::Bytes(packed) = &outcome[3] else {
                return Err(ProcessError::Expected("innerEnvelope"));
            };
            HtlcPreparedOutcome::Forward {
                next_hop_entity_id: hex_fixed(&outcome[1], "nextHopEntityId", 32)?,
                forward_amount: bigint(&outcome[2], "forwardAmount")?,
                inner_envelope: OpaqueHtlcCiphertext::from_packed(packed.clone())?,
            }
        }
        value => {
            return Err(ProcessError::Tag {
                field: "preparedHtlcOutcome",
                value,
            });
        }
    };
    Ok((
        (account_frame_hash, hashlock),
        PreparedHtlcEntry { binding, outcome },
    ))
}

pub fn decode_context(value: &AbiValue) -> Result<DeterministicContext, ProcessError> {
    let row = exact(tuple(value)?, 5, "entityDeterministicContext")?;
    let mut pair_policies = BTreeMap::new();
    for value in tuple(&row[3])? {
        let entry = exact(tuple(value)?, 4, "pairPolicy")?;
        map_insert(
            &mut pair_policies,
            text(&entry[0])?.to_string(),
            PairPolicy {
                price_step_ticks: bounded_u32(&entry[1], "priceStepTicks")?,
                book_bucket_width_ticks: bounded_u32(&entry[2], "bookBucketWidthTicks")?,
                mid_price_ticks: bigint(&entry[3], "midPriceTicks")?,
            },
            "pairPolicyDuplicate",
        )?;
    }
    let mut prepared_htlcs = BTreeMap::new();
    for value in tuple(&row[4])? {
        let (key, entry) = decode_prepared_htlc(value)?;
        map_insert(&mut prepared_htlcs, key, entry, "preparedHtlcDuplicate")?;
    }
    Ok(DeterministicContext {
        minimum_trade_size: bigint(&row[0], "minimumTradeSize")?,
        swap_taker_fee_bps: u16::try_from(bounded_u32(&row[1], "swapTakerFeeBps")?)
            .map_err(|_| ProcessError::Expected("swapTakerFeeBps"))?,
        jurisdiction_id: optional_text(&row[2])?,
        pair_policies,
        prepared_htlcs,
        originated_htlcs: BTreeMap::new(),
    })
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)] // Wire tests stay beside their private decoder fixtures.
mod prepared_context_wire_tests {
    use super::*;

    fn tuple(fields: Vec<AbiValue>) -> AbiValue {
        AbiValue::Tuple(BodyTuple::from_vec(fields))
    }

    #[test]
    fn prepared_final_wire_preserves_description() {
        let binding = tuple(vec![
            AbiValue::Bytes(vec![0x11; 32]),
            AbiValue::Bytes(vec![0x22; 32]),
            tuple(vec![
                AbiValue::Integer(31_337),
                AbiValue::Bytes(vec![0x33; 20]),
            ]),
            AbiValue::Bytes(vec![0x44; 32]),
            AbiValue::Integer(1),
            AbiValue::Bytes(vec![0x66; 32]),
            AbiValue::Bytes(vec![0x77; 32]),
            AbiValue::Integer(7),
            AbiValue::Text("1000".to_string()),
            AbiValue::Text("100000".to_string()),
            AbiValue::Integer(100),
        ]);
        let outcome = tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Bytes(vec![0x88; 32]),
            AbiValue::Text("canonical payment note".to_string()),
            AbiValue::Integer(1_500),
        ]);
        let context = tuple(vec![
            AbiValue::Text("0".to_string()),
            AbiValue::Integer(0),
            AbiValue::Nil,
            tuple(Vec::new()),
            tuple(vec![tuple(vec![binding, outcome])]),
        ]);
        let decoded = decode_context(&context).expect("context");
        let outcome = &decoded
            .prepared_htlcs
            .values()
            .next()
            .expect("prepared row")
            .outcome;
        assert!(matches!(
            outcome,
            HtlcPreparedOutcome::Final {
                description: Some(value),
                started_at_ms: Some(1_500),
                ..
            } if value == "canonical payment note"
        ));
    }

    #[test]
    fn entity_command_nonce_wire_is_exact_and_preserves_latest_slot() {
        let wire = tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Bytes(vec![0xaa; 32]),
            AbiValue::Integer(7),
            tuple(vec![tuple(vec![
                AbiValue::Text("signer-1".to_string()),
                AbiValue::Text("9".to_string()),
                AbiValue::Bytes(vec![0xbb; 32]),
            ])]),
        ]);
        let decoded = decode_entity_command_nonces(&wire)
            .expect("nonce wire")
            .expect("nonce state");
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.board_hash, format!("0x{}", "aa".repeat(32)));
        assert_eq!(decoded.board_epoch, 7);
        assert_eq!(decoded.by_signer["signer-1"].nonce, BigInt::from(9_u8));
        assert_eq!(
            decoded.by_signer["signer-1"].command_hash,
            format!("0x{}", "bb".repeat(32))
        );

        let malformed = tuple(vec![AbiValue::Integer(1), AbiValue::Bytes(vec![0xaa; 32])]);
        assert!(decode_entity_command_nonces(&malformed).is_err());
    }
}

fn fixed_hex_bytes(
    value: &str,
    length: usize,
    field: &'static str,
) -> Result<Vec<u8>, ProcessError> {
    let Some(payload) = value.strip_prefix("0x") else {
        return Err(ProcessError::Expected(field));
    };
    if payload.len() != length * 2 {
        return Err(ProcessError::Expected(field));
    }
    (0..length)
        .map(|index| {
            u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
                .map_err(|_| ProcessError::Expected(field))
        })
        .collect()
}

fn digest_bytes(value: &str) -> Result<Vec<u8>, ProcessError> {
    fixed_hex_bytes(value, 32, "entitySectionDigest")
}

fn optional_hex_bytes(
    value: Option<&String>,
    field: &'static str,
) -> Result<AbiValue, ProcessError> {
    value.map_or(Ok(AbiValue::Nil), |value| {
        Ok(AbiValue::Bytes(fixed_hex_bytes(value, 32, field)?))
    })
}

fn optional_integer(value: Option<u64>) -> AbiValue {
    value.map_or(AbiValue::Nil, |value| AbiValue::Integer(i128::from(value)))
}

fn optional_bigint_value(value: Option<&BigInt>) -> AbiValue {
    value.map_or(AbiValue::Nil, |value| AbiValue::Text(value.to_string()))
}

fn entity_output(value: &EntityKernelOutput) -> Result<AbiValue, ProcessError> {
    let fields = match value {
        EntityKernelOutput::Debug { payload } => vec![
            AbiValue::Integer(7),
            xln_rscore_batch::encode_canonical_value(payload),
        ],
        EntityKernelOutput::AccountSettledFinalizedBilateral {
            entity_id,
            account_id,
            token_id,
            j_height,
            collateral,
            ondelta,
        } => vec![
            AbiValue::Integer(6),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(account_id, 32, "accountId")?),
            AbiValue::Integer(i128::from(*token_id)),
            AbiValue::Integer(i128::from(*j_height)),
            AbiValue::Text(collateral.to_string()),
            AbiValue::Text(ondelta.to_string()),
        ],
        EntityKernelOutput::HtlcInitiated {
            entity_id,
            from_entity,
            to_entity,
            token_id,
            amount,
            sender_amount,
            fee,
            hashlock,
            lock_id,
            route,
            description,
            started_at_ms,
        } => vec![
            AbiValue::Integer(5),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(from_entity, 32, "fromEntity")?),
            AbiValue::Bytes(fixed_hex_bytes(to_entity, 32, "toEntity")?),
            AbiValue::Integer(i128::from(*token_id)),
            AbiValue::Text(amount.to_string()),
            AbiValue::Text(sender_amount.to_string()),
            AbiValue::Text(fee.to_string()),
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
            AbiValue::Bytes(fixed_hex_bytes(lock_id, 32, "lockId")?),
            AbiValue::Tuple(BodyTuple::from_vec(
                route
                    .iter()
                    .map(|entity_id| {
                        fixed_hex_bytes(entity_id, 32, "routeEntityId").map(AbiValue::Bytes)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            description.clone().map_or(AbiValue::Nil, AbiValue::Text),
            AbiValue::Integer(i128::from(*started_at_ms)),
        ],
        EntityKernelOutput::HtlcForwardAccepted {
            entity_id,
            hashlock,
        } => vec![
            AbiValue::Integer(0),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
        ],
        EntityKernelOutput::HtlcFailed {
            entity_id,
            hashlock,
            lock_id,
            reason,
            description,
        } => vec![
            AbiValue::Integer(1),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
            optional_hex_bytes(lock_id.as_ref(), "lockId")?,
            AbiValue::Text(reason.clone()),
            description.clone().map_or(AbiValue::Nil, AbiValue::Text),
        ],
        EntityKernelOutput::HtlcReceived {
            entity_id,
            from_entity,
            to_entity,
            hashlock,
            lock_id,
            token_id,
            amount,
            description,
            started_at_ms,
            jurisdiction_id,
            received_at_ms,
        } => vec![
            AbiValue::Integer(2),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(from_entity, 32, "fromEntity")?),
            AbiValue::Bytes(fixed_hex_bytes(to_entity, 32, "toEntity")?),
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
            AbiValue::Bytes(fixed_hex_bytes(lock_id, 32, "lockId")?),
            token_id.map_or(AbiValue::Nil, |value| AbiValue::Integer(i128::from(value))),
            optional_bigint_value(amount.as_ref()),
            description.clone().map_or(AbiValue::Nil, AbiValue::Text),
            optional_integer(*started_at_ms),
            jurisdiction_id
                .clone()
                .map_or(AbiValue::Nil, AbiValue::Text),
            AbiValue::Integer(i128::from(*received_at_ms)),
        ],
        EntityKernelOutput::HtlcFinalized {
            entity_id,
            from_entity,
            to_entity,
            hashlock,
            secret,
            lock_id,
            token_id,
            amount,
            description,
            started_at_ms,
            jurisdiction_id,
            finalized_at_ms,
        } => vec![
            AbiValue::Integer(3),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(from_entity, 32, "fromEntity")?),
            optional_hex_bytes(to_entity.as_ref(), "toEntity")?,
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
            AbiValue::Bytes(fixed_hex_bytes(secret, 32, "secret")?),
            optional_hex_bytes(lock_id.as_ref(), "lockId")?,
            token_id.map_or(AbiValue::Nil, |value| AbiValue::Integer(i128::from(value))),
            optional_bigint_value(amount.as_ref()),
            description.clone().map_or(AbiValue::Nil, AbiValue::Text),
            optional_integer(*started_at_ms),
            jurisdiction_id
                .clone()
                .map_or(AbiValue::Nil, AbiValue::Text),
            AbiValue::Integer(i128::from(*finalized_at_ms)),
        ],
        EntityKernelOutput::SwapMatched { entity_id, count } => vec![
            AbiValue::Integer(4),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Integer(i128::from(*count)),
        ],
    };
    Ok(AbiValue::Tuple(BodyTuple::from_vec(fields)))
}

fn sections_value(sections: &[EntityConsensusSection]) -> Result<AbiValue, ProcessError> {
    Ok(AbiValue::Tuple(BodyTuple::from_vec(
        sections
            .iter()
            .map(|section| {
                Ok(AbiValue::Tuple(BodyTuple::from_array([
                    AbiValue::Text(section.field.clone()),
                    AbiValue::Bytes(digest_bytes(&section.digest)?),
                ])))
            })
            .collect::<Result<_, ProcessError>>()?,
    )))
}

pub fn encode_entity_loaded(
    accounts_root: [u8; 32],
    sections: &[EntityConsensusSection],
) -> Result<BodyTuple, ProcessError> {
    Ok(BodyTuple::from_array([
        AbiValue::Bytes(accounts_root.to_vec()),
        sections_value(sections)?,
    ]))
}

pub fn encode_entity_round(
    result: &ResidentEntityResult,
    sections: &[EntityConsensusSection],
    engine_micros: u64,
) -> Result<BodyTuple, ProcessError> {
    let inbound = crate::wire_encode::round(&result.inbound, 0)?
        .into_fields()
        .into_iter()
        .next()
        .ok_or(ProcessError::Expected("entityInboundReply"))?;
    let outbound = crate::wire_encode::round(&result.outbound, 0)?
        .into_fields()
        .into_iter()
        .next()
        .ok_or(ProcessError::Expected("entityOutboundReply"))?;
    let outputs = AbiValue::Tuple(BodyTuple::from_vec(
        result
            .outputs
            .iter()
            .map(entity_output)
            .collect::<Result<_, _>>()?,
    ));
    let EntityKernelCommitments {
        paybook_root,
        orderbook_root,
        ordered_outbox_digest,
    } = &result.commitments;
    Ok(crate::wire_encode::body(vec![
        inbound,
        outbound,
        outputs,
        AbiValue::Tuple(BodyTuple::from_array([
            AbiValue::Bytes(digest_bytes(paybook_root)?),
            AbiValue::Bytes(digest_bytes(orderbook_root)?),
            AbiValue::Bytes(digest_bytes(ordered_outbox_digest)?),
        ])),
        sections_value(sections)?,
        AbiValue::Integer(i128::from(engine_micros)),
    ]))
}
