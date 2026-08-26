//! Shadow-only slice commitments. These are parity evidence, not Entity
//! consensus roots and never authorize a transition.

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use std::sync::OnceLock;
use std::time::Instant;
use xln_rscore_engine::canonical_tx_digest;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, RlpWriter,
    encode_canonical_consensus_bytes, write_account_state_value,
};

use crate::orderbook::{
    BookOrder, BookState, OrderbookState, SameJOffer, Side, compute_book_commitment_hash,
};
use crate::{
    AccountProposalWork, EntityConsensusSection, EntityKernelCommitments, EntityKernelError,
    EntityKernelOutput, EntityReferral, EntityStateSlice, HtlcRoute, HubProfile, LockBookEntry,
    OrderbookConsensusMetadata, SpreadDistribution,
};

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn big(value: &BigInt) -> CanonicalValue {
    CanonicalValue::BigInt(value.clone())
}

fn boolean(value: bool) -> CanonicalValue {
    CanonicalValue::Bool(value)
}

fn optional<T>(value: Option<T>, project: impl FnOnce(T) -> CanonicalValue) -> CanonicalValue {
    value.map(project).unwrap_or(CanonicalValue::Null)
}

fn number(field: &'static str, value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| EntityKernelError::CommitmentUnsafeNumber { field, value })
}

fn number_u32(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

fn number_u16(value: u16) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u16(value))
}

