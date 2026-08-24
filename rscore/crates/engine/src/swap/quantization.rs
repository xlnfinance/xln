//! Deterministic swap-order quantization.
//!
//! Byte-for-byte the same arithmetic as the canonical TypeScript orderbook
//! (`core/orderbook/types.ts`): lot-aligned base amounts, price in
//! ORDERBOOK_PRICE_SCALE ticks with side-dependent rounding, and a quote amount
//! recomputed at that price so both legs agree on one integer.

use num_bigint::BigInt;
use num_integer::Integer;

use super::market::{ORDERBOOK_PRICE_SCALE, SwapMarketPolicy, lot_scale, token_scale};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedSwapOrder {
    pub price_ticks: BigInt,
    pub effective_give: BigInt,
    pub effective_want: BigInt,
}

fn price_scale() -> BigInt {
    BigInt::from(ORDERBOOK_PRICE_SCALE)
}

/// One directed base/quote leg: the canonical pair together with the registry
/// decimals it is priced with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseQuoteLeg {
    pub base_token_id: u32,
    pub quote_token_id: u32,
    pub base_decimals: u32,
    pub quote_decimals: u32,
}

/// Rounds up when selling base (never sell cheaper than asked) and down when
/// buying it (never pay more), then aligns to the pair's step.
pub fn price_ticks_for_base_quote(
    policy: &SwapMarketPolicy,
    side: u8,
    leg: BaseQuoteLeg,
    raw_base_amount: &BigInt,
    raw_quote_amount: &BigInt,
) -> BigInt {
    let BaseQuoteLeg {
        base_token_id,
        quote_token_id,
        base_decimals,
        quote_decimals,
    } = leg;
    let zero = BigInt::from(0);
    if raw_base_amount <= &zero || raw_quote_amount <= &zero {
        return zero;
    }
    let step = BigInt::from(policy.price_step_ticks(
        base_token_id,
        quote_token_id,
        base_decimals,
        quote_decimals,
    ));
    let numerator = raw_quote_amount * token_scale(base_decimals) * price_scale();
    let denominator = raw_base_amount * token_scale(quote_decimals);
    let (mut ticks, remainder) = numerator.div_rem(&denominator);
    if side == 1 {
        if remainder > zero {
            ticks += 1;
        }
        ticks = ((&ticks + &step - 1) / &step) * &step;
    } else {
        ticks = (&ticks / &step) * &step;
    }
    if ticks > zero { ticks } else { zero }
}

pub fn quote_amount_at_price(
    base_decimals: u32,
    quote_decimals: u32,
    base_amount: &BigInt,
    price_ticks: &BigInt,
) -> BigInt {
    let zero = BigInt::from(0);
    if base_amount <= &zero || price_ticks <= &zero {
        return zero;
    }
    (base_amount * price_ticks * token_scale(quote_decimals))
        / (price_scale() * token_scale(base_decimals))
}

/// Smallest lot multiple whose quote amount is integral at this price, so both
/// legs settle on one exact integer instead of a per-side rounding choice.
fn exact_quote_lot_multiple(
    base_decimals: u32,
    quote_decimals: u32,
    price_ticks: &BigInt,
) -> Option<BigInt> {
    if price_ticks <= &BigInt::from(0) {
        return None;
    }
    let numerator_per_lot = lot_scale(base_decimals) * price_ticks * token_scale(quote_decimals);
    let denominator = price_scale() * token_scale(base_decimals);
    Some(&denominator / numerator_per_lot.gcd(&denominator))
}

/// Canonical preparation, or None when the order cannot survive quantization.
pub fn prepare_swap_order(
    policy: &SwapMarketPolicy,
    give_token_id: u32,
    want_token_id: u32,
    give_amount: &BigInt,
    want_amount: &BigInt,
    give_decimals: u32,
    want_decimals: u32,
) -> Option<PreparedSwapOrder> {
    let zero = BigInt::from(0);
    if give_amount <= &zero || want_amount <= &zero {
        return None;
    }
    let side = policy.derive_side(give_token_id, want_token_id);
    let raw_base = if side == 1 { give_amount } else { want_amount };
    let raw_quote = if side == 1 { want_amount } else { give_amount };
    let (base_token_id, quote_token_id) = policy.canonical_pair(give_token_id, want_token_id);
    let (base_decimals, quote_decimals) = if side == 1 {
        (give_decimals, want_decimals)
    } else {
        (want_decimals, give_decimals)
    };
    let lot = lot_scale(base_decimals);
    if raw_base < &lot || raw_quote <= &zero {
        return None;
    }
    let price_ticks = price_ticks_for_base_quote(
        policy,
        side,
        BaseQuoteLeg {
            base_token_id,
            quote_token_id,
            base_decimals,
            quote_decimals,
        },
        raw_base,
        raw_quote,
    );
    if price_ticks <= zero {
        return None;
    }
    let exact_lots = exact_quote_lot_multiple(base_decimals, quote_decimals, &price_ticks)?;
    let execution_lot = lot * exact_lots;
    let quantized_base = (raw_base / &execution_lot) * &execution_lot;
    if quantized_base <= zero {
        return None;
    }
    let quantized_quote =
        quote_amount_at_price(base_decimals, quote_decimals, &quantized_base, &price_ticks);
    if quantized_quote <= zero {
        return None;
    }
    let (effective_give, effective_want) = if side == 1 {
        (quantized_base, quantized_quote)
    } else {
        (quantized_quote, quantized_base)
    };
    Some(PreparedSwapOrder {
        price_ticks,
        effective_give,
        effective_want,
    })
}
