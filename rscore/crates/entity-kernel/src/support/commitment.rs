//! Canonical Entity consensus commitments owned by the resident E+A kernel.
//!
//! The same projection is used by replay parity, restore verification and the
//! authoritative RRS transition. Calling it shadow-only is unsafe: these
//! section bytes are folded into the Entity root that validators authorize.

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use std::sync::OnceLock;
use std::time::Instant;
use xln_rscore_engine::canonical_tx_digest;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, RlpWriter,
    encode_canonical_consensus_bytes, write_account_state_value,
};

use crate::lending::canonical_lending_state;
use crate::orderbook::{
    BookOrder, BookState, OrderbookState, SameJOffer, Side, compute_book_commitment_hash,
};
use crate::scheduler::canonical_crontab_state;
use crate::{
    AccountProposalWork, EntityConsensusSection, EntityKernelCommitments, EntityKernelError,
    EntityKernelOutput, EntityProfile, EntityReferral, EntityStateSlice, HubProfile,
    OrderbookConsensusMetadata, PaybookEntry, SpreadDistribution,
};

static PROFILE_ENTITY: OnceLock<bool> = OnceLock::new();
const ENTITY_EFFECTS_PARITY_DOMAIN: &[u8] = b"xln.rscore.entity-effects-parity.v1";

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

pub(crate) fn number(field: &'static str, value: u64) -> Result<CanonicalValue, EntityKernelError> {
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

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

pub fn canonical_swap_trading_pairs(
    pairs: &[crate::EntitySwapPair],
) -> Result<CanonicalValue, EntityKernelError> {
    let mut pair_ids = std::collections::BTreeSet::new();
    let mut assets = std::collections::BTreeSet::new();
    let mut rows = Vec::with_capacity(pairs.len());
    for pair in pairs {
        if pair.base_token_id == 0
            || pair.quote_token_id == 0
            || pair.base_token_id == pair.quote_token_id
            || pair.pair_id.is_empty()
            || !pair_ids.insert(pair.pair_id.as_str())
            || !assets.insert((pair.base_token_id, pair.quote_token_id))
        {
            return Err(EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIRS_INVALID".into(),
            });
        }
        rows.push(object(vec![
            ("baseTokenId", number_u32(pair.base_token_id)),
            ("quoteTokenId", number_u32(pair.quote_token_id)),
            ("pairId", text(&pair.pair_id)),
        ]));
    }
    Ok(CanonicalValue::Array(rows))
}

pub fn decode_canonical_swap_trading_pairs(
    value: &CanonicalValue,
) -> Result<Vec<crate::EntitySwapPair>, EntityKernelError> {
    let CanonicalValue::Array(rows) = value else {
        return Err(EntityKernelError::CommitmentEncoding {
            detail: "ENTITY_SWAP_TRADING_PAIRS_ARRAY".into(),
        });
    };
    let mut pair_ids = std::collections::BTreeSet::new();
    let mut assets = std::collections::BTreeSet::new();
    let mut pairs = Vec::with_capacity(rows.len());
    for row in rows {
        let CanonicalValue::Object(fields) = row else {
            return Err(EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIR_OBJECT".into(),
            });
        };
        if fields.len() != 3
            || fields
                .iter()
                .map(|(key, _)| key)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != 3
        {
            return Err(EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIR_FIELDS".into(),
            });
        }
        let get = |name: &str| {
            fields
                .iter()
                .find_map(|(key, value)| (key == name).then_some(value))
        };
        let token = |name: &str| match get(name) {
            Some(CanonicalValue::Number(value)) => value
                .as_str()
                .parse::<u32>()
                .ok()
                .filter(|value| *value > 0),
            _ => None,
        };
        let base_token_id =
            token("baseTokenId").ok_or_else(|| EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIR_BASE".into(),
            })?;
        let quote_token_id =
            token("quoteTokenId").ok_or_else(|| EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIR_QUOTE".into(),
            })?;
        let pair_id = match get("pairId") {
            Some(CanonicalValue::String(value)) if !value.is_empty() => value.clone(),
            _ => {
                return Err(EntityKernelError::CommitmentEncoding {
                    detail: "ENTITY_SWAP_TRADING_PAIR_ID".into(),
                });
            }
        };
        if base_token_id == quote_token_id
            || !pair_ids.insert(pair_id.clone())
            || !assets.insert((base_token_id, quote_token_id))
        {
            return Err(EntityKernelError::CommitmentEncoding {
                detail: "ENTITY_SWAP_TRADING_PAIRS_INVALID".into(),
            });
        }
        pairs.push(crate::EntitySwapPair {
            base_token_id,
            quote_token_id,
            pair_id,
        });
    }
    Ok(pairs)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
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

