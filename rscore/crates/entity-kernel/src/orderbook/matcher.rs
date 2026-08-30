use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound::{Excluded, Unbounded};

use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;

use crate::types::TargetedAccountTx;
use crate::{DeterministicContext, EntityKernelError, LocalEntityOutput};

use super::book::{
    AddOrder, BookEvent, MakerDisposition, apply_gtc, apply_gtc_with_execution_price, cancel_order,
    resume_crossed,
};
use super::math::{
    base_amount_from_lots, canonical_pair, exact_quote_lot_multiple, lot_scale, pair_dimensions,
    quote_amount_from_weighted_lots, side_for,
};
use super::resolve::{ResolvePlan, build_resolve_plans};
use super::{
    BookOrder, BookState, OrderbookState, PairDimensions, PairPolicy, SameJOffer, Side,
    canonical_pair_policy,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SameJOutputDelta {
    Upsert {
        account_id: String,
        offer: Box<SameJOffer>,
    },
    Remove {
        account_id: String,
        offer_id: String,
    },
    CancelRequest {
        account_id: String,
        offer_id: String,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct OrderbookEffects {
    pub account_txs: Vec<TargetedAccountTx>,
    pub routed_entity_outputs: Vec<LocalEntityOutput>,
    pub cross_jurisdiction_fills: Vec<crate::cross_j::CrossJurisdictionBookFill>,
    pub matched_swaps: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MaterializedOffer {
    account_id: String,
    pair_id: String,
    dimensions: PairDimensions,
    side: Side,
    qty_lots: BigInt,
    owner_id: String,
    order_id: String,
}

fn order_id(account_id: &str, offer_id: &str) -> Result<String, EntityKernelError> {
    if account_id.is_empty() || offer_id.is_empty() || offer_id.contains(':') {
        return Err(EntityKernelError::orderbook("SWAP_OFFER_ID_INVALID"));
    }
    Ok(format!("{account_id}:{offer_id}"))
}

fn split_order_id(value: &str) -> Result<(String, String), EntityKernelError> {
    let Some((account, offer)) = value.rsplit_once(':') else {
        return Err(EntityKernelError::orderbook(
            "ORDERBOOK_MALFORMED_BOOK_ORDER",
        ));
    };
    if account.is_empty() || offer.is_empty() {
        return Err(EntityKernelError::orderbook(
            "ORDERBOOK_MALFORMED_BOOK_ORDER",
        ));
    }
    Ok((account.to_string(), offer.to_string()))
}

fn materialize(
    account_id: &str,
    offer: &SameJOffer,
    minimum_trade_size: &BigInt,
) -> Result<MaterializedOffer, EntityKernelError> {
    if let Some(tif) = offer.time_in_force
        && tif != 0
    {
        return Err(EntityKernelError::UnsupportedTimeInForce { value: tif });
    }
    if let Some(route) = &offer.cross_jurisdiction {
        let market = crate::cross_j::cross_jurisdiction_market(route)?;
        let scale = lot_scale(market.dimensions.base_token_decimals);
        let qty_lots = &market.base_amount / &scale;
        if qty_lots <= BigInt::from(0) {
            return Err(EntityKernelError::SwapRejected {
                code: "cross-dust-remainder",
            });
        }
        let exact = exact_quote_lot_multiple(market.dimensions, &market.price_ticks)?;
        if &qty_lots % exact != BigInt::from(0) {
            return Err(EntityKernelError::SwapRejected {
                code: "cross-quote-lot-misaligned",
            });
        }
        return Ok(MaterializedOffer {
            account_id: account_id.to_string(),
            pair_id: market.pair_id,
            dimensions: market.dimensions,
            side: market.side,
            qty_lots,
            owner_id: market.maker_id,
            order_id: order_id(account_id, &offer.offer_id)?,
        });
    }
    let (_, _, pair_id) = canonical_pair(offer.give_token_id, offer.want_token_id);
    let side = side_for(offer.give_token_id, offer.want_token_id);
    let dimensions = pair_dimensions(side, offer.give_token_decimals, offer.want_token_decimals);
    let (base_amount, quote_amount) = match side {
        Side::Ask => (&offer.give_amount, &offer.want_amount),
        Side::Bid => (&offer.want_amount, &offer.give_amount),
    };
    if base_amount <= &BigInt::from(0) || quote_amount <= &BigInt::from(0) {
        return Err(EntityKernelError::SwapRejected {
            code: "zero-amount",
        });
    }
    if minimum_trade_size > &BigInt::from(0) && quote_amount < minimum_trade_size {
        return Err(EntityKernelError::SwapRejected {
            code: "below-minTradeSize",
        });
    }
    let scale = lot_scale(dimensions.base_token_decimals);
    if base_amount % &scale != BigInt::from(0) {
        return Err(EntityKernelError::SwapRejected {
            code: "lot-misaligned",
        });
    }
    let qty_lots = base_amount / scale;
    let exact = exact_quote_lot_multiple(dimensions, &offer.price_ticks)?;
    if &qty_lots % exact != BigInt::from(0) || qty_lots <= BigInt::from(0) {
        return Err(EntityKernelError::SwapRejected {
            code: "quote-lot-misaligned",
        });
    }
    Ok(MaterializedOffer {
        account_id: account_id.to_string(),
        pair_id,
        dimensions,
        side,
        qty_lots,
        owner_id: if offer.maker_is_left {
            offer.left_entity.clone()
        } else {
            offer.right_entity.clone()
        },
        order_id: order_id(account_id, &offer.offer_id)?,
    })
}

fn queue_cancel(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    account_id: &str,
    offer_id: &str,
    comment: String,
) {
    let key = (account_id.to_string(), offer_id.to_string());
    if !state.resolving_offers.insert(key) {
        return;
    }
    effects.account_txs.push((
        account_id.to_string(),
        AccountTx::SwapResolve {
            offer_id: offer_id.to_string(),
            fill_ratio: 0,
            fill_numerator: None,
            fill_denominator: None,
            cancel_remainder: true,
            comment: Some(comment),
            fee_token_id: None,
            fee_amount: None,
            execution_give_amount: None,
            execution_want_amount: None,
            resting_give_token_id: None,
            resting_want_token_id: None,
            resting_price_ticks: None,
            resting_give_amount: None,
            resting_want_amount: None,
            resting_quantized_give: None,
            resting_quantized_want: None,
        },
    ));
}

fn index_order_pair(state: &mut OrderbookState, pair_id: &str, order_id: &str) {
    state
        .pair_by_order
        .insert(order_id.to_string(), pair_id.to_string());
}

fn unindex_order_pair(state: &mut OrderbookState, pair_id: &str, order_id: &str) {
    if state.pair_by_order.get(order_id).map(String::as_str) == Some(pair_id) {
        state.pair_by_order.remove(order_id);
    }
}

fn apply_pair_index_events(
    state: &mut OrderbookState,
    pair_id: &str,
    taker_order_id: &str,
    events: &[BookEvent],
) {
    for event in events {
        let BookEvent::Trade {
            qty,
            maker_order_id,
            maker_qty_before,
            ..
        } = event
        else {
            continue;
        };
        if qty == maker_qty_before {
            unindex_order_pair(state, pair_id, maker_order_id);
        }
    }
    let taker_is_resting = state
        .books
        .get(pair_id)
        .is_some_and(|book| book.orders.contains_key(taker_order_id));
    if taker_is_resting {
        index_order_pair(state, pair_id, taker_order_id);
    } else {
        unindex_order_pair(state, pair_id, taker_order_id);
    }
}

fn require_book<'a>(
    state: &'a OrderbookState,
    pair_id: &str,
) -> Result<&'a BookState, EntityKernelError> {
    state
        .books
        .get(pair_id)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_INTERNAL_BOOK_MISSING"))
}

fn remove_committed(
    state: &mut OrderbookState,
    account_id: &str,
    offer_id: &str,
) -> Result<(), EntityKernelError> {
    let Ok(key) = order_id(account_id, offer_id) else {
        return Ok(());
    };
    let Some(pair_id) = state.pair_by_order.get(&key).cloned() else {
        return Ok(());
    };
    if let Some(book) = state.books.get_mut(&pair_id)
        && cancel_order(book, &key)?
    {
        unindex_order_pair(state, &pair_id, &key);
    }
    Ok(())
}

/// Remove one Account-owned resting row during dispute preparation through the
/// same book/index mutation used by normal Account output reconciliation.
pub(crate) fn remove_account_offer_for_dispute(
    state: &mut OrderbookState,
    account_id: &str,
    offer_id: &str,
) -> Result<bool, EntityKernelError> {
    let key = order_id(account_id, offer_id)?;
    let existed = state.pair_by_order.contains_key(&key);
    remove_committed(state, account_id, offer_id)?;
    Ok(existed)
}

fn is_local_maker(offer: &SameJOffer, entity_id: &str) -> bool {
    let maker = if offer.maker_is_left {
        &offer.left_entity
    } else {
        &offer.right_entity
    };
    maker == entity_id
}

fn apply_final_offer_index(
    state: &mut OrderbookState,
    deltas: &[SameJOutputDelta],
    entity_id: &str,
) {
    for delta in deltas {
        match delta {
            SameJOutputDelta::Upsert { account_id, offer } => {
                if is_local_maker(offer, entity_id) {
                    continue;
                }
                let key = (account_id.clone(), offer.offer_id.clone());
                state.offers.insert(key.clone(), offer.as_ref().clone());
                state.resolving_offers.remove(&key);
            }
            SameJOutputDelta::Remove {
                account_id,
                offer_id,
            } => {
                let key = (account_id.clone(), offer_id.clone());
                state.offers.remove(&key);
                state.resolving_offers.remove(&key);
            }
            SameJOutputDelta::CancelRequest { .. } => {}
        }
    }
}

fn apply_removes(
    state: &mut OrderbookState,
    deltas: &[SameJOutputDelta],
) -> Result<(), EntityKernelError> {
    for delta in deltas {
        if let SameJOutputDelta::Remove {
            account_id,
            offer_id,
        } = delta
        {
            remove_committed(state, account_id, offer_id)?;
        }
    }
    Ok(())
}

fn apply_cancel_requests(
    state: &mut OrderbookState,
    deltas: &[SameJOutputDelta],
    effects: &mut OrderbookEffects,
) -> Result<(), EntityKernelError> {
    for delta in deltas {
        let SameJOutputDelta::CancelRequest {
            account_id,
            offer_id,
        } = delta
        else {
            continue;
        };
        if !state
            .offers
            .contains_key(&(account_id.clone(), offer_id.clone()))
        {
            continue;
        }
        remove_committed(state, account_id, offer_id)?;
        queue_cancel(
            state,
            effects,
            account_id,
            offer_id,
            "cancel_request".to_string(),
        );
    }
    Ok(())
}

fn same_snapshot(state: &OrderbookState, account_id: &str, offer: &SameJOffer) -> bool {
    state
        .offers
        .get(&(account_id.to_string(), offer.offer_id.clone()))
        == Some(offer)
}

fn sorted_upserts<'a>(
    deltas: &'a [SameJOutputDelta],
    entity_id: &str,
) -> Result<Vec<(&'a str, &'a SameJOffer)>, EntityKernelError> {
    let mut offers = Vec::new();
    for delta in deltas {
        if let SameJOutputDelta::Upsert { account_id, offer } = delta {
            let include = if let Some(route) = &offer.cross_jurisdiction {
                crate::cross_j::cross_jurisdiction_market(route)?.book_owner == entity_id
            } else {
                !is_local_maker(offer, entity_id)
            };
            if include {
                offers.push((account_id.as_str(), offer.as_ref()));
            }
        }
    }
    offers.sort_by(|left, right| {
        // TS processes admitted cross-j routes before same-J Account offers
        // against the same shared book collection.
        right
            .1
            .cross_jurisdiction
            .is_some()
            .cmp(&left.1.cross_jurisdiction.is_some())
            .then_with(|| {
                left.1
                    .created_height
                    .cmp(&right.1.created_height)
                    .then_with(|| left.0.cmp(right.0))
                    .then_with(|| left.1.offer_id.cmp(&right.1.offer_id))
            })
    });
    Ok(offers)
}

fn classify_maker(
    offers: &BTreeMap<(String, String), SameJOffer>,
    resolving: &BTreeSet<(String, String)>,
    order: &BookOrder,
) -> Result<MakerDisposition, EntityKernelError> {
    let (account_id, offer_id) = split_order_id(&order.order_id)?;
    let key = (account_id.clone(), offer_id.clone());
    let offer = offers.get(&key).ok_or_else(|| {
        EntityKernelError::orderbook(format!(
            "ORDERBOOK_SAME_SNAPSHOT_MISSING:{}",
            order.order_id
        ))
    })?;
    if resolving.contains(&key) {
        return Ok(MakerDisposition::Suspended);
    }
    let canonical = materialize(&account_id, offer, &BigInt::from(0))?;
    if canonical.side != order.side
        || offer.price_ticks != order.price_ticks
        || canonical.owner_id != order.owner_id
        || canonical.qty_lots != order.qty_lots
    {
        return Err(EntityKernelError::orderbook(format!(
            "ORDERBOOK_CACHE_MISMATCH:{}",
            order.order_id
        )));
    }
    Ok(MakerDisposition::Eligible)
}

pub(super) fn validate_restored_state(state: &OrderbookState) -> Result<(), EntityKernelError> {
    for (pair_id, book) in &state.books {
        let expected_dimensions = state
            .pair_dimensions
            .get(pair_id)
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_PAIR_DIMENSIONS_MISSING"))?;
        for order in book.orders.values() {
            classify_maker(&state.offers, &state.resolving_offers, order)?;
            let (account_id, offer_id) = split_order_id(&order.order_id)?;
            let offer = state
                .offers
                .get(&(account_id.clone(), offer_id))
                .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_SAME_SNAPSHOT_MISSING"))?;
            let materialized = materialize(&account_id, offer, &BigInt::from(0))?;
            if materialized.pair_id != *pair_id || &materialized.dimensions != expected_dimensions {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_RESTORED_PAIR_MISMATCH",
                ));
            }
        }
    }
    Ok(())
}