fn optional_number(
    field: &'static str,
    value: Option<u64>,
) -> Result<CanonicalValue, EntityKernelError> {
    match value {
        Some(value) => number(field, value),
        None => Ok(CanonicalValue::Null),
    }
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn string_set(values: impl Iterator<Item = String>) -> CanonicalValue {
    CanonicalValue::Set(values.map(text).collect())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}

fn digest(value: CanonicalValue) -> Result<String, EntityKernelError> {
    let mut encoded = RlpWriter::with_capacity(4_096);
    write_account_state_value(&mut encoded, &value).map_err(|error| {
        EntityKernelError::CommitmentEncoding {
            detail: error.to_string(),
        }
    })?;
    Ok(hex(&Sha256::digest(encoded.as_slice())))
}

fn consensus_digest_bytes(value: &CanonicalValue) -> Result<[u8; 32], EntityKernelError> {
    let encoded = encode_canonical_consensus_bytes(value).map_err(|error| {
        EntityKernelError::CommitmentEncoding {
            detail: error.to_string(),
        }
    })?;
    Ok(Sha256::digest(encoded).into())
}

fn consensus_digest(value: &CanonicalValue) -> Result<String, EntityKernelError> {
    Ok(hex(&consensus_digest_bytes(value)?))
}

fn raw_text_key(value: &str) -> Result<Vec<u8>, EntityKernelError> {
    let bytes = value.as_bytes();
    let length = u16::try_from(bytes.len()).map_err(|_| EntityKernelError::CommitmentEncoding {
        detail: format!("ENTITY_COLLECTION_KEY_TOO_LONG:{}", bytes.len()),
    })?;
    let mut output = Vec::with_capacity(2 + bytes.len());
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(output)
}

fn collection_commitment(
    rows: impl Iterator<Item = Result<(String, CanonicalValue), EntityKernelError>>,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut map = PersistentRadixMap::empty();
    for row in rows {
        let (key, value) = row?;
        let digest = consensus_digest_bytes(&value)?;
        map = map
            .updated(raw_text_key(&key)?, value, digest)
            .map_err(|error| EntityKernelError::CommitmentEncoding {
                detail: error.to_string(),
            })?;
    }
    let leaf_count =
        u64::try_from(map.len()).map_err(|_| EntityKernelError::CommitmentEncoding {
            detail: format!("ENTITY_COLLECTION_LEAF_COUNT_OVERFLOW:{}", map.len()),
        })?;
    Ok(object(vec![
        ("radix", number_u32(16)),
        (
            "leafCount",
            number("entityCollection.leafCount", leaf_count)?,
        ),
        ("root", text(hex(&map.root_hash()))),
    ]))
}

fn canonical_htlc_route(route: &HtlcRoute) -> Result<CanonicalValue, EntityKernelError> {
    let mut entries = vec![("hashlock", text(&route.hashlock))];
    if let Some(token_id) = route.token_id {
        entries.push(("tokenId", number_u16(token_id)));
    }
    if let Some(amount) = route.amount.as_ref() {
        entries.push(("amount", big(amount)));
    }
    if let Some(started_at_ms) = route.started_at_ms {
        entries.push(("startedAtMs", number("startedAtMs", started_at_ms)?));
    }
    if route.originated {
        entries.push(("originated", boolean(true)));
    }
    if let Some(value) = route.inbound_entity.as_ref() {
        entries.push(("inboundEntity", text(value)));
    }
    if let Some(value) = route.inbound_lock_id.as_ref() {
        entries.push(("inboundLockId", text(value)));
    }
    if let Some(value) = route.outbound_entity.as_ref() {
        entries.push(("outboundEntity", text(value)));
    }
    if let Some(value) = route.outbound_lock_id.as_ref() {
        entries.push(("outboundLockId", text(value)));
    }
    if route.inbound_settled {
        entries.push(("inboundSettled", boolean(true)));
    }
    if route.outbound_settled {
        entries.push(("outboundSettled", boolean(true)));
    }
    if let Some(value) = route.secret.as_ref() {
        entries.push(("secret", text(value)));
    }
    if route.secret_ack_pending {
        entries.push(("secretAckPending", boolean(true)));
    }
    if let Some(value) = route.secret_ack_started_at {
        entries.push(("secretAckStartedAt", number("secretAckStartedAt", value)?));
    }
    if let Some(value) = route.secret_ack_deadline_at {
        entries.push(("secretAckDeadlineAt", number("secretAckDeadlineAt", value)?));
    }
    if let Some(value) = route.pending_fee.as_ref() {
        entries.push(("pendingFee", big(value)));
    }
    entries.push((
        "createdTimestamp",
        number("createdTimestamp", route.created_timestamp)?,
    ));
    Ok(object(entries))
}

fn canonical_lock_entry(lock: &LockBookEntry) -> CanonicalValue {
    object(vec![
        ("lockId", text(&lock.lock_id)),
        ("accountId", text(&lock.account_id)),
        ("tokenId", number_u16(lock.token_id)),
        ("amount", big(&lock.amount)),
        ("hashlock", text(&lock.hashlock)),
        ("timelock", big(&lock.timelock)),
        (
            "direction",
            text(if lock.outgoing {
                "outgoing"
            } else {
                "incoming"
            }),
        ),
        ("createdAt", big(&lock.created_at)),
    ])
}

fn spread_distribution(value: &SpreadDistribution) -> CanonicalValue {
    object(vec![
        ("makerBps", number_u32(value.maker_bps)),
        ("takerBps", number_u32(value.taker_bps)),
        ("hubBps", number_u32(value.hub_bps)),
        ("makerReferrerBps", number_u32(value.maker_referrer_bps)),
        ("takerReferrerBps", number_u32(value.taker_referrer_bps)),
    ])
}

fn hub_profile(value: &HubProfile) -> CanonicalValue {
    object(vec![
        ("entityId", text(&value.entity_id)),
        ("name", text(&value.name)),
        (
            "spreadDistribution",
            spread_distribution(&value.spread_distribution),
        ),
        ("referenceTokenId", number_u32(value.reference_token_id)),
        (
            "usdQuoteAuthorityEntityId",
            text(&value.usd_quote_authority_entity_id),
        ),
        ("minTradeSize", big(&value.min_trade_size)),
        (
            "supportedPairs",
            CanonicalValue::Array(value.supported_pairs.iter().map(text).collect()),
        ),
    ])
}

fn referral(value: &EntityReferral) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("entityId", text(&value.entity_id)),
        ("referrerId", optional(value.referrer_id.as_ref(), text)),
        ("timestamp", number("referral.timestamp", value.timestamp)?),
    ]))
}

