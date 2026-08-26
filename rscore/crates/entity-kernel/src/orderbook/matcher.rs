use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;

use crate::types::TargetedAccountTx;
use crate::{DeterministicContext, EntityKernelError};

use super::book::{AddOrder, BookEvent, MakerDisposition, apply_gtc, cancel_order, resume_crossed};
use super::math::{canonical_pair, exact_quote_lot_multiple, lot_scale, pair_dimensions, side_for};
use super::resolve::{ResolvePlan, build_resolve_plans};
use super::{BookOrder, BookState, OrderbookState, PairDimensions, PairPolicy, SameJOffer, Side};

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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OrderbookEffects {
    pub account_txs: Vec<TargetedAccountTx>,
    pub matched_swaps: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MaterializedOffer {
    account_id: String,
    offer: SameJOffer,
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
        offer: offer.clone(),
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

fn sync_pair_index(state: &mut OrderbookState, pair_id: &str) {
    state.pair_by_order.retain(|_, pair| pair != pair_id);
    let Some(book) = state.books.get(pair_id) else {
        return;
    };
    for order_id in book.orders.keys() {
        state
            .pair_by_order
            .insert(order_id.clone(), pair_id.to_string());
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
    if let Some(book) = state.books.get_mut(&pair_id) {
        cancel_order(book, &key)?;
    }
    sync_pair_index(state, &pair_id);
    Ok(())
}

fn apply_final_offer_index(state: &mut OrderbookState, deltas: &[SameJOutputDelta]) {
    for delta in deltas {
        match delta {
            SameJOutputDelta::Upsert { account_id, offer } => {
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

fn sorted_upserts(deltas: &[SameJOutputDelta]) -> Vec<(String, SameJOffer)> {
    let mut offers: Vec<_> = deltas
        .iter()
        .filter_map(|delta| match delta {
            SameJOutputDelta::Upsert { account_id, offer } => {
                Some((account_id.clone(), offer.as_ref().clone()))
            }
            _ => None,
        })
        .collect();
    offers.sort_by(|left, right| {
        left.1
            .created_height
            .cmp(&right.1.created_height)
            .then_with(|| left.0.cmp(&right.0))
            .then_with(|| left.1.offer_id.cmp(&right.1.offer_id))
    });
    offers
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
        || canonical.offer.price_ticks != order.price_ticks
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

fn band_anchor(book: &BookState, policy: &PairPolicy) -> BigInt {
    match (book.best_bid(), book.best_ask()) {
        (Some(bid), Some(ask)) => (bid + ask) / BigInt::from(2),
        (Some(bid), None) => bid.clone(),
        (None, Some(ask)) => ask.clone(),
        (None, None) => policy.mid_price_ticks.clone(),
    }
}

fn sweep_pair(
    state: &mut OrderbookState,
    pair_id: &str,
    policy: &PairPolicy,
    effects: &mut OrderbookEffects,
) -> Result<(), EntityKernelError> {
    let Some(book) = state.books.get(pair_id) else {
        return Ok(());
    };
    let (min, max) = band_bounds(&band_anchor(book, policy));
    let candidates: Vec<_> = book
        .orders
        .values()
        .filter(|order| order.price_ticks < min || order.price_ticks > max)
        .cloned()
        .collect();
    for order in candidates {
        let disposition = classify_maker(&state.offers, &state.resolving_offers, &order)?;
        if disposition == MakerDisposition::Suspended {
            continue;
        }
        let (account_id, offer_id) = split_order_id(&order.order_id)?;
        if let Some(book) = state.books.get_mut(pair_id) {
            cancel_order(book, &order.order_id)?;
        }
        queue_cancel(
            state,
            effects,
            &account_id,
            &offer_id,
            format!("outside-anchor-band:{}", order.price_ticks),
        );
    }
    sync_pair_index(state, pair_id);
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

#[allow(clippy::too_many_arguments)]
fn process_events(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    materialized: &MaterializedOffer,
    current_order_id: &str,
    current_offer: &SameJOffer,
    events: &[BookEvent],
    batch: &BTreeMap<String, SameJOffer>,
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
            &materialized.offer.offer_id,
            comment,
        );
        return Ok(());
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

fn identical_order(book: &BookState, offer: &MaterializedOffer) -> Result<bool, EntityKernelError> {
    let Some(existing) = book.orders.get(&offer.order_id) else {
        return Ok(false);
    };
    if existing.owner_id != offer.owner_id
        || existing.side != offer.side
        || existing.qty_lots != offer.qty_lots
        || existing.price_ticks != offer.offer.price_ticks
    {
        return Err(EntityKernelError::orderbook("ORDERBOOK_CACHE_MISMATCH"));
    }
    Ok(true)
}

fn process_one_offer(
    state: &mut OrderbookState,
    effects: &mut OrderbookEffects,
    account_id: String,
    offer: SameJOffer,
    context: &DeterministicContext,
    swept: &mut BTreeSet<String>,
    batch: &mut BTreeMap<String, SameJOffer>,
) -> Result<(), EntityKernelError> {
    if state
        .resolving_offers
        .contains(&(account_id.clone(), offer.offer_id.clone()))
    {
        return Ok(());
    }
    let materialized = match materialize(&account_id, &offer, &context.minimum_trade_size) {
        Ok(value) => value,
        Err(EntityKernelError::SwapRejected { code }) => {
            queue_cancel(
                state,
                effects,
                &account_id,
                &offer.offer_id,
                code.to_string(),
            );
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let policy = context
        .pair_policies
        .get(&materialized.pair_id)
        .ok_or_else(|| {
            EntityKernelError::orderbook(format!(
                "ORDERBOOK_PAIR_POLICY_MISSING:{}",
                materialized.pair_id
            ))
        })?;
    if let Some(existing) = state.pair_dimensions.get(&materialized.pair_id)
        && existing != &materialized.dimensions
    {
        queue_cancel(
            state,
            effects,
            &account_id,
            &offer.offer_id,
            "pair-decimals-mismatch".to_string(),
        );
        return Ok(());
    }
    state
        .pair_dimensions
        .insert(materialized.pair_id.clone(), materialized.dimensions);
    state
        .books
        .entry(materialized.pair_id.clone())
        .or_insert_with(|| {
            BookState::empty(state.max_orders_per_pair, policy.book_bucket_width_ticks)
        });
    if swept.insert(materialized.pair_id.clone()) {
        sweep_pair(state, &materialized.pair_id, policy, effects)?;
    }
    let anchor = band_anchor(require_book(state, &materialized.pair_id)?, policy);
    let (min, max) = band_bounds(&anchor);
    if offer.price_ticks < min || offer.price_ticks > max {
        queue_cancel(
            state,
            effects,
            &account_id,
            &offer.offer_id,
            format!("outside-anchor-band:{}", offer.price_ticks),
        );
        return Ok(());
    }
    batch.insert(materialized.order_id.clone(), offer.clone());
    let is_identical = identical_order(require_book(state, &materialized.pair_id)?, &materialized)?;
    let offers = &state.offers;
    let resolving = &state.resolving_offers;
    let book = state
        .books
        .get_mut(&materialized.pair_id)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_INTERNAL_BOOK_MISSING"))?;
    let events_and_taker = if is_identical {
        resume_crossed(book, materialized.dimensions, |maker| {
            classify_maker(offers, resolving, maker)
        })?
    } else {
        let events = apply_gtc(
            book,
            AddOrder {
                order_id: materialized.order_id.clone(),
                owner_id: materialized.owner_id.clone(),
                side: materialized.side,
                price_ticks: offer.price_ticks.clone(),
                qty_lots: materialized.qty_lots.clone(),
            },
            materialized.dimensions,
            |maker| classify_maker(offers, resolving, maker),
        )?;
        Some((materialized.order_id.clone(), events))
    };
    sync_pair_index(state, &materialized.pair_id);
    if let Some((taker_order_id, events)) = events_and_taker {
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
) -> Result<OrderbookEffects, EntityKernelError> {
    let mut effects = OrderbookEffects::default();
    apply_final_offer_index(state, deltas);
    apply_removes(state, deltas)?;
    apply_cancel_requests(state, deltas, &mut effects)?;
    let mut swept = BTreeSet::new();
    let mut batch = BTreeMap::new();
    for (account_id, offer) in sorted_upserts(deltas) {
        if !same_snapshot(state, &account_id, &offer) {
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
