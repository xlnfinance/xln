//! Canonical swap fill ratios and settlement movements.
//!
//! Parity target: `core/orderbook/swap-execution.ts`. The coarse uint16 ratio
//! is the on-chain dispute form; the exact ratio is the reduced fraction the
//! Account frame is checked against.

use num_bigint::BigInt;
use num_integer::Integer;

pub const MAX_SWAP_FILL_RATIO: u32 = 65_535;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactFillRatio {
    pub numerator: BigInt,
    pub denominator: BigInt,
}

fn reduce(numerator: &BigInt, denominator: &BigInt) -> ExactFillRatio {
    let zero = BigInt::from(0);
    let bounded = if numerator <= &zero {
        zero.clone()
    } else if numerator >= denominator {
        denominator.clone()
    } else {
        numerator.clone()
    };
    if bounded == zero {
        return ExactFillRatio {
            numerator: zero,
            denominator: BigInt::from(1),
        };
    }
    if &bounded == denominator {
        return ExactFillRatio {
            numerator: BigInt::from(1),
            denominator: BigInt::from(1),
        };
    }
    let divisor = bounded.gcd(denominator);
    ExactFillRatio {
        numerator: bounded / &divisor,
        denominator: denominator / &divisor,
    }
}

/// Zero (0/1) whenever either side is non-positive, exactly as TypeScript.
pub fn derive_exact_fill_ratio(effective_give: &BigInt, filled_give: &BigInt) -> ExactFillRatio {
    let zero = BigInt::from(0);
    if effective_give <= &zero || filled_give <= &zero {
        return ExactFillRatio {
            numerator: zero,
            denominator: BigInt::from(1),
        };
    }
    reduce(filled_give, effective_give)
}

/// Smallest uint16 whose implied floor share still covers the exact ratio.
pub fn exact_fill_ratio_to_uint16(ratio: &ExactFillRatio) -> u32 {
    let zero = BigInt::from(0);
    if ratio.numerator <= zero {
        return 0;
    }
    if ratio.numerator >= ratio.denominator {
        return MAX_SWAP_FILL_RATIO;
    }
    let max = BigInt::from(MAX_SWAP_FILL_RATIO);
    let ceil = (&ratio.numerator * &max + &ratio.denominator - 1) / &ratio.denominator;
    let mut coarse = u32::try_from(ceil).unwrap_or(MAX_SWAP_FILL_RATIO);
    coarse = coarse.min(MAX_SWAP_FILL_RATIO);
    while coarse > 0 && (&ratio.denominator * BigInt::from(coarse - 1)) / &max >= ratio.numerator {
        coarse -= 1;
    }
    while coarse < MAX_SWAP_FILL_RATIO
        && (&ratio.denominator * BigInt::from(coarse)) / &max < ratio.numerator
    {
        coarse += 1;
    }
    coarse
}