fn band_bounds(anchor: &BigInt) -> (BigInt, BigInt) {
    let offset = anchor * BigInt::from(3_000_u32) / BigInt::from(10_000_u32);
    (anchor - &offset, anchor + offset)
}

fn band_anchor(book: &BookState, policy: &PairPolicy, has_explicit_policy: bool) -> Option<BigInt> {
    match (book.best_bid(), book.best_ask()) {
        (Some(bid), Some(ask)) => Some((bid + ask) / BigInt::from(2)),
        (Some(bid), None) => Some(bid.clone()),
        (None, Some(ask)) => Some(ask.clone()),
        (None, None) => has_explicit_policy.then(|| policy.mid_price_ticks.clone()),
    }
}

fn out_of_band_order_ids(book: &BookState, min: &BigInt, max: &BigInt) -> Vec<String> {
    let mut ids = Vec::new();
    ids.extend(
        book.bids
            .range(..(Reverse(max.clone()), 0))
            .map(|(_, order_id)| order_id.clone()),
    );
    ids.extend(
        book.bids
            .range((Excluded((Reverse(min.clone()), u64::MAX)), Unbounded))
            .map(|(_, order_id)| order_id.clone()),
    );
    ids.extend(
        book.asks
            .range(..(min.clone(), 0))
            .map(|(_, order_id)| order_id.clone()),
    );
    ids.extend(
        book.asks
            .range((Excluded((max.clone(), u64::MAX)), Unbounded))
            .map(|(_, order_id)| order_id.clone()),
    );
    ids
}

