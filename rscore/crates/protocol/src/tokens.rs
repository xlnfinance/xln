//! Canonical built-in token metadata shared by financial admission and projection.
//!
//! Rust twin of `CATALOG_TOKENS` in
//! `core/jurisdiction/machine/config/default-tokens.ts`: decimals, symbol and
//! the committed USD reference rate (integer USD micros per whole token). Every
//! protocol USD amount converts through this rate with the same floor as TS
//! `usdMicrosToTokenAmount`, so both engines derive identical raw amounts.

use num_bigint::BigInt;

pub const USD_MICROS_PER_DOLLAR: u64 = 1_000_000;
/// TS `REBALANCE_BASE_FEE_USD_MICROS` in `core/account/config/defaults.ts`: $0.10.
pub const REBALANCE_BASE_FEE_USD_MICROS: u64 = 100_000;
/// TS `DEFAULT_REBALANCE_POLICY_USD`: soft limit, hard limit, max fee in whole USD.
pub const DEFAULT_REBALANCE_POLICY_USD: (u64, u64, u64) = (500, 10_000, 15);
/// TS `CREDIT_REQUEST_CAP_USD`: largest automatic hub grant per `credit_request`.
pub const CREDIT_REQUEST_CAP_USD: u64 = 1_000;

fn catalog(token_id: u32) -> Option<(u32, &'static str, u64)> {
    match token_id {
        1 => Some((6, "USDC", 1_000_000)),
        2 => Some((18, "WETH", 2_500_000_000)),
        3 => Some((6, "USDT", 1_000_000)),
        4 => Some((6, "TRX", 120_000)),
        5 => Some((18, "SUN", 20_000)),
        _ => None,
    }
}

pub fn canonical_token_metadata(token_id: u32) -> Option<(u32, &'static str)> {
    catalog(token_id).map(|(decimals, symbol, _)| (decimals, symbol))
}

pub fn canonical_token_decimals(token_id: u32) -> Option<u32> {
    catalog(token_id).map(|(decimals, _, _)| decimals)
}

pub fn canonical_token_usd_micros(token_id: u32) -> Option<u64> {
    catalog(token_id).map(|(_, _, usd_micros)| usd_micros)
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum UsdAmountError {
    #[error("TOKEN_USD_RATE_UNAVAILABLE:{0}")]
    RateUnavailable(u32),
    #[error("USD_AMOUNT_NEGATIVE:token={token_id}:usdMicros={usd_micros}")]
    Negative { token_id: u32, usd_micros: BigInt },
    #[error("USD_AMOUNT_UNREPRESENTABLE:token={token_id}:usdMicros={usd_micros}")]
    Unrepresentable { token_id: u32, usd_micros: BigInt },
}

/// Floor of `usd_micros` worth of the token in raw units; a positive USD
/// amount never silently becomes zero. Twin of TS `usdMicrosToTokenAmount`.
pub fn usd_micros_to_token_amount(
    token_id: u32,
    usd_micros: &BigInt,
) -> Result<BigInt, UsdAmountError> {
    let (decimals, _, rate) = catalog(token_id).ok_or(UsdAmountError::RateUnavailable(token_id))?;
    let zero = BigInt::from(0_u8);
    if *usd_micros < zero {
        return Err(UsdAmountError::Negative {
            token_id,
            usd_micros: usd_micros.clone(),
        });
    }
    let amount = usd_micros * BigInt::from(10_u8).pow(decimals) / BigInt::from(rate);
    if *usd_micros > zero && amount == zero {
        return Err(UsdAmountError::Unrepresentable {
            token_id,
            usd_micros: usd_micros.clone(),
        });
    }
    Ok(amount)
}

pub fn whole_usd_to_token_amount(
    token_id: u32,
    dollars: &BigInt,
) -> Result<BigInt, UsdAmountError> {
    usd_micros_to_token_amount(token_id, &(dollars * BigInt::from(USD_MICROS_PER_DOLLAR)))
}

pub fn rebalance_base_fee(token_id: u32) -> Result<BigInt, UsdAmountError> {
    usd_micros_to_token_amount(token_id, &BigInt::from(REBALANCE_BASE_FEE_USD_MICROS))
}

/// Quote per one base in `price_scale` ticks, floored: rate(base) / rate(quote).
pub fn canonical_reference_mid_price_ticks(
    base: u32,
    quote: u32,
    price_scale: u64,
) -> Option<BigInt> {
    let mid = BigInt::from(canonical_token_usd_micros(base)?) * BigInt::from(price_scale)
        / BigInt::from(canonical_token_usd_micros(quote)?);
    (mid > BigInt::from(0_u8)).then_some(mid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_amounts_convert_through_the_reference_rate() {
        // $0.10 base fee, $1,000 credit cap: USDC unchanged, WETH at $2,500.
        assert_eq!(
            usd_micros_to_token_amount(1, &BigInt::from(100_000)),
            Ok(BigInt::from(100_000))
        );
        assert_eq!(
            rebalance_base_fee(2),
            Ok(BigInt::from(40_000_000_000_000_u64))
        );
        assert_eq!(
            whole_usd_to_token_amount(2, &BigInt::from(CREDIT_REQUEST_CAP_USD)),
            Ok(BigInt::from(400_000_000_000_000_000_u64))
        );
        assert_eq!(rebalance_base_fee(4), Ok(BigInt::from(833_333)));
        assert_eq!(
            usd_micros_to_token_amount(1, &BigInt::from(0)),
            Ok(BigInt::from(0))
        );
        assert_eq!(
            usd_micros_to_token_amount(999, &BigInt::from(1)),
            Err(UsdAmountError::RateUnavailable(999))
        );
        assert!(matches!(
            usd_micros_to_token_amount(1, &BigInt::from(-1)),
            Err(UsdAmountError::Negative { .. })
        ));
    }

    #[test]
    fn reference_mid_is_rate_ratio() {
        assert_eq!(
            canonical_reference_mid_price_ticks(2, 1, 10_000),
            Some(BigInt::from(25_000_000))
        );
        assert_eq!(
            canonical_reference_mid_price_ticks(1, 3, 10_000),
            Some(BigInt::from(10_000))
        );
        assert_eq!(
            canonical_reference_mid_price_ticks(4, 1, 10_000),
            Some(BigInt::from(1_200))
        );
        assert_eq!(
            canonical_reference_mid_price_ticks(5, 3, 10_000),
            Some(BigInt::from(200))
        );
        assert_eq!(canonical_reference_mid_price_ticks(9, 1, 10_000), None);
    }
}
