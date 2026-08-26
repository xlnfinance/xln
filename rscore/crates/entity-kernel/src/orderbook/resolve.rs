use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_engine::AccountTx;

use crate::EntityKernelError;

use super::book::BookEvent;
use super::math::{
    base_amount_from_lots, ceil_div, quote_amount, quote_amount_from_weighted_lots, ratio_u16,
    reduced_ratio, side_for,
};
use super::{BookState, PairDimensions, SameJOffer, Side};

#[derive(Clone, Debug, PartialEq, Eq)]
struct FillAggregate {
    filled_lots: BigInt,
    original_lots: BigInt,
    weighted_cost: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExecutionOffer {
    give_token_id: u32,
    give_token_decimals: u32,
    give_amount: BigInt,
    want_token_id: u32,
    want_token_decimals: u32,
    want_amount: BigInt,
    max_fee: BigInt,
    min_net_receive: BigInt,
    price_ticks: BigInt,
    quantized_give: BigInt,
    quantized_want: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvePlan {
    pub account_id: String,
    pub offer_id: String,
    pub tx: AccountTx,
}

fn add_fill(
    ordered: &mut Vec<(String, FillAggregate)>,
    order_id: &str,
    qty: &BigInt,
    original: &BigInt,
    cost: &BigInt,
) {
    if let Some((_, aggregate)) = ordered.iter_mut().find(|(key, _)| key == order_id) {
        aggregate.filled_lots += qty;
        aggregate.weighted_cost += cost;
        return;
    }
    ordered.push((
        order_id.to_string(),
        FillAggregate {
            filled_lots: qty.clone(),
            original_lots: original.clone(),
            weighted_cost: cost.clone(),
        },
    ));
}

fn aggregate_fills(events: &[BookEvent]) -> Vec<(String, FillAggregate)> {
    let mut ordered = Vec::new();
    for event in events {
        let BookEvent::Trade {
            price,
            qty,
            maker_order_id,
            taker_order_id,
            maker_qty_before,
            taker_qty_total,
        } = event
        else {
            continue;
        };
        let cost = price * qty;
        add_fill(&mut ordered, maker_order_id, qty, maker_qty_before, &cost);
        add_fill(&mut ordered, taker_order_id, qty, taker_qty_total, &cost);
    }
    ordered
}

fn split_order_id(order_id: &str) -> Result<(String, String), EntityKernelError> {
    let Some((account_id, offer_id)) = order_id.rsplit_once(':') else {
        return Err(EntityKernelError::orderbook("ORDERBOOK_FILL_LOOKUP_FAILED"));
    };
    if account_id.is_empty() || offer_id.is_empty() {
        return Err(EntityKernelError::orderbook("ORDERBOOK_FILL_LOOKUP_FAILED"));
    }
    Ok((account_id.to_string(), offer_id.to_string()))
}

fn authorization_valid(offer: &ExecutionOffer) -> bool {
    offer.give_amount > BigInt::from(0)
        && offer.want_amount > BigInt::from(0)
        && offer.max_fee >= BigInt::from(0)
        && offer.max_fee <= offer.want_amount
        && offer.min_net_receive >= BigInt::from(0)
        && offer.min_net_receive <= offer.want_amount
}

fn requantized_authorization(
    source: &SameJOffer,
    next_give: &BigInt,
    next_want: &BigInt,
) -> Result<(BigInt, BigInt), EntityKernelError> {
    if next_give <= &BigInt::from(0)
        || next_give > &source.give_amount
        || next_want <= &BigInt::from(0)
    {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_REMAINDER_INVALID",
        });
    }
    let removed_give = &source.give_amount - next_give;
    let removed_fee = &source.max_fee * &removed_give / &source.give_amount;
    let removed_min = ceil_div(&source.min_net_receive * removed_give, &source.give_amount);
    let max_fee = &source.max_fee - removed_fee;
    let min_net_receive = &source.min_net_receive - removed_min;
    if max_fee < BigInt::from(0)
        || max_fee > *next_want
        || min_net_receive < BigInt::from(0)
        || min_net_receive > *next_want
    {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_OFFER_AMOUNT_INVALID",
        });
    }
    Ok((max_fee, min_net_receive))
}

