//! Entity snapshot and resident-round process wire codec.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_engine::{AccountDomain, DepositoryAddress, OpaqueHtlcCiphertext};
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookStateSnapshot, DeterministicContext,
    EntityConsensusSection, EntityKernelCommitments, EntityKernelOutput, EntityReferral,
    EntityStateSnapshot, HtlcPreparedBinding, HtlcPreparedOutcome, HtlcRoute, HubProfile,
    LockBookEntry, OrderbookConsensusMetadata, OrderbookStateSnapshot, PairDimensions, PairPolicy,
    PreparedHtlcEntry, ResidentEntityResult, SameJOffer, SpreadDistribution,
};

use crate::ProcessError;
use crate::wire_value::{
    bigint, boolean, bounded_u32, exact, hex_fixed, js_number, optional_text, text, text_list,
    tuple, unsigned,
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

fn decode_route(value: &AbiValue) -> Result<(String, HtlcRoute), ProcessError> {
    let row = exact(tuple(value)?, 17, "entityHtlcRoute")?;
    let hashlock = hex_fixed(&row[0], "hashlock", 32)?;
    Ok((
        hashlock.clone(),
        HtlcRoute {
            hashlock,
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
            inbound_lock_id: optional_hex(&row[6], "inboundLockId", 32)?,
            outbound_entity: optional_hex(&row[7], "outboundEntity", 32)?,
            outbound_lock_id: optional_hex(&row[8], "outboundLockId", 32)?,
            inbound_settled: boolean(&row[9], "inboundSettled")?,
            outbound_settled: boolean(&row[10], "outboundSettled")?,
            secret: optional_hex(&row[11], "secret", 32)?,
            secret_ack_pending: boolean(&row[12], "secretAckPending")?,
            secret_ack_started_at: optional_u64(&row[13], "secretAckStartedAt")?,
            secret_ack_deadline_at: optional_u64(&row[14], "secretAckDeadlineAt")?,
            pending_fee: optional_bigint(&row[15], "pendingFee")?,
            created_timestamp: js_number(&row[16], "createdTimestamp")?,
        },
    ))
}

fn decode_lock(value: &AbiValue) -> Result<(String, LockBookEntry), ProcessError> {
    let row = exact(tuple(value)?, 8, "entityLockBookEntry")?;
    let lock_id = hex_fixed(&row[0], "lockId", 32)?;
    Ok((
        lock_id.clone(),
        LockBookEntry {
            lock_id,
            account_id: hex_fixed(&row[1], "accountId", 32)?,
            token_id: u16::try_from(bounded_u32(&row[2], "tokenId")?)
                .map_err(|_| ProcessError::Expected("tokenId"))?,
            amount: bigint(&row[3], "lockAmount")?,
            hashlock: hex_fixed(&row[4], "hashlock", 32)?,
            timelock: bigint(&row[5], "timelock")?,
            outgoing: boolean(&row[6], "outgoing")?,
            created_at: bigint(&row[7], "createdAt")?,
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

fn decode_offer(value: &AbiValue) -> Result<((String, String), SameJOffer), ProcessError> {
    let row = exact(tuple(value)?, 18, "sameJOffer")?;
    let account_id = hex_fixed(&row[0], "offerAccountId", 32)?;
    let offer_id = text(&row[1])?.to_string();
    Ok((
        (account_id, offer_id.clone()),
        SameJOffer {
            offer_id,
            left_entity: hex_fixed(&row[2], "leftEntity", 32)?,
            right_entity: hex_fixed(&row[3], "rightEntity", 32)?,
            give_token_id: bounded_u32(&row[4], "giveTokenId")?,
            give_token_decimals: bounded_u32(&row[5], "giveTokenDecimals")?,
            give_amount: bigint(&row[6], "giveAmount")?,
            want_token_id: bounded_u32(&row[7], "wantTokenId")?,
            want_token_decimals: bounded_u32(&row[8], "wantTokenDecimals")?,
            want_amount: bigint(&row[9], "wantAmount")?,
            max_fee: bigint(&row[10], "maxFee")?,
            min_net_receive: bigint(&row[11], "minNetReceive")?,
            price_ticks: bigint(&row[12], "priceTicks")?,
            time_in_force: match &row[13] {
                AbiValue::Nil => None,
                value => Some(
                    u8::try_from(unsigned(value, "timeInForce")?)
                        .map_err(|_| ProcessError::Expected("timeInForce"))?,
                ),
            },
            maker_is_left: boolean(&row[14], "makerIsLeft")?,
            created_height: js_number(&row[15], "createdHeight")?,
            quantized_give: bigint(&row[16], "quantizedGive")?,
            quantized_want: bigint(&row[17], "quantizedWant")?,
        },
    ))
}

fn decode_orderbook(value: &AbiValue) -> Result<Option<OrderbookStateSnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 6, "orderbookState")?;
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
    let mut offers = BTreeMap::new();
    for value in tuple(&row[2])? {
        let (key, offer) = decode_offer(value)?;
        map_insert(&mut offers, key, offer, "orderbookOfferDuplicate")?;
    }
    let mut resolving_offers = BTreeSet::new();
    for value in tuple(&row[3])? {
        let entry = exact(tuple(value)?, 2, "resolvingOffer")?;
        let key = (
            hex_fixed(&entry[0], "offerAccountId", 32)?,
            text(&entry[1])?.to_string(),
        );
        if !resolving_offers.insert(key) {
            return Err(ProcessError::Expected("resolvingOfferDuplicate"));
        }
    }
    let mut pair_by_order = BTreeMap::new();
    for value in tuple(&row[4])? {
        let entry = exact(tuple(value)?, 2, "pairByOrder")?;
        map_insert(
            &mut pair_by_order,
            text(&entry[0])?.to_string(),
            text(&entry[1])?.to_string(),
            "pairByOrderDuplicate",
        )?;
    }
    Ok(Some(OrderbookStateSnapshot {
        books,
        pair_dimensions,
        offers,
        resolving_offers,
        pair_by_order,
        max_orders_per_pair: usize::try_from(unsigned(&row[5], "maxOrdersPerPair")?)
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

pub fn decode_entity_snapshot(value: &AbiValue) -> Result<EntityStateSnapshot, ProcessError> {
    let row = exact(tuple(value)?, 11, "entityStateSnapshot")?;
    let mut known_accounts = BTreeSet::new();
    for value in tuple(&row[4])? {
        if !known_accounts.insert(hex_fixed(value, "knownAccount", 32)?) {
            return Err(ProcessError::Expected("knownAccountDuplicate"));
        }
    }
    let mut htlc_routes = BTreeMap::new();
    for value in tuple(&row[5])? {
        let (key, route) = decode_route(value)?;
        map_insert(&mut htlc_routes, key, route, "htlcRouteDuplicate")?;
    }
    let mut lock_book = BTreeMap::new();
    for value in tuple(&row[7])? {
        let (key, lock) = decode_lock(value)?;
        map_insert(&mut lock_book, key, lock, "lockBookDuplicate")?;
    }
    let expected_owned_sections = tuple(&row[10])?
        .iter()
        .map(|value| {
            let entry = exact(tuple(value)?, 2, "entityOwnedSection")?;
            Ok(EntityConsensusSection {
                field: text(&entry[0])?.to_string(),
                digest: hex_fixed(&entry[1], "entitySectionDigest", 32)?,
            })
        })
        .collect::<Result<_, ProcessError>>()?;
    Ok(EntityStateSnapshot {
        entity_id: hex_fixed(&row[0], "entityId", 32)?,
        height: js_number(&row[1], "entityHeight")?,
        timestamp: js_number(&row[2], "entityTimestamp")?,
        last_finalized_j_height: js_number(&row[3], "lastFinalizedJHeight")?,
        known_accounts,
        htlc_routes,
        htlc_fees_earned: bigint(&row[6], "htlcFeesEarned")?,
        lock_book,
        orderbook: decode_orderbook(&row[8])?,
        orderbook_metadata: decode_metadata(&row[9])?,
        expected_owned_sections,
    })
}

fn decode_prepared_htlc(
    value: &AbiValue,
) -> Result<((String, String), PreparedHtlcEntry), ProcessError> {
    let row = exact(tuple(value)?, 2, "preparedHtlc")?;
    let binding = exact(tuple(&row[0])?, 12, "preparedHtlcBinding")?;
    let domain = exact(tuple(&binding[2])?, 2, "preparedHtlcDomain")?;
    let account_frame_hash = hex_fixed(&binding[3], "accountFrameHash", 32)?;
    let lock_id = hex_fixed(&binding[5], "lockId", 32)?;
    let binding = HtlcPreparedBinding {
        from_entity_id: hex_fixed(&binding[0], "fromEntityId", 32)?,
        to_entity_id: hex_fixed(&binding[1], "toEntityId", 32)?,
        domain: AccountDomain::new(
            js_number(&domain[0], "chainId")?,
            DepositoryAddress::parse(&hex_fixed(&domain[1], "depositoryAddress", 20)?)?,
        )?,
        account_frame_hash: account_frame_hash.clone(),
        account_height: js_number(&binding[4], "accountHeight")?,
        lock_id: lock_id.clone(),
        envelope_hash: hex_fixed(&binding[6], "envelopeHash", 32)?,
        hashlock: hex_fixed(&binding[7], "hashlock", 32)?,
        token_id: u16::try_from(bounded_u32(&binding[8], "tokenId")?)
            .map_err(|_| ProcessError::Expected("tokenId"))?,
        amount: bigint(&binding[9], "amount")?,
        timelock: bigint(&binding[10], "timelock")?,
        reveal_before_height: js_number(&binding[11], "revealBeforeHeight")?,
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
            let outcome = exact(outcome, 3, "preparedHtlcFinal")?;
            HtlcPreparedOutcome::Final {
                secret: hex_fixed(&outcome[1], "secret", 32)?,
                started_at_ms: optional_u64(&outcome[2], "startedAtMs")?,
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
        (account_frame_hash, lock_id),
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
    })
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
        } => vec![
            AbiValue::Integer(1),
            AbiValue::Bytes(fixed_hex_bytes(entity_id, 32, "entityId")?),
            AbiValue::Bytes(fixed_hex_bytes(hashlock, 32, "hashlock")?),
            optional_hex_bytes(lock_id.as_ref(), "lockId")?,
            AbiValue::Text(reason.clone()),
        ],
        EntityKernelOutput::HtlcReceived {
            entity_id,
            from_entity,
            to_entity,
            hashlock,
            lock_id,
            token_id,
            amount,
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