pub(crate) fn consensus_digest_bytes(
    value: &CanonicalValue,
) -> Result<[u8; 32], EntityKernelError> {
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

pub(crate) fn raw_text_key(value: &str) -> Result<Vec<u8>, EntityKernelError> {
    let bytes = value.as_bytes();
    let length = u16::try_from(bytes.len()).map_err(|_| EntityKernelError::CommitmentEncoding {
        detail: format!("ENTITY_COLLECTION_KEY_TOO_LONG:{}", bytes.len()),
    })?;
    let mut output = Vec::with_capacity(2 + bytes.len());
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(output)
}

pub fn collection_commitment(
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
    persistent_collection_commitment(map.len(), map.root_hash())
}

fn persistent_collection_commitment(
    len: usize,
    root: [u8; 32],
) -> Result<CanonicalValue, EntityKernelError> {
    let leaf_count = u64::try_from(len).map_err(|_| EntityKernelError::CommitmentEncoding {
        detail: format!("ENTITY_COLLECTION_LEAF_COUNT_OVERFLOW:{len}"),
    })?;
    Ok(object(vec![
        ("radix", number_u32(16)),
        (
            "leafCount",
            number("entityCollection.leafCount", leaf_count)?,
        ),
        ("root", text(hex(&root))),
    ]))
}

pub(crate) fn canonical_paybook_entry(
    route: &PaybookEntry,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut entries = vec![("hashlock", text(&route.hashlock))];
    if let Some(value) = route.description.as_ref().filter(|value| !value.is_empty()) {
        entries.push(("description", text(value)));
    }
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
    if let Some(value) = route.outbound_entity.as_ref() {
        entries.push(("outboundEntity", text(value)));
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalOrderbookStorageFields {
    pub hub_profile: CanonicalValue,
    pub referrals: CanonicalValue,
    pub pair_dimensions: CanonicalValue,
}

fn canonical_orderbook_books(state: &OrderbookState) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Map(
        state
            .books
            .iter()
            .map(|(pair, book)| {
                compute_book_commitment_hash(book).map(|digest| (text(pair), text(digest)))
            })
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

fn canonical_orderbook_pair_dimensions(state: &OrderbookState) -> CanonicalValue {
    CanonicalValue::Map(
        state
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
            .collect(),
    )
}

fn canonical_orderbook_referrals(
    metadata: &OrderbookConsensusMetadata,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Map(
        metadata
            .referrals
            .iter()
            .map(|(key, value)| Ok((text(key), referral(value)?)))
            .collect::<Result<Vec<_>, EntityKernelError>>()?,
    ))
}

pub(crate) fn canonical_orderbook_storage_fields(
    state: &OrderbookState,
    metadata: &OrderbookConsensusMetadata,
) -> Result<CanonicalOrderbookStorageFields, EntityKernelError> {
    Ok(CanonicalOrderbookStorageFields {
        hub_profile: hub_profile(&metadata.hub_profile),
        referrals: canonical_orderbook_referrals(metadata)?,
        pair_dimensions: canonical_orderbook_pair_dimensions(state),
    })
}

pub(crate) fn canonical_orderbook_ext_from_storage_fields(
    state: &OrderbookState,
    fields: CanonicalOrderbookStorageFields,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("books", canonical_orderbook_books(state)?),
        ("pairDimensions", fields.pair_dimensions),
        ("hubProfile", fields.hub_profile),
        ("referrals", fields.referrals),
    ]))
}

pub(crate) fn canonical_orderbook_ext(
    state: &OrderbookState,
    metadata: &OrderbookConsensusMetadata,
) -> Result<CanonicalValue, EntityKernelError> {
    let fields = canonical_orderbook_storage_fields(state, metadata)?;
    canonical_orderbook_ext_from_storage_fields(state, fields)
}

