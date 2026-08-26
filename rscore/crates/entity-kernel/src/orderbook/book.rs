use num_bigint::BigInt;

use crate::EntityKernelError;

use super::math::exact_quote_lot_multiple;
use super::page::{BookPricePageEntry, BookPricePageLocation, page_tree_mut};
use super::{BookOrder, BookState, PairDimensions, Side};

const PRIME: u64 = 0x0100_0001;
const EVENT_MASK: u64 = 0x1f_ffff_ffff_ffff;
const MAX_QTY_LOTS_POWER: u32 = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MakerDisposition {
    Eligible,
    Suspended,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BookEvent {
    Ack,
    Reject {
        reason: &'static str,
        blocking_order_id: Option<String>,
    },
    Trade {
        price: BigInt,
        qty: BigInt,
        maker_order_id: String,
        taker_order_id: String,
        maker_qty_before: BigInt,
        taker_qty_total: BigInt,
    },
    Reduced,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AddOrder {
    pub order_id: String,
    pub owner_id: String,
    pub side: Side,
    pub price_ticks: BigInt,
    pub qty_lots: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MatchResult {
    remaining: BigInt,
    blocking_order_id: Option<String>,
}

fn low_u32(value: &BigInt) -> u32 {
    value.to_u32_digits().1.first().copied().unwrap_or(0)
}

fn bump_hash(state: &mut BookState, tag: u32, a: &BigInt, b: &BigInt) {
    let tag_bits = tag.wrapping_mul(2_654_435_761);
    let mixed = tag_bits ^ low_u32(a) ^ low_u32(b).wrapping_shl(7);
    let signed = i64::from(mixed as i32);
    let next = &state.event_hash * BigInt::from(PRIME) + BigInt::from(signed);
    state.event_hash = next & BigInt::from(EVENT_MASK);
}

fn max_qty_lots() -> BigInt {
    BigInt::from(10_u8).pow(MAX_QTY_LOTS_POWER)
}

fn crosses(side: Side, taker: &BigInt, maker: &BigInt) -> bool {
    match side {
        Side::Bid => maker <= taker,
        Side::Ask => maker >= taker,
    }
}

fn index_order(state: &mut BookState, order: &BookOrder) {
    match order.side {
        Side::Bid => {
            state.bids.insert(
                (std::cmp::Reverse(order.price_ticks.clone()), order.seq),
                order.order_id.clone(),
            );
        }
        Side::Ask => {
            state.asks.insert(
                (order.price_ticks.clone(), order.seq),
                order.order_id.clone(),
            );
        }
    }
}

fn unindex_order(state: &mut BookState, order: &BookOrder) {
    match order.side {
        Side::Bid => {
            state
                .bids
                .remove(&(std::cmp::Reverse(order.price_ticks.clone()), order.seq));
        }
        Side::Ask => {
            state.asks.remove(&(order.price_ticks.clone(), order.seq));
        }
    }
}

pub(crate) fn add_resting(state: &mut BookState, input: AddOrder) -> Result<(), EntityKernelError> {
    if state.orders.len() >= state.max_orders {
        return Err(EntityKernelError::orderbook("ORDERBOOK_CAPACITY"));
    }
    let next_seq = state
        .next_seq
        .checked_add(1)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_SEQUENCE_OVERFLOW"))?;
    let location = page_tree_mut(&mut state.bid_pages, &mut state.ask_pages, input.side).append(
        &input.price_ticks,
        BookPricePageEntry {
            order_id: input.order_id.clone(),
            owner_id: input.owner_id.clone(),
            qty_lots: input.qty_lots.clone(),
            seq: state.next_seq,
        },
    )?;
    let order = BookOrder {
        order_id: input.order_id,
        owner_id: input.owner_id,
        side: input.side,
        price_ticks: input.price_ticks,
        qty_lots: input.qty_lots,
        seq: state.next_seq,
        page_sequence: location.sequence,
        page_slot: location.slot,
    };
    state.next_seq = next_seq;
    index_order(state, &order);
    bump_hash(state, 1, &order.price_ticks, &order.qty_lots);
    state.orders.insert(order.order_id.clone(), order);
    Ok(())
}

pub(crate) fn remove_order(
    state: &mut BookState,
    order_id: &str,
) -> Result<Option<BookOrder>, EntityKernelError> {
    let Some(order) = state.orders.get(order_id).cloned() else {
        return Ok(None);
    };
    page_tree_mut(&mut state.bid_pages, &mut state.ask_pages, order.side).remove(
        &order.price_ticks,
        BookPricePageLocation {
            sequence: order.page_sequence,
            slot: order.page_slot,
        },
        order_id,
    )?;
    state.orders.remove(order_id);
    unindex_order(state, &order);
    Ok(Some(order))
}

pub(crate) fn cancel_order(
    state: &mut BookState,
    order_id: &str,
) -> Result<bool, EntityKernelError> {
    let Some(order) = remove_order(state, order_id)? else {
        return Ok(false);
    };
    bump_hash(state, 5, &order.price_ticks, &BigInt::from(0));
    Ok(true)
}

fn ordered_ids(state: &BookState, side: Side) -> Vec<String> {
    match side {
        Side::Bid => state.bids.values().cloned().collect(),
        Side::Ask => state.asks.values().cloned().collect(),
    }
}

fn next_maker<F>(
    state: &mut BookState,
    taker: &AddOrder,
    classify: &mut F,
) -> Result<Option<BookOrder>, EntityKernelError>
where
    F: FnMut(&BookOrder) -> Result<MakerDisposition, EntityKernelError>,
{
    let maker_side = match taker.side {
        Side::Bid => Side::Ask,
        Side::Ask => Side::Bid,
    };
    for order_id in ordered_ids(state, maker_side) {
        let order = state
            .orders
            .get(&order_id)
            .cloned()
            .ok_or_else(|| EntityKernelError::orderbook("BOOK_ORDER_INDEX_MISSING"))?;
        if !crosses(taker.side, &taker.price_ticks, &order.price_ticks) {
            return Ok(None);
        }
        match classify(&order)? {
            MakerDisposition::Eligible => return Ok(Some(order)),
            MakerDisposition::Suspended => continue,
        }
    }
    Ok(None)
}

fn execution_qty(candidate: &BigInt, multiple: &BigInt) -> BigInt {
    candidate / multiple * multiple
}

fn apply_fill(
    state: &mut BookState,
    maker: &BookOrder,
    taker: &AddOrder,
    remaining: &BigInt,
    fill: &BigInt,
    events: &mut Vec<BookEvent>,
) -> Result<(), EntityKernelError> {
    state.trade_count = state
        .trade_count
        .checked_add(1)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_TRADE_COUNT_OVERFLOW"))?;
    state.trade_qty_sum += fill;
    state.last_trade_price_ticks = maker.price_ticks.clone();
    bump_hash(state, 3, &maker.price_ticks, fill);
    events.push(BookEvent::Trade {
        price: maker.price_ticks.clone(),
        qty: fill.clone(),
        maker_order_id: maker.order_id.clone(),
        taker_order_id: taker.order_id.clone(),
        maker_qty_before: maker.qty_lots.clone(),
        taker_qty_total: taker.qty_lots.clone(),
    });
    if fill == &maker.qty_lots {
        remove_order(state, &maker.order_id)?;
    } else {
        let next = &maker.qty_lots - fill;
        page_tree_mut(&mut state.bid_pages, &mut state.ask_pages, maker.side).reduce(
            &maker.price_ticks,
            BookPricePageLocation {
                sequence: maker.page_sequence,
                slot: maker.page_slot,
            },
            &maker.order_id,
            &next,
        )?;
        if let Some(stored) = state.orders.get_mut(&maker.order_id) {
            stored.qty_lots = next;
        }
        events.push(BookEvent::Reduced);
    }
    let _ = remaining;
    Ok(())
}

fn match_order<F>(
    state: &mut BookState,
    taker: &AddOrder,
    dimensions: PairDimensions,
    classify: &mut F,
    events: &mut Vec<BookEvent>,
) -> Result<MatchResult, EntityKernelError>
where
    F: FnMut(&BookOrder) -> Result<MakerDisposition, EntityKernelError>,
{
    let mut remaining = taker.qty_lots.clone();
    while remaining > BigInt::from(0) {
        let Some(maker) = next_maker(state, taker, classify)? else {
            break;
        };
        if maker.owner_id == taker.owner_id {
            events.push(BookEvent::Reject {
                reason: "STP cancel taker",
                blocking_order_id: Some(maker.order_id.clone()),
            });
            return Ok(MatchResult {
                remaining,
                blocking_order_id: Some(maker.order_id),
            });
        }
        let candidate = maker.qty_lots.clone().min(remaining.clone());
        let multiple = exact_quote_lot_multiple(dimensions, &maker.price_ticks)?;
        let fill = execution_qty(&candidate, &multiple);
        if fill <= BigInt::from(0) {
            break;
        }
        apply_fill(state, &maker, taker, &remaining, &fill, events)?;
        remaining -= &fill;
        if fill < maker.qty_lots {
            break;
        }
    }
    Ok(MatchResult {
        remaining,
        blocking_order_id: None,
    })
}

pub(crate) fn apply_gtc<F>(
    state: &mut BookState,
    input: AddOrder,
    dimensions: PairDimensions,
    mut classify: F,
) -> Result<Vec<BookEvent>, EntityKernelError>
where
    F: FnMut(&BookOrder) -> Result<MakerDisposition, EntityKernelError>,
{
    if input.qty_lots <= BigInt::from(0) || input.qty_lots > max_qty_lots() {
        return Ok(vec![BookEvent::Reject {
            reason: "qty out of range",
            blocking_order_id: None,
        }]);
    }
    if input.price_ticks <= BigInt::from(0) || state.orders.contains_key(&input.order_id) {
        return Err(EntityKernelError::orderbook("BOOK_ADD_INVALID"));
    }
    let mut working = state.clone();
    let mut events = Vec::new();
    let matched = match_order(&mut working, &input, dimensions, &mut classify, &mut events)?;
    if matched.remaining > BigInt::from(0) && matched.blocking_order_id.is_none() {
        let multiple = exact_quote_lot_multiple(dimensions, &input.price_ticks)?;
        let resting = execution_qty(&matched.remaining, &multiple);
        if resting > BigInt::from(0) {
            add_resting(
                &mut working,
                AddOrder {
                    qty_lots: resting,
                    ..input
                },
            )?;
            events.push(BookEvent::Ack);
        }
    } else if matched.remaining == input.qty_lots && events.is_empty() {
        events.push(BookEvent::Reject {
            reason: "no fill",
            blocking_order_id: None,
        });
    }
    *state = working;
    Ok(events)
}

fn crossed_taker(state: &BookState) -> Option<BookOrder> {
    let bid_id = state.bids.first_key_value()?.1;
    let ask_id = state.asks.first_key_value()?.1;
    let bid = state.orders.get(bid_id)?;
    let ask = state.orders.get(ask_id)?;
    if bid.price_ticks < ask.price_ticks {
        return None;
    }
    Some(if bid.seq > ask.seq { bid } else { ask }.clone())
}

pub(crate) fn resume_crossed<F>(
    state: &mut BookState,
    dimensions: PairDimensions,
    mut classify: F,
) -> Result<Option<(String, Vec<BookEvent>)>, EntityKernelError>
where
    F: FnMut(&BookOrder) -> Result<MakerDisposition, EntityKernelError>,
{
    let Some(taker_order) = crossed_taker(state) else {
        return Ok(None);
    };
    let taker = AddOrder {
        order_id: taker_order.order_id.clone(),
        owner_id: taker_order.owner_id.clone(),
        side: taker_order.side,
        price_ticks: taker_order.price_ticks.clone(),
        qty_lots: taker_order.qty_lots.clone(),
    };
    let mut events = Vec::new();
    let matched = match_order(state, &taker, dimensions, &mut classify, &mut events)?;
    if matched.blocking_order_id.is_some() || matched.remaining == BigInt::from(0) {
        remove_order(state, &taker.order_id)?;
    } else if matched.remaining < taker.qty_lots {
        page_tree_mut(&mut state.bid_pages, &mut state.ask_pages, taker_order.side).reduce(
            &taker_order.price_ticks,
            BookPricePageLocation {
                sequence: taker_order.page_sequence,
                slot: taker_order.page_slot,
            },
            &taker_order.order_id,
            &matched.remaining,
        )?;
        if let Some(stored) = state.orders.get_mut(&taker.order_id) {
            stored.qty_lots = matched.remaining;
        }
    }
    Ok((!events.is_empty()).then_some((taker.order_id, events)))
}
