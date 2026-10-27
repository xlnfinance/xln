use super::book::{AddOrder, MatchAdmission};
use super::math::{base_amount_from_lots, pair_dimensions, quote_amount_from_weighted_lots};
use super::{BookOrder, SameJOffer, Side};
use crate::EntityKernelError;
use num_bigint::BigInt;
use std::collections::BTreeMap;

/// Transient post-inbound Account projection. Missing tokens have zero capacity.
pub type OrderbookCapacity = BTreeMap<(String, u32), BigInt>;

pub(crate) fn admit_match(
    offers: &BTreeMap<(String, String), SameJOffer>,
    capacity: &OrderbookCapacity,
    consumed: &mut OrderbookCapacity,
    maker: &BookOrder,
    taker: &AddOrder,
    price: &BigInt,
    qty: &BigInt,
) -> Result<MatchAdmission, EntityKernelError> {
    let leg = |id: &str, side: Side| {
        let (account, offer_id) = id
            .rsplit_once(':')
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_MALFORMED_BOOK_ORDER"))?;
        let offer = offers
            .get(&(account.into(), offer_id.into()))
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_SAME_SNAPSHOT_MISSING"))?;
        let dimensions =
            pair_dimensions(side, offer.give_token_decimals, offer.want_token_decimals);
        let amount = if side == Side::Ask {
            quote_amount_from_weighted_lots(dimensions, &(price * qty))
        } else {
            base_amount_from_lots(dimensions.base_token_decimals, qty)
        };
        Ok::<_, EntityKernelError>(((account.to_string(), offer.want_token_id), amount))
    };
    let maker_leg = leg(&maker.order_id, maker.side)?;
    let taker_leg = leg(&taker.order_id, taker.side)?;
    let affordable = |(key, amount): &((String, u32), BigInt)| {
        capacity.get(key).is_some_and(|available| {
            available - consumed.get(key).cloned().unwrap_or_default() >= *amount
        })
    };
    if !affordable(&maker_leg) {
        return Ok(MatchAdmission::CancelMaker);
    }
    if !affordable(&taker_leg) {
        return Ok(MatchAdmission::CancelTaker);
    }
    // Reserve only after both legs pass; never emit a one-sided fill.
    for (key, amount) in [maker_leg, taker_leg] {
        *consumed.entry(key).or_default() += amount;
    }
    Ok(MatchAdmission::Fill)
}