fn current_execution_offer(snapshot: &SameJOffer) -> ExecutionOffer {
    ExecutionOffer {
        give_token_id: snapshot.give_token_id,
        give_token_decimals: snapshot.give_token_decimals,
        give_amount: snapshot.give_amount.clone(),
        want_token_id: snapshot.want_token_id,
        want_token_decimals: snapshot.want_token_decimals,
        want_amount: snapshot.want_amount.clone(),
        max_fee: snapshot.max_fee.clone(),
        min_net_receive: snapshot.min_net_receive.clone(),
        price_ticks: snapshot.price_ticks.clone(),
        quantized_give: snapshot.give_amount.clone(),
        quantized_want: snapshot.want_amount.clone(),
    }
}

fn resting_execution_offer(
    snapshot: &SameJOffer,
    resting_price: &BigInt,
    original_lots: &BigInt,
    dimensions: PairDimensions,
) -> Result<ExecutionOffer, EntityKernelError> {
    let base = base_amount_from_lots(dimensions.base_token_decimals, original_lots);
    let quote = quote_amount(dimensions, &base, resting_price);
    let side = side_for(snapshot.give_token_id, snapshot.want_token_id);
    let (give, want) = match side {
        Side::Ask => (base, quote),
        Side::Bid => (quote, base),
    };
    let (max_fee, min_net_receive) = requantized_authorization(snapshot, &give, &want)?;
    Ok(ExecutionOffer {
        give_token_id: snapshot.give_token_id,
        give_token_decimals: snapshot.give_token_decimals,
        give_amount: give.clone(),
        want_token_id: snapshot.want_token_id,
        want_token_decimals: snapshot.want_token_decimals,
        want_amount: want.clone(),
        max_fee,
        min_net_receive,
        price_ticks: resting_price.clone(),
        quantized_give: give,
        quantized_want: want,
    })
}

fn fill_authorization(
    offer: &ExecutionOffer,
    filled_give: &BigInt,
    filled_want: &BigInt,
    closes: bool,
) -> (BigInt, BigInt) {
    let mut numerator = filled_give.clone();
    let mut denominator = offer.give_amount.clone();
    if closes {
        let capped = filled_want.clone().min(offer.want_amount.clone());
        if &capped * &denominator > &numerator * &offer.want_amount {
            numerator = capped;
            denominator = offer.want_amount.clone();
        }
    }
    (
        &offer.max_fee * &numerator / &denominator,
        ceil_div(&offer.min_net_receive * numerator, &denominator),
    )
}

fn policy_fee(
    offer: &ExecutionOffer,
    give: &BigInt,
    want: &BigInt,
    bps: u16,
    closes: bool,
) -> BigInt {
    let policy = ExecutionOffer {
        max_fee: &offer.want_amount * BigInt::from(bps) / BigInt::from(10_000_u32),
        min_net_receive: &offer.want_amount
            - (&offer.want_amount * BigInt::from(bps) / BigInt::from(10_000_u32)),
        ..offer.clone()
    };
    fill_authorization(&policy, give, want, closes).0
}

