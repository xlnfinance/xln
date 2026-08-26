use num_bigint::BigInt;

use crate::EntityKernelError;

use super::{PairDimensions, Side};

pub(crate) const PRICE_SCALE: u64 = 10_000;
pub(crate) const MAX_FILL_RATIO: u32 = 65_535;

pub(crate) fn canonical_pair(give: u32, want: u32) -> (u32, u32, String) {
    let pair_id = format!("{}/{}", give.min(want), give.max(want));
    let give_liquid = give == 1 || give == 3;
    let want_liquid = want == 1 || want == 3;
    if give_liquid && !want_liquid {
        (want, give, pair_id)
    } else if !give_liquid && want_liquid {
        (give, want, pair_id)
    } else {
        (give.min(want), give.max(want), pair_id)
    }
}

pub(crate) fn side_for(give: u32, want: u32) -> Side {
    let (base, quote, _) = canonical_pair(give, want);
    if give == base && want == quote {
        Side::Ask
    } else {
        Side::Bid
    }
}

pub(crate) fn pair_dimensions(
    side: Side,
    give_decimals: u32,
    want_decimals: u32,
) -> PairDimensions {
    match side {
        Side::Ask => PairDimensions {
            base_token_decimals: give_decimals,
            quote_token_decimals: want_decimals,
        },
        Side::Bid => PairDimensions {
            base_token_decimals: want_decimals,
            quote_token_decimals: give_decimals,
        },
    }
}

pub(crate) fn ten_pow(decimals: u32) -> BigInt {
    BigInt::from(10_u8).pow(decimals)
}

pub(crate) fn lot_scale(decimals: u32) -> BigInt {
    ten_pow(decimals.saturating_sub(6))
}

fn gcd(mut left: BigInt, mut right: BigInt) -> BigInt {
    while right != BigInt::from(0) {
        let next = &left % &right;
        left = right;
        right = next;
    }
    left
}

pub(crate) fn exact_quote_lot_multiple(
    dimensions: PairDimensions,
    price_ticks: &BigInt,
) -> Result<BigInt, EntityKernelError> {
    if price_ticks <= &BigInt::from(0) {
        return Err(EntityKernelError::orderbook(
            "SWAP_EXACT_QUOTE_PRICE_INVALID",
        ));
    }
    let numerator = lot_scale(dimensions.base_token_decimals)
        * price_ticks
        * ten_pow(dimensions.quote_token_decimals);
    let denominator = BigInt::from(PRICE_SCALE) * ten_pow(dimensions.base_token_decimals);
    Ok(&denominator / gcd(numerator, denominator.clone()))
}

pub(crate) fn base_amount_from_lots(decimals: u32, lots: &BigInt) -> BigInt {
    if lots <= &BigInt::from(0) {
        BigInt::from(0)
    } else {
        lots * lot_scale(decimals)
    }
}

pub(crate) fn quote_amount_from_weighted_lots(
    dimensions: PairDimensions,
    weighted_price_ticks: &BigInt,
) -> BigInt {
    let base = lot_scale(dimensions.base_token_decimals);
    quote_amount(dimensions, &base, weighted_price_ticks)
}

pub(crate) fn quote_amount(
    dimensions: PairDimensions,
    base_amount: &BigInt,
    price_ticks: &BigInt,
) -> BigInt {
    if base_amount <= &BigInt::from(0) || price_ticks <= &BigInt::from(0) {
        return BigInt::from(0);
    }
    base_amount * price_ticks * ten_pow(dimensions.quote_token_decimals)
        / (BigInt::from(PRICE_SCALE) * ten_pow(dimensions.base_token_decimals))
}

pub(crate) fn reduced_ratio(numerator: BigInt, denominator: BigInt) -> (BigInt, BigInt) {
    if numerator <= BigInt::from(0) {
        return (BigInt::from(0), BigInt::from(1));
    }
    if numerator >= denominator {
        return (BigInt::from(1), BigInt::from(1));
    }
    let divisor = gcd(numerator.clone(), denominator.clone());
    (numerator / &divisor, denominator / divisor)
}

pub(crate) fn ratio_u16(numerator: &BigInt, denominator: &BigInt) -> u32 {
    if numerator <= &BigInt::from(0) {
        return 0;
    }
    if numerator >= denominator {
        return MAX_FILL_RATIO;
    }
    let scaled = numerator * BigInt::from(MAX_FILL_RATIO);
    let rounded = (&scaled + denominator - BigInt::from(1)) / denominator;
    rounded.to_u32_digits().1.first().copied().unwrap_or(0)
}

pub(crate) fn ceil_div(numerator: BigInt, denominator: &BigInt) -> BigInt {
    (numerator + denominator - BigInt::from(1)) / denominator
}