fn canonical_orderbook_ext(
    state: &OrderbookState,
    metadata: &OrderbookConsensusMetadata,
) -> Result<CanonicalValue, EntityKernelError> {
    let books = state
        .books
        .iter()
        .map(|(pair, book)| {
            compute_book_commitment_hash(book).map(|digest| (text(pair), text(digest)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let pair_dimensions = state
        .pair_dimensions
        .iter()
        .map(|(pair, value)| {
            (
                text(pair),
                object(vec![
                    ("baseTokenDecimals", number_u32(value.base_token_decimals)),
                    ("quoteTokenDecimals", number_u32(value.quote_token_decimals)),
                ]),
            )
        })
        .collect();
    let referrals = metadata
        .referrals
        .iter()
        .map(|(key, value)| Ok((text(key), referral(value)?)))
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    Ok(object(vec![
        ("books", CanonicalValue::Map(books)),
        ("pairDimensions", CanonicalValue::Map(pair_dimensions)),
        ("hubProfile", hub_profile(&metadata.hub_profile)),
        ("referrals", CanonicalValue::Map(referrals)),
    ]))
}

/// Exact Entity consensus sections owned by the resident E+A subsystem.
///
/// The parent carries every unrelated section digest unchanged. Replacing
/// these rows and rebuilding the top manifest yields the canonical Entity
/// root without materializing Account replicas in TypeScript.
pub fn compute_entity_owned_sections(
    state: &EntityStateSlice,
    accounts_root: [u8; 32],
    account_count: usize,
) -> Result<Vec<EntityConsensusSection>, EntityKernelError> {
    let account_count =
        u64::try_from(account_count).map_err(|_| EntityKernelError::CommitmentEncoding {
            detail: format!("ENTITY_ACCOUNT_COUNT_OVERFLOW:{account_count}"),
        })?;
    let accounts = object(vec![
        ("domain", text("xln.entity.accounts.radix-merkle:binary")),
        ("radix", number_u32(16)),
        ("hashAlgorithm", text("integrity")),
        ("leafCount", number("accounts.leafCount", account_count)?),
        ("root", text(hex(&accounts_root))),
    ]);
    let routes = collection_commitment(
        state
            .htlc_routes
            .iter()
            .map(|(key, value)| Ok((key.clone(), canonical_htlc_route(value)?))),
    )?;
    let locks = collection_commitment(
        state
            .lock_book
            .iter()
            .map(|(key, value)| Ok((key.clone(), canonical_lock_entry(value)))),
    )?;
    let mut values = vec![
        ("accounts", accounts),
        ("entityId", text(&state.entity_id)),
        ("height", number("height", state.height)?),
        ("timestamp", number("timestamp", state.timestamp)?),
        (
            "lastFinalizedJHeight",
            number("lastFinalizedJHeight", state.last_finalized_j_height)?,
        ),
        ("htlcRoutes", routes),
        ("htlcFeesEarned", big(&state.htlc_fees_earned)),
        ("lockBook", locks),
    ];
    match (&state.orderbook, &state.orderbook_metadata) {
        (Some(orderbook), Some(metadata)) => values.push((
            "orderbookExt",
            canonical_orderbook_ext(orderbook, metadata)?,
        )),
        (None, None) => {}
        _ => {
            return Err(EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_ORDERBOOK_METADATA_MISMATCH".to_string(),
            });
        }
    }
    let mut sections = values
        .into_iter()
        .map(|(field, value)| {
            Ok(EntityConsensusSection {
                field: field.to_string(),
                digest: consensus_digest(&value)?,
            })
        })
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    sections.sort_by(|left, right| left.field.cmp(&right.field));
    Ok(sections)
}

fn htlc_route(route: &HtlcRoute) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("hashlock", text(&route.hashlock)),
        ("tokenId", optional(route.token_id, number_u16)),
        ("amount", optional(route.amount.as_ref(), big)),
        (
            "startedAtMs",
            optional_number("startedAtMs", route.started_at_ms)?,
        ),
        ("originated", boolean(route.originated)),
        (
            "inboundEntity",
            optional(route.inbound_entity.as_ref(), text),
        ),
        (
            "inboundLockId",
            optional(route.inbound_lock_id.as_ref(), text),
        ),
        (
            "outboundEntity",
            optional(route.outbound_entity.as_ref(), text),
        ),
        (
            "outboundLockId",
            optional(route.outbound_lock_id.as_ref(), text),
        ),
        ("inboundSettled", boolean(route.inbound_settled)),
        ("outboundSettled", boolean(route.outbound_settled)),
        ("secret", optional(route.secret.as_ref(), text)),
        ("secretAckPending", boolean(route.secret_ack_pending)),
        (
            "secretAckStartedAt",
            optional_number("secretAckStartedAt", route.secret_ack_started_at)?,
        ),
        (
            "secretAckDeadlineAt",
            optional_number("secretAckDeadlineAt", route.secret_ack_deadline_at)?,
        ),
        ("pendingFee", optional(route.pending_fee.as_ref(), big)),
        (
            "createdTimestamp",
            number("createdTimestamp", route.created_timestamp)?,
        ),
    ]))
}