fn assert_authorized(
    offer: &ExecutionOffer,
    filled_give: &BigInt,
    filled_want: &BigInt,
    fee: &BigInt,
    closes: bool,
) -> Result<(), EntityKernelError> {
    if !authorization_valid(offer)
        || filled_give < &BigInt::from(0)
        || filled_give > &offer.give_amount
    {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_FILL_GIVE_INVALID",
        });
    }
    if filled_want < &BigInt::from(0)
        || fee < &BigInt::from(0)
        || fee > filled_want
        || (filled_want > &BigInt::from(0) && fee >= filled_want)
    {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_FILL_WANT_INVALID",
        });
    }
    let allowed = fill_authorization(offer, filled_give, filled_want, closes);
    if fee > &allowed.0 {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_MAX_FEE_EXCEEDED",
        });
    }
    if filled_want - fee < allowed.1 {
        return Err(EntityKernelError::SwapRejected {
            code: "SWAP_NET_AUTH_MIN_RECEIVE_NOT_MET",
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_plan(
    order_id: &str,
    fill: &FillAggregate,
    current_order_id: &str,
    current: &SameJOffer,
    offers: &BTreeMap<(String, String), SameJOffer>,
    batch: &BTreeMap<String, SameJOffer>,
    book: &BookState,
    dimensions: PairDimensions,
    taker_fee_bps: u16,
    resolve_comment: Option<&str>,
) -> Result<ResolvePlan, EntityKernelError> {
    let (account_id, offer_id) = split_order_id(order_id)?;
    if fill.filled_lots <= BigInt::from(0) || fill.weighted_cost <= BigInt::from(0) {
        return Err(EntityKernelError::orderbook("ORDERBOOK_FILL_LOOKUP_FAILED"));
    }
    let current_taker = order_id == current_order_id;
    if !current_taker && &fill.weighted_cost % &fill.filled_lots != BigInt::from(0) {
        return Err(EntityKernelError::orderbook("ORDERBOOK_FILL_LOOKUP_FAILED"));
    }
    let resting_price = &fill.weighted_cost / &fill.filled_lots;
    let execution = if current_taker {
        current_execution_offer(current)
    } else {
        let source = batch
            .get(order_id)
            .or_else(|| offers.get(&(account_id.clone(), offer_id.clone())))
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_FILL_SOURCE_MISSING"))?;
        resting_execution_offer(source, &resting_price, &fill.original_lots, dimensions)?
    };
    let base = base_amount_from_lots(dimensions.base_token_decimals, &fill.filled_lots);
    let quote = quote_amount_from_weighted_lots(dimensions, &fill.weighted_cost);
    let (execution_give, execution_want) =
        match side_for(execution.give_token_id, execution.want_token_id) {
            Side::Bid => (quote, base),
            Side::Ask => (base, quote),
        };
    let closes = !book.orders.contains_key(order_id);
    let (numerator, denominator) =
        reduced_ratio(execution_give.clone(), execution.quantized_give.clone());
    let fill_ratio = ratio_u16(&numerator, &denominator);
    let fee = current_taker
        .then(|| {
            policy_fee(
                &execution,
                &execution_give,
                &execution_want,
                taker_fee_bps,
                closes,
            )
        })
        .filter(|value| value > &BigInt::from(0));
    let zero_fee = BigInt::from(0);
    assert_authorized(
        &execution,
        &execution_give,
        &execution_want,
        fee.as_ref().unwrap_or(&zero_fee),
        closes,
    )?;
    Ok(ResolvePlan {
        account_id,
        offer_id: offer_id.clone(),
        tx: AccountTx::SwapResolve {
            offer_id,
            fill_ratio,
            fill_numerator: Some(numerator),
            fill_denominator: Some(denominator),
            cancel_remainder: closes,
            comment: current_taker
                .then(|| resolve_comment.map(str::to_string))
                .flatten(),
            fee_token_id: fee.as_ref().map(|_| execution.want_token_id),
            fee_amount: fee,
            execution_give_amount: Some(execution_give),
            execution_want_amount: Some(execution_want),
            resting_give_token_id: Some(execution.give_token_id),
            resting_want_token_id: Some(execution.want_token_id),
            resting_price_ticks: Some(execution.price_ticks),
            resting_give_amount: Some(execution.give_amount),
            resting_want_amount: Some(execution.want_amount),
            resting_quantized_give: Some(execution.quantized_give),
            resting_quantized_want: Some(execution.quantized_want),
        },
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_resolve_plans(
    events: &[BookEvent],
    current_order_id: &str,
    current: &SameJOffer,
    offers: &BTreeMap<(String, String), SameJOffer>,
    batch: &BTreeMap<String, SameJOffer>,
    book: &BookState,
    dimensions: PairDimensions,
    taker_fee_bps: u16,
) -> Result<Vec<ResolvePlan>, EntityKernelError> {
    let comment = events.iter().find_map(|event| match event {
        BookEvent::Reject {
            reason: "STP cancel taker",
            blocking_order_id: Some(id),
        } => Some(format!("STP:{id}")),
        _ => None,
    });
    aggregate_fills(events)
        .iter()
        .map(|(order_id, fill)| {
            build_plan(
                order_id,
                fill,
                current_order_id,
                current,
                offers,
                batch,
                book,
                dimensions,
                taker_fee_bps,
                comment.as_deref(),
            )
        })
        .collect()
}