fn sweep_pair(
    state: &mut OrderbookState,
    pair_id: &str,
    policy: &PairPolicy,
    has_explicit_policy: bool,
    effects: &mut OrderbookEffects,
) -> Result<(), EntityKernelError> {
    let Some(book) = state.books.get(pair_id) else {
        return Ok(());
    };
    let Some(anchor) = band_anchor(book, policy, has_explicit_policy) else {
        return Ok(());
    };
    let (min, max) = band_bounds(&anchor);
    // `orders.values().filter(...)` was O(all open orders) once per pair per
    // Entity frame. The price indices already contain the exact two disjoint
    // ranges, so a no-op sweep is now O(log n), and work is O(outliers).
    let candidates = out_of_band_order_ids(book, &min, &max)
        .into_iter()
        .map(|order_id| {
            book.orders
                .get(&order_id)
                .cloned()
                .ok_or_else(|| EntityKernelError::orderbook("BOOK_ORDER_INDEX_MISSING"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for order in candidates {
        let disposition = classify_maker(&state.offers, &state.resolving_offers, &order)?;
        if disposition == MakerDisposition::Suspended {
            continue;
        }
        let (account_id, offer_id) = split_order_id(&order.order_id)?;
        if let Some(book) = state.books.get_mut(pair_id)
            && cancel_order(book, &order.order_id)?
        {
            unindex_order_pair(state, pair_id, &order.order_id);
        }
        queue_cancel(
            state,
            effects,
            &account_id,
            &offer_id,
            format!("outside-anchor-band:{}", order.price_ticks),
        );
    }
    Ok(())
}

fn queue_plans(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    plans: Vec<ResolvePlan>,
) -> Result<(), EntityKernelError> {
    for plan in plans {
        let key = (plan.account_id.clone(), plan.offer_id);
        if !state.resolving_offers.insert(key) {
            return Err(EntityKernelError::orderbook(
                "ORDERBOOK_TRADE_PARTICIPANT_ALREADY_RESOLVING",
            ));
        }
        effects.account_txs.push((plan.account_id, plan.tx));
    }
    Ok(())
}

fn process_cross_jurisdiction_events(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    events: &[BookEvent],
) -> Result<(), EntityKernelError> {
    let mut aggregates: BTreeMap<String, (BigInt, BigInt)> = BTreeMap::new();
    for event in events {
        let BookEvent::Trade {
            price,
            qty,
            maker_order_id,
            taker_order_id,
            ..
        } = event
        else {
            continue;
        };
        for order_id in [maker_order_id, taker_order_id] {
            let entry = aggregates
                .entry(order_id.clone())
                .or_insert_with(|| (BigInt::from(0), BigInt::from(0)));
            entry.0 += qty;
            entry.1 += price * qty;
        }
    }
    let mut net_by_asset: BTreeMap<String, BigInt> = BTreeMap::new();
    for (order_id, (filled_lots, weighted_cost)) in aggregates {
        let (account_id, offer_id) = split_order_id(&order_id)?;
        let key = (account_id.clone(), offer_id.clone());
        let offer = state
            .offers
            .get(&key)
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_CROSS_J_FILL_META_MISSING"))?;
        let route = offer
            .cross_jurisdiction
            .as_ref()
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_CROSS_J_FILL_META_MISSING"))?;
        let market = crate::cross_j::cross_jurisdiction_market(route)?;
        let execution_base =
            base_amount_from_lots(market.dimensions.base_token_decimals, &filled_lots);
        let execution_quote = quote_amount_from_weighted_lots(market.dimensions, &weighted_cost);
        let (execution_source, execution_target) = if market.side == Side::Ask {
            (execution_base, execution_quote)
        } else {
            (execution_quote, execution_base)
        };
        *net_by_asset
            .entry(market.source_asset_key)
            .or_insert_with(|| BigInt::from(0)) -= &execution_source;
        *net_by_asset
            .entry(market.target_asset_key)
            .or_insert_with(|| BigInt::from(0)) += &execution_target;
        effects
            .cross_jurisdiction_fills
            .push(crate::cross_j::build_cross_jurisdiction_book_fill(
                account_id,
                offer_id,
                route.clone(),
                execution_source,
                execution_target,
                market.price_ticks,
                market.pair_id,
            )?);
        state.resolving_offers.insert(key);
    }
    let mismatches = net_by_asset
        .into_iter()
        .filter(|(_, value)| value != &BigInt::from(0))
        .map(|(asset, value)| format!("{asset}={value}"))
        .collect::<Vec<_>>();
    if !mismatches.is_empty() {
        return Err(EntityKernelError::orderbook(format!(
            "CROSS_J_TRADE_CONSERVATION_FAILED:{}",
            mismatches.join(",")
        )));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn process_events(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    materialized: &MaterializedOffer,
    current_order_id: &str,
    current_offer: &SameJOffer,
    events: &[BookEvent],
    batch: &BTreeMap<String, &SameJOffer>,
    taker_fee_bps: u16,
) -> Result<(), EntityKernelError> {
    let trades = events
        .iter()
        .filter(|event| matches!(event, BookEvent::Trade { .. }))
        .count();
    let rejects: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            BookEvent::Reject {
                reason,
                blocking_order_id,
            } => Some((*reason, blocking_order_id.clone())),
            _ => None,
        })
        .collect();
    if !rejects.is_empty() && trades == 0 {
        let comment = rejects
            .iter()
            .find_map(|(reason, blocking)| {
                (*reason == "STP cancel taker")
                    .then(|| format!("STP:{}", blocking.clone().unwrap_or_default()))
            })
            .unwrap_or_else(|| {
                rejects
                    .iter()
                    .map(|value| value.0)
                    .collect::<Vec<_>>()
                    .join(", ")
            });
        queue_cancel(
            state,
            effects,
            &materialized.account_id,
            &current_offer.offer_id,
            comment,
        );
        return Ok(());
    }
    if current_offer.cross_jurisdiction.is_some() {
        let trades = u64::try_from(trades)
            .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_MATCH_COUNT_ENCODING"))?;
        effects.matched_swaps = effects
            .matched_swaps
            .checked_add(trades)
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_MATCH_COUNT_OVERFLOW"))?;
        return process_cross_jurisdiction_events(state, effects, events);
    }
    let book = state
        .books
        .get(&materialized.pair_id)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_PAIR_MISSING"))?;
    let plans = build_resolve_plans(
        events,
        current_order_id,
        current_offer,
        &state.offers,
        batch,
        book,
        materialized.dimensions,
        taker_fee_bps,
    )?;
    let trades = u64::try_from(trades)
        .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_MATCH_COUNT_ENCODING"))?;
    effects.matched_swaps = effects
        .matched_swaps
        .checked_add(trades)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_MATCH_COUNT_OVERFLOW"))?;
    queue_plans(state, effects, plans)
}

fn identical_order(
    book: &BookState,
    materialized: &MaterializedOffer,
    offer: &SameJOffer,
) -> Result<bool, EntityKernelError> {
    let Some(existing) = book.orders.get(&materialized.order_id) else {
        return Ok(false);
    };
    if existing.owner_id != materialized.owner_id
        || existing.side != materialized.side
        || existing.qty_lots != materialized.qty_lots
        || existing.price_ticks != offer.price_ticks
    {
        return Err(EntityKernelError::orderbook("ORDERBOOK_CACHE_MISMATCH"));
    }
    Ok(true)
}

fn process_one_offer<'a>(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    account_id: &str,
    offer: &'a SameJOffer,
    context: &DeterministicContext,
    swept: &mut BTreeSet<String>,
    batch: &mut BTreeMap<String, &'a SameJOffer>,
) -> Result<(), EntityKernelError> {
    if state
        .resolving_offers
        .contains(&(account_id.to_string(), offer.offer_id.clone()))
    {
        return Ok(());
    }
    let materialized = match materialize(account_id, offer, &context.minimum_trade_size) {
        Ok(value) => value,
        Err(EntityKernelError::SwapRejected { code }) => {
            queue_cancel(
                state,
                effects,
                account_id,
                &offer.offer_id,
                code.to_string(),
            );
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let (base, quote, _) = canonical_pair(offer.give_token_id, offer.want_token_id);
    let (policy, has_explicit_policy) = canonical_pair_policy(base, quote, materialized.dimensions);
    if let Some(supplied) = context.pair_policies.get(&materialized.pair_id)
        && supplied != &policy
    {
        return Err(EntityKernelError::orderbook(format!(
            "ORDERBOOK_PAIR_POLICY_DRIFT:{}",
            materialized.pair_id
        )));
    }
    if let Some(existing) = state.pair_dimensions.get(&materialized.pair_id)
        && existing != &materialized.dimensions
    {
        queue_cancel(
            state,
            effects,
            account_id,
            &offer.offer_id,
            "pair-decimals-mismatch".to_string(),
        );
        return Ok(());
    }
    let pair_already_exists = state.books.contains_key(&materialized.pair_id);
    if swept.insert(materialized.pair_id.clone()) {
        sweep_pair(
            state,
            &materialized.pair_id,
            &policy,
            has_explicit_policy,
            effects,
        )?;
    }
    let anchor = match state.books.get(&materialized.pair_id) {
        Some(book) => band_anchor(book, &policy, has_explicit_policy),
        None => has_explicit_policy.then(|| policy.mid_price_ticks.clone()),
    };
    if let Some(anchor) = anchor {
        let (min, max) = band_bounds(&anchor);
        if offer.price_ticks < min || offer.price_ticks > max {
            queue_cancel(
                state,
                effects,
                account_id,
                &offer.offer_id,
                format!("outside-anchor-band:{}", offer.price_ticks),
            );
            return Ok(());
        }
    }
    // TS creates the empty candidate book before price-band validation but
    // publishes it only after the command is accepted. Persisting it earlier
    // makes a rejected first offer mutate pairDimensions/books and forks the
    // Entity root even though both engines emit the same cancel transaction.
    if !pair_already_exists {
        state
            .pair_dimensions
            .insert(materialized.pair_id.clone(), materialized.dimensions);
        state.books.insert(
            materialized.pair_id.clone(),
            BookState::empty(state.max_orders_per_pair, policy.book_bucket_width_ticks),
        );
    }
    batch.insert(materialized.order_id.clone(), offer);
    let is_identical = identical_order(
        require_book(state, &materialized.pair_id)?,
        &materialized,
        offer,
    )?;
    let offers = &state.offers;
    let resolving = &state.resolving_offers;
    let book = state
        .books
        .get_mut(&materialized.pair_id)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_INTERNAL_BOOK_MISSING"))?;
    let is_cross_jurisdiction = offer.cross_jurisdiction.is_some();
    let events_and_taker = if is_identical && is_cross_jurisdiction {
        None
    } else if is_identical {
        resume_crossed(book, materialized.dimensions, |maker| {
            classify_maker(offers, resolving, maker)
        })?
    } else {
        let input = AddOrder {
            order_id: materialized.order_id.clone(),
            owner_id: materialized.owner_id.clone(),
            side: materialized.side,
            price_ticks: offer.price_ticks.clone(),
            qty_lots: materialized.qty_lots.clone(),
        };
        let events = if is_cross_jurisdiction {
            apply_gtc_with_execution_price(
                book,
                input,
                materialized.dimensions,
                |maker| classify_maker(offers, resolving, maker),
                |maker, taker| {
                    // Source savings: execution is always at the ask, never
                    // generic maker price when a bid rests first.
                    if taker.side == Side::Ask {
                        taker.price_ticks.clone()
                    } else {
                        maker.price_ticks.clone()
                    }
                },
            )?
        } else {
            apply_gtc(book, input, materialized.dimensions, |maker| {
                classify_maker(offers, resolving, maker)
            })?
        };
        Some((materialized.order_id.clone(), events))
    };
    if let Some((taker_order_id, events)) = events_and_taker {
        apply_pair_index_events(state, &materialized.pair_id, &taker_order_id, &events);
        let (taker_account, taker_offer_id) = split_order_id(&taker_order_id)?;
        let taker_offer = state
            .offers
            .get(&(taker_account.clone(), taker_offer_id))
            .cloned()
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_SAME_SNAPSHOT_MISSING"))?;
        let taker_materialized =
            materialize(&taker_account, &taker_offer, &context.minimum_trade_size)?;
        process_events(
            state,
            effects,
            &taker_materialized,
            &taker_order_id,
            &taker_offer,
            &events,
            batch,
            context.swap_taker_fee_bps,
        )?;
    }
    Ok(())
}

pub(crate) fn apply_orderbook_outputs(
    state: &mut OrderbookState,
    deltas: &[SameJOutputDelta],
    context: &DeterministicContext,
    entity_id: &str,
) -> Result<OrderbookEffects, EntityKernelError> {
    let mut effects = OrderbookEffects::default();
    apply_final_offer_index(state, deltas, entity_id);
    apply_removes(state, deltas)?;
    apply_cancel_requests(state, deltas, &mut effects)?;
    let mut swept = BTreeSet::new();
    let mut batch = BTreeMap::new();
    for (account_id, offer) in sorted_upserts(deltas, entity_id)? {
        if !same_snapshot(state, account_id, offer) {
            continue;
        }
        process_one_offer(
            state,
            &mut effects,
            account_id,
            offer,
            context,
            &mut swept,
            &mut batch,
        )?;
    }
    Ok(effects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book_order(order_id: &str) -> BookOrder {
        BookOrder {
            order_id: order_id.to_string(),
            owner_id: "owner".to_string(),
            side: Side::Bid,
            price_ticks: BigInt::from(1),
            qty_lots: BigInt::from(1),
            seq: 1,
            page_sequence: 0,
            page_slot: 0,
        }
    }

    fn index_price(book: &mut BookState, side: Side, price: u32, seq: u64, id: &str) {
        match side {
            Side::Bid => {
                book.bids
                    .insert((Reverse(BigInt::from(price)), seq), id.to_string());
            }
            Side::Ask => {
                book.asks.insert((BigInt::from(price), seq), id.to_string());
            }
        }
    }

    #[test]
    fn band_sweep_uses_only_strict_outlier_price_ranges() {
        let mut book = BookState::empty(20_000, 100);
        for side in [Side::Bid, Side::Ask] {
            index_price(&mut book, side, 9, 1, &format!("{side:?}-low"));
            index_price(&mut book, side, 10, 2, &format!("{side:?}-min"));
            index_price(&mut book, side, 15, 3, &format!("{side:?}-mid"));
            index_price(&mut book, side, 20, 4, &format!("{side:?}-max"));
            index_price(&mut book, side, 21, 5, &format!("{side:?}-high"));
        }
        let actual = out_of_band_order_ids(&book, &BigInt::from(10), &BigInt::from(20))
            .into_iter()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual,
            ["Ask-high", "Ask-low", "Bid-high", "Bid-low"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[test]
    fn pair_index_updates_only_orders_changed_by_match_events() {
        let pair_id = "1/2";
        let mut state = OrderbookState::empty(20_000);
        let mut book = BookState::empty(20_000, 100);
        book.orders.insert("taker".to_string(), book_order("taker"));
        state.books.insert(pair_id.to_string(), book);
        for index in 0..4_096 {
            state
                .pair_by_order
                .insert(format!("unrelated-{index}"), "9/10".to_string());
        }
        state
            .pair_by_order
            .insert("full-maker".to_string(), pair_id.to_string());
        state
            .pair_by_order
            .insert("partial-maker".to_string(), pair_id.to_string());

        apply_pair_index_events(
            &mut state,
            pair_id,
            "taker",
            &[
                BookEvent::Trade {
                    price: BigInt::from(1),
                    qty: BigInt::from(5),
                    maker_order_id: "full-maker".to_string(),
                    taker_order_id: "taker".to_string(),
                    maker_qty_before: BigInt::from(5),
                    taker_qty_total: BigInt::from(8),
                },
                BookEvent::Trade {
                    price: BigInt::from(1),
                    qty: BigInt::from(3),
                    maker_order_id: "partial-maker".to_string(),
                    taker_order_id: "taker".to_string(),
                    maker_qty_before: BigInt::from(7),
                    taker_qty_total: BigInt::from(8),
                },
            ],
        );

        assert!(!state.pair_by_order.contains_key("full-maker"));
        assert_eq!(state.pair_by_order["partial-maker"], pair_id);
        assert_eq!(state.pair_by_order["taker"], pair_id);
        assert_eq!(state.pair_by_order["unrelated-4095"], "9/10");
        assert_eq!(state.pair_by_order.len(), 4_098);

        state.books.get_mut(pair_id).unwrap().orders.remove("taker");
        apply_pair_index_events(&mut state, pair_id, "taker", &[]);
        assert!(!state.pair_by_order.contains_key("taker"));
        assert_eq!(state.pair_by_order.len(), 4_097);
    }

    #[test]
    fn rejected_first_offer_does_not_publish_an_empty_pair() {
        let account_id = "0x0000000000000000000000000000000000000001";
        let hub_id = "0x0000000000000000000000000000000000000002";
        let give = BigInt::from(10_u8).pow(18);
        let want = BigInt::from(400_u32);
        let offer = SameJOffer {
            offer_id: "outside-band".to_string(),
            left_entity: account_id.to_string(),
            right_entity: hub_id.to_string(),
            give_token_id: 2,
            give_token_decimals: 18,
            give_amount: give.clone(),
            want_token_id: 1,
            want_token_decimals: 6,
            want_amount: want.clone(),
            max_fee: BigInt::from(0),
            min_net_receive: want.clone(),
            price_ticks: BigInt::from(4),
            time_in_force: Some(0),
            maker_is_left: true,
            created_height: 1,
            quantized_give: give,
            quantized_want: want,
            cross_jurisdiction: None,
        };
        let mut state = OrderbookState::empty(20_000);

        let effects = apply_orderbook_outputs(
            &mut state,
            &[SameJOutputDelta::Upsert {
                account_id: account_id.to_string(),
                offer: Box::new(offer),
            }],
            &DeterministicContext::hlt_default(),
            hub_id,
        )
        .expect("outside-band offer is a typed cancellation");

        assert!(state.books.is_empty());
        assert!(state.pair_dimensions.is_empty());
        assert_eq!(effects.account_txs.len(), 1);
        assert!(matches!(
            &effects.account_txs[0].1,
            AccountTx::SwapResolve { comment: Some(comment), .. }
                if comment == "outside-anchor-band:4"
        ));
    }
}