fn lock_entry(lock: &LockBookEntry) -> CanonicalValue {
    object(vec![
        ("lockId", text(&lock.lock_id)),
        ("accountId", text(&lock.account_id)),
        ("tokenId", number_u16(lock.token_id)),
        ("amount", big(&lock.amount)),
        ("hashlock", text(&lock.hashlock)),
        ("timelock", big(&lock.timelock)),
        ("outgoing", boolean(lock.outgoing)),
        ("createdAt", big(&lock.created_at)),
    ])
}

fn paybook_value(state: &EntityStateSlice) -> Result<CanonicalValue, EntityKernelError> {
    let mut routes = Vec::with_capacity(state.htlc_routes.len());
    for (key, value) in &state.htlc_routes {
        routes.push((text(key), htlc_route(value)?));
    }
    let locks = state
        .lock_book
        .iter()
        .map(|(key, value)| (text(key), lock_entry(value)))
        .collect();
    Ok(object(vec![
        ("domain", text("xln.entity-kernel.paybook.v1")),
        ("entityId", text(&state.entity_id)),
        ("timestamp", number("timestamp", state.timestamp)?),
        (
            "knownAccounts",
            string_set(state.known_accounts.iter().cloned()),
        ),
        ("htlcRoutes", CanonicalValue::Map(routes)),
        ("htlcFeesEarned", big(&state.htlc_fees_earned)),
        ("lockBook", CanonicalValue::Map(locks)),
    ]))
}

fn offer(value: &SameJOffer) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("offerId", text(&value.offer_id)),
        ("leftEntity", text(&value.left_entity)),
        ("rightEntity", text(&value.right_entity)),
        ("giveTokenId", number_u32(value.give_token_id)),
        ("giveTokenDecimals", number_u32(value.give_token_decimals)),
        ("giveAmount", big(&value.give_amount)),
        ("wantTokenId", number_u32(value.want_token_id)),
        ("wantTokenDecimals", number_u32(value.want_token_decimals)),
        ("wantAmount", big(&value.want_amount)),
        ("maxFee", big(&value.max_fee)),
        ("minNetReceive", big(&value.min_net_receive)),
        ("priceTicks", big(&value.price_ticks)),
        (
            "timeInForce",
            optional(value.time_in_force, |tif| number_u32(u32::from(tif))),
        ),
        ("makerIsLeft", boolean(value.maker_is_left)),
        (
            "createdHeight",
            number("createdHeight", value.created_height)?,
        ),
        ("quantizedGive", big(&value.quantized_give)),
        ("quantizedWant", big(&value.quantized_want)),
    ]))
}

fn book_order(value: &BookOrder) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("orderId", text(&value.order_id)),
        ("ownerId", text(&value.owner_id)),
        (
            "side",
            text(match value.side {
                Side::Bid => "bid",
                Side::Ask => "ask",
            }),
        ),
        ("priceTicks", big(&value.price_ticks)),
        ("qtyLots", big(&value.qty_lots)),
        ("seq", number("bookOrderSeq", value.seq)?),
    ]))
}

fn book(value: &BookState) -> Result<CanonicalValue, EntityKernelError> {
    let mut orders = Vec::with_capacity(value.orders.len());
    for (key, order) in &value.orders {
        orders.push((text(key), book_order(order)?));
    }
    Ok(object(vec![
        ("maxOrders", number("maxOrders", value.max_orders as u64)?),
        ("orders", CanonicalValue::Map(orders)),
        ("nextSeq", number("nextSeq", value.next_seq)?),
        ("tradeCount", number("tradeCount", value.trade_count)?),
        ("tradeQtySum", big(&value.trade_qty_sum)),
        ("lastTradePriceTicks", big(&value.last_trade_price_ticks)),
        (
            "lastAcceptedUsdAskPriceTicks",
            big(&value.last_accepted_usd_ask_price_ticks),
        ),
        ("eventHash", big(&value.event_hash)),
    ]))
}