pub(crate) fn canonical_reserves(state: &EntityStateSlice) -> CanonicalValue {
    CanonicalValue::Map(
        state
            .reserves
            .iter()
            .map(|(token_id, amount)| (number_u16(*token_id), big(amount)))
            .collect(),
    )
}

pub(crate) fn canonical_profile(profile: &EntityProfile) -> CanonicalValue {
    let mut entries = vec![
        ("name", text(&profile.name)),
        ("isHub", boolean(profile.is_hub)),
    ];
    if let Some(kind) = &profile.entity_kind {
        entries.push(("entityKind", text(kind)));
    }
    if !profile.sectors.is_empty() {
        entries.push((
            "sectors",
            CanonicalValue::Array(profile.sectors.iter().map(text).collect()),
        ));
    }
    entries.extend([
        ("avatar", text(&profile.avatar)),
        ("bio", text(&profile.bio)),
        ("website", text(&profile.website)),
    ]);
    object(entries)
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
    let total_started = Instant::now();
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
    let paybook_started = Instant::now();
    let paybook = paybook_value(state)?;
    let paybook_micros = paybook_started.elapsed().as_micros();
    let mut values = vec![
        ("accounts", accounts),
        ("entityId", text(&state.entity_id)),
        ("height", number("height", state.height)?),
        ("timestamp", number("timestamp", state.timestamp)?),
        ("reserves", canonical_reserves(state)),
        (
            "entityEncryptionPublicKey",
            text(hex(&state.entity_encryption_public_key)),
        ),
        ("profile", canonical_profile(&state.profile)),
        (
            "proposals",
            crate::canonical_entity_proposals(&state.proposals)?,
        ),
        (
            "lastFinalizedJHeight",
            number("lastFinalizedJHeight", state.last_finalized_j_height)?,
        ),
        ("paybook", paybook),
    ];
    if let Some(ledger) = &state.out_debts_by_token {
        values.push(("outDebtsByToken", crate::canonical_debt_ledger(ledger)?));
    }
    if let Some(ledger) = &state.in_debts_by_token {
        values.push(("inDebtsByToken", crate::canonical_debt_ledger(ledger)?));
    }
    if let Some(wallet) = &state.external_wallet {
        values.push(("externalWallet", crate::canonical_external_wallet(wallet)?));
    }
    if let Some(j_batch_state) = &state.j_batch_state {
        values.push((
            "jBatchState",
            crate::canonical_j_batch_state(j_batch_state).map_err(|error| {
                EntityKernelError::CommitmentEncoding {
                    detail: error.to_string(),
                }
            })?,
        ));
    }
    if let Some(provider_state) = &state.entity_provider_action_state {
        values.push((
            "entityProviderActionState",
            crate::canonical_entity_provider_action_state(provider_state)?,
        ));
    }
    if let Some(certified_board_state) = &state.certified_board_state {
        values.push((
            "certifiedBoardState",
            crate::canonical_certified_board_state(certified_board_state)?,
        ));
    }
    if let Some(finality) = &state.j_history_finality {
        values.push(("jHistoryFinality", finality.clone()));
    }
    if let Some(command_nonces) = &state.entity_command_nonces {
        values.push((
            "entityCommandNonces",
            crate::canonical_entity_command_nonces(command_nonces).map_err(|error| {
                EntityKernelError::CommitmentEncoding {
                    detail: error.to_string(),
                }
            })?,
        ));
    }
    if let Some(crontab) = &state.crontab {
        let hooks =
            persistent_collection_commitment(crontab.hooks.len(), crontab.hooks.root_hash())?;
        values.push(("crontabState", canonical_crontab_state(crontab, hooks)?));
    }
    if let Some(config) = &state.hub_rebalance_config {
        values.push(("hubRebalanceConfig", config.clone()));
    }
    for (field, collection) in [
        (
            "deferredAccountProposals",
            state.deferred_account_proposals.as_ref(),
        ),
        (
            "settlementContinuations",
            state.settlement_continuations.as_ref(),
        ),
        (
            "crossJurisdictionSwaps",
            state.cross_jurisdiction_swaps.as_ref(),
        ),
        (
            "crossJurisdictionAuthorizations",
            state.cross_jurisdiction_authorizations.as_ref(),
        ),
        (
            "crossJurisdictionBookAdmissions",
            state.cross_jurisdiction_book_admissions.as_ref(),
        ),
    ] {
        if let Some(collection) = collection {
            values.push((
                field,
                persistent_collection_commitment(collection.len(), collection.root_hash())?,
            ));
        }
    }
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
    if let Some(pairs) = &state.swap_trading_pairs {
        values.push(("swapTradingPairs", canonical_swap_trading_pairs(pairs)?));
    }
    if let Some(lending) = &state.lending {
        values.push(("lending", canonical_lending_state(lending)?));
    }
    let sections_started = Instant::now();
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
    if std::env::var("XLN_RSCORE_TRACE_ENTITY_SECTIONS").as_deref() == Ok("1") {
        eprintln!(
            "RSCORE_ENTITY_OWNED_SECTIONS height={} jHeight={} {}",
            state.height,
            state.last_finalized_j_height,
            sections
                .iter()
                .map(|section| format!("{}={}", section.field, section.digest))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    if *PROFILE_ENTITY
        .get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
    {
        eprintln!(
            "RSCORE_ENTITY_OWNED_PHASE paybook={paybook_micros} sections={} total={} paybookRows={}",
            sections_started.elapsed().as_micros(),
            total_started.elapsed().as_micros(),
            state.paybook.entries.len(),
        );
    }
    Ok(sections)
}

fn paybook_value(state: &EntityStateSlice) -> Result<CanonicalValue, EntityKernelError> {
    let leaf_count = u64::try_from(state.paybook.entries.len()).map_err(|_| {
        EntityKernelError::CommitmentEncoding {
            detail: format!(
                "ENTITY_COLLECTION_LEAF_COUNT_OVERFLOW:{}",
                state.paybook.entries.len()
            ),
        }
    })?;
    Ok(object(vec![
        (
            "entries",
            object(vec![
                ("radix", number_u32(16)),
                (
                    "leafCount",
                    number("paybook.entries.leafCount", leaf_count)?,
                ),
                ("root", text(hex(&state.paybook.entries.root_hash()))),
            ]),
        ),
        ("feesEarned", big(&state.paybook.fees_earned)),
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
        EntityKernelOutput::Debug { payload } => {
            object(vec![("kind", text("debug")), ("payload", payload.clone())])
        }
        EntityKernelOutput::AccountSettledFinalizedBilateral {
            entity_id,
            account_id,
            token_id,
            j_height,
            collateral,
            ondelta,
        } => object(vec![
            ("kind", text("runtimeEvent")),
            ("eventName", text("account_settled_finalized_bilateral")),
            (
                "data",
                object(vec![
                    ("entityId", text(entity_id)),
                    ("accountId", text(account_id)),
                    ("tokenId", number_u16(*token_id)),
                    ("jHeight", number("jHeight", *j_height)?),
                    ("collateral", text(collateral.to_string())),
                    ("ondelta", text(ondelta.to_string())),
                ]),
            ),
        ]),
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
        } => {
            let mut entries = vec![
                ("kind", text("htlcInitiated")),
                ("entityId", text(entity_id)),
                ("fromEntity", text(from_entity)),
                ("toEntity", text(to_entity)),
                ("tokenId", number_u16(*token_id)),
                ("amount", text(amount.to_string())),
                ("senderAmount", text(sender_amount.to_string())),
                ("fee", text(fee.to_string())),
                ("hashlock", text(hashlock)),
                ("lockId", text(lock_id)),
                (
                    "route",
                    CanonicalValue::Array(route.iter().map(text).collect()),
                ),
            ];
            if let Some(description) = nonempty_text(description.as_ref()) {
                entries.push(("description", description));
            }
            entries.push(("startedAtMs", number("startedAtMs", *started_at_ms)?));
            object(entries)
        }
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
            description,
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
            if let Some(description) = nonempty_text(description.as_ref()) {
                entries.push(("description", description));
            }
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
            description,
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
            if let Some(description) = nonempty_text(description.as_ref()) {
                entries.push(("description", description));
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
            description,
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
            if let Some(description) = nonempty_text(description.as_ref()) {
                entries.push(("description", description));
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

/// Replay-only diagnostic over the exact ordered Entity effect projection.
///
/// This reuses `kernel_output`, which also feeds the canonical Entity outbox
/// commitment. A second projection could make parity green for bytes that
/// production publishes differently. This digest never authorizes state.
pub fn compute_entity_effects_parity_digest(
    outputs: &[EntityKernelOutput],
) -> Result<[u8; 32], EntityKernelError> {
    let value = CanonicalValue::Array(
        outputs
            .iter()
            .map(kernel_output)
            .collect::<Result<Vec<_>, _>>()?,
    );
    let encoded = encode_canonical_consensus_bytes(&value).map_err(|error| {
        EntityKernelError::CommitmentEncoding {
            detail: error.to_string(),
        }
    })?;
    let mut digest = Sha256::new();
    digest.update(ENTITY_EFFECTS_PARITY_DOMAIN);
    digest.update(encoded);
    Ok(digest.finalize().into())
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
        [state.paybook.entries.len()],
    );
    Ok(EntityKernelCommitments {
        paybook_root,
        orderbook_root,
        ordered_outbox_digest,
    })
}

fn report_commitment_profile(phases: [u128; 6], rows: [usize; 1]) {
    if *PROFILE_ENTITY
        .get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
    {
        eprintln!(
            "RSCORE_COMMITMENT_PHASE paybookProject={} paybookDigest={} orderbookProject={} orderbookDigest={} outboxProject={} outboxDigest={} paybookRows={}",
            phases[0], phases[1], phases[2], phases[3], phases[4], phases[5], rows[0],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_j_finality_is_committed_as_an_owned_entity_section() {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 7);
        let finality = object(vec![
            (
                "finalizedThroughHeight",
                number("height", 9).expect("height"),
            ),
            ("tipBlockHash", text(format!("0x{}", "22".repeat(32)))),
        ]);
        state.j_history_finality = Some(finality.clone());

        let sections = compute_entity_owned_sections(&state, [0; 32], 0).expect("owned sections");
        let section = sections
            .iter()
            .find(|section| section.field == "jHistoryFinality")
            .expect("native finality section");
        assert_eq!(
            section.digest,
            consensus_digest(&finality).expect("finality digest")
        );
    }

    #[test]
    fn swap_trading_pairs_use_the_exact_typescript_consensus_shape() {
        let pairs = vec![crate::EntitySwapPair {
            base_token_id: 1,
            quote_token_id: 2,
            pair_id: "1/2".into(),
        }];
        let canonical = canonical_swap_trading_pairs(&pairs).expect("canonical pairs");
        assert_eq!(
            canonical,
            CanonicalValue::Array(vec![object(vec![
                ("baseTokenId", number_u32(1)),
                ("quoteTokenId", number_u32(2)),
                ("pairId", text("1/2")),
            ])])
        );
        assert_eq!(
            decode_canonical_swap_trading_pairs(&canonical).expect("decode pairs"),
            pairs
        );
    }

    #[test]
    fn swap_trading_pairs_reject_duplicate_market_authority() {
        let pairs = vec![
            crate::EntitySwapPair {
                base_token_id: 1,
                quote_token_id: 2,
                pair_id: "1/2".into(),
            },
            crate::EntitySwapPair {
                base_token_id: 1,
                quote_token_id: 2,
                pair_id: "duplicate".into(),
            },
        ];
        assert!(canonical_swap_trading_pairs(&pairs).is_err());
    }

    #[test]
    fn entity_effect_digest_commits_order_and_content() {
        let first = EntityKernelOutput::SwapMatched {
            entity_id: "0x11".into(),
            count: 1,
        };
        let second = EntityKernelOutput::SwapMatched {
            entity_id: "0x22".into(),
            count: 2,
        };
        let empty = compute_entity_effects_parity_digest(&[]).expect("empty digest");
        let ordered = compute_entity_effects_parity_digest(&[first.clone(), second.clone()])
            .expect("ordered digest");
        let reversed =
            compute_entity_effects_parity_digest(&[second, first]).expect("reversed digest");
        assert_ne!(empty, ordered);
        assert_ne!(ordered, reversed);
    }
}