fn orderbook_value(state: Option<&OrderbookState>) -> Result<CanonicalValue, EntityKernelError> {
    let Some(state) = state else {
        return Ok(object(vec![
            ("domain", text("xln.entity-kernel.orderbook.v1")),
            ("state", CanonicalValue::Null),
        ]));
    };
    let mut books = Vec::with_capacity(state.books.len());
    for (pair, value) in &state.books {
        books.push((text(pair), book(value)?));
    }
    let dimensions = state
        .pair_dimensions
        .iter()
        .map(|(pair, value)| {
            (
                text(pair),
                object(vec![
                    ("baseTokenDecimals", number_u32(value.base_token_decimals)),
                    ("quoteTokenDecimals", number_u32(value.quote_token_decimals)),
                ]),
            )
        })
        .collect();
    let mut offers = Vec::with_capacity(state.offers.len());
    for ((account_id, offer_id), value) in &state.offers {
        offers.push((
            CanonicalValue::Array(vec![text(account_id), text(offer_id)]),
            offer(value)?,
        ));
    }
    let resolving = state
        .resolving_offers
        .iter()
        .map(|(account_id, offer_id)| CanonicalValue::Array(vec![text(account_id), text(offer_id)]))
        .collect();
    let pair_by_order = state
        .pair_by_order
        .iter()
        .map(|(order_id, pair)| (text(order_id), text(pair)))
        .collect();
    Ok(object(vec![
        ("domain", text("xln.entity-kernel.orderbook.v1")),
        ("books", CanonicalValue::Map(books)),
        ("pairDimensions", CanonicalValue::Map(dimensions)),
        ("offers", CanonicalValue::Map(offers)),
        ("resolvingOffers", CanonicalValue::Set(resolving)),
        ("pairByOrder", CanonicalValue::Map(pair_by_order)),
        (
            "maxOrdersPerPair",
            number("maxOrdersPerPair", state.max_orders_per_pair as u64)?,
        ),
    ]))
}

fn nonempty_text(value: Option<&String>) -> Option<CanonicalValue> {
    value.filter(|value| !value.is_empty()).map(text)
}

fn event_amount(value: Option<&BigInt>) -> Option<CanonicalValue> {
    value.map(|value| text(value.to_string()))
}

fn push_timing(
    entries: &mut Vec<(&'static str, CanonicalValue)>,
    started_at_ms: Option<u64>,
    terminal_field: &'static str,
    terminal_at_ms: u64,
    finalized: bool,
) -> Result<(), EntityKernelError> {
    if let Some(started_at_ms) = started_at_ms.filter(|value| *value != 0) {
        let elapsed = terminal_at_ms.saturating_sub(started_at_ms).max(1);
        entries.push(("startedAtMs", number("startedAtMs", started_at_ms)?));
        entries.push((terminal_field, number(terminal_field, terminal_at_ms)?));
        entries.push(("elapsedMs", number("elapsedMs", elapsed)?));
        if finalized {
            entries.push(("finalizedInMs", number("finalizedInMs", elapsed)?));
        }
    } else {
        entries.push((terminal_field, number(terminal_field, terminal_at_ms)?));
    }
    Ok(())
}

fn kernel_output(value: &EntityKernelOutput) -> Result<CanonicalValue, EntityKernelError> {
    Ok(match value {
        EntityKernelOutput::HtlcForwardAccepted {
            entity_id,
            hashlock,
        } => object(vec![
            ("kind", text("htlcForwardAccepted")),
            ("entityId", text(entity_id)),
            ("hashlock", text(hashlock)),
        ]),
        EntityKernelOutput::HtlcFailed {
            entity_id,
            hashlock,
            lock_id,
            reason,
        } => {
            let mut entries = vec![
                ("kind", text("htlcFailed")),
                ("entityId", text(entity_id)),
                ("hashlock", text(hashlock)),
            ];
            if let Some(lock_id) = nonempty_text(lock_id.as_ref()) {
                entries.push(("lockId", lock_id));
            }
            entries.push(("reason", text(reason)));
            object(entries)
        }
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
        } => {
            let mut entries = vec![
                ("kind", text("htlcReceived")),
                ("entityId", text(entity_id)),
                ("fromEntity", text(from_entity)),
                ("toEntity", text(to_entity)),
                ("hashlock", text(hashlock)),
                ("lockId", text(lock_id)),
            ];
            if let Some(amount) = event_amount(amount.as_ref()) {
                entries.push(("amount", amount));
            }
            if let Some(token_id) = token_id {
                entries.push(("tokenId", number_u16(*token_id)));
            }
            if let Some(jurisdiction_id) = nonempty_text(jurisdiction_id.as_ref()) {
                entries.push(("jurisdictionId", jurisdiction_id));
            }
            push_timing(
                &mut entries,
                *started_at_ms,
                "receivedAtMs",
                *received_at_ms,
                false,
            )?;
            object(entries)
        }
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
        } => {
            let mut entries = vec![
                ("kind", text("htlcFinalized")),
                ("entityId", text(entity_id)),
                ("fromEntity", text(from_entity)),
            ];
            if let Some(to_entity) = nonempty_text(to_entity.as_ref()) {
                entries.push(("toEntity", to_entity));
            }
            entries.push(("hashlock", text(hashlock)));
            if !secret.is_empty() {
                entries.push(("secret", text(secret)));
            }
            if let Some(lock_id) = nonempty_text(lock_id.as_ref()) {
                entries.push(("lockId", lock_id));
            }
            if let Some(amount) = event_amount(amount.as_ref()) {
                entries.push(("amount", amount));
            }
            if let Some(token_id) = token_id {
                entries.push(("tokenId", number_u16(*token_id)));
            }
            if let Some(jurisdiction_id) = nonempty_text(jurisdiction_id.as_ref()) {
                entries.push(("jurisdictionId", jurisdiction_id));
            }
            push_timing(
                &mut entries,
                *started_at_ms,
                "finalizedAtMs",
                *finalized_at_ms,
                true,
            )?;
            object(entries)
        }
        EntityKernelOutput::SwapMatched { entity_id, count } => object(vec![
            ("kind", text("swapMatched")),
            ("entityId", text(entity_id)),
            ("count", number("swapMatched.count", *count)?),
        ]),
    })
}

fn proposal(value: &AccountProposalWork) -> Result<CanonicalValue, EntityKernelError> {
    let digests = value
        .txs
        .iter()
        .map(|tx| {
            canonical_tx_digest(tx)
                .map(|digest| text(hex(&digest)))
                .map_err(|error| EntityKernelError::CommitmentEncoding {
                    detail: error.to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(object(vec![
        ("accountId", text(&value.account_id)),
        ("txDigests", CanonicalValue::Array(digests)),
    ]))
}

fn outbox_value(
    proposals: &[AccountProposalWork],
    outputs: &[EntityKernelOutput],
) -> Result<CanonicalValue, EntityKernelError> {
    let proposals = proposals
        .iter()
        .map(proposal)
        .collect::<Result<Vec<_>, _>>()?;
    let outputs = outputs
        .iter()
        .map(kernel_output)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(object(vec![
        ("domain", text("xln.entity-kernel.ordered-outbox.v1")),
        ("proposalWork", CanonicalValue::Array(proposals)),
        ("outputs", CanonicalValue::Array(outputs)),
    ]))
}

pub(crate) fn compute_commitments(
    state: &EntityStateSlice,
    proposal_work: &[AccountProposalWork],
    outputs: &[EntityKernelOutput],
) -> Result<EntityKernelCommitments, EntityKernelError> {
    let started = Instant::now();
    let paybook_value = paybook_value(state)?;
    let paybook_project_micros = started.elapsed().as_micros();
    let started = Instant::now();
    let paybook_root = digest(paybook_value)?;
    let paybook_digest_micros = started.elapsed().as_micros();
    let started = Instant::now();
    let orderbook_value = orderbook_value(state.orderbook.as_ref())?;
    let orderbook_project_micros = started.elapsed().as_micros();
    let started = Instant::now();
    let orderbook_root = digest(orderbook_value)?;
    let orderbook_digest_micros = started.elapsed().as_micros();
    let started = Instant::now();
    let outbox_value = outbox_value(proposal_work, outputs)?;
    let outbox_project_micros = started.elapsed().as_micros();
    let started = Instant::now();
    let ordered_outbox_digest = digest(outbox_value)?;
    let outbox_digest_micros = started.elapsed().as_micros();
    report_commitment_profile(
        [
            paybook_project_micros,
            paybook_digest_micros,
            orderbook_project_micros,
            orderbook_digest_micros,
            outbox_project_micros,
            outbox_digest_micros,
        ],
        [
            state.known_accounts.len(),
            state.htlc_routes.len(),
            state.lock_book.len(),
        ],
    );
    Ok(EntityKernelCommitments {
        paybook_root,
        orderbook_root,
        ordered_outbox_digest,
    })
}

fn report_commitment_profile(phases: [u128; 6], rows: [usize; 3]) {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    if *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1")) {
        eprintln!(
            "RSCORE_COMMITMENT_PHASE paybookProject={} paybookDigest={} orderbookProject={} orderbookDigest={} outboxProject={} outboxDigest={} knownAccounts={} routes={} locks={}",
            phases[0],
            phases[1],
            phases[2],
            phases[3],
            phases[4],
            phases[5],
            rows[0],
            rows[1],
            rows[2],
        );
    }
}
