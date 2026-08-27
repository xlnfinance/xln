use num_bigint::BigInt;

use super::{PairDimensions, PairPolicy};

pub fn is_canonical_liquid_token(token_id: u32) -> bool {
    matches!(token_id, 1 | 3)
}

pub fn canonical_token_decimals(token_id: u32) -> Option<u32> {
    match token_id {
        1 | 3 | 4 => Some(6),
        2 | 5 => Some(18),
        _ => None,
    }
}

pub fn canonical_pair_orientation(left: u32, right: u32) -> (u32, u32) {
    match (
        is_canonical_liquid_token(left),
        is_canonical_liquid_token(right),
    ) {
        (true, false) => (right, left),
        (false, true) => (left, right),
        _ => (left, right),
    }
}

/// Exact Rust calque of TypeScript `getSwapPairPolicyForDimensions` plus
/// `hasSwapPairPolicyForDimensions`. Token ids alone never authorize a static
/// price anchor: their signed decimal dimensions must also match the registry.
pub fn canonical_pair_policy(
    base: u32,
    quote: u32,
    dimensions: PairDimensions,
) -> (PairPolicy, bool) {
    let explicit = match (base, quote) {
        (2, 1) | (2, 3) => Some((10_000, 25_000_000)),
        (1, 3) => Some((10_000, 10_000)),
        (4, 1) | (4, 3) => Some((100, 1_200)),
        (5, 1) | (5, 3) => Some((10, 200)),
        _ => None,
    }
    .filter(|_| {
        canonical_token_decimals(base) == Some(dimensions.base_token_decimals)
            && canonical_token_decimals(quote) == Some(dimensions.quote_token_decimals)
    });
    let (book_bucket_width_ticks, mid_price_ticks, has_explicit) = explicit
        .map(|(width, mid)| (width, mid, true))
        .unwrap_or((10_000, 10_000, false));
    (
        PairPolicy {
            price_step_ticks: 1,
            book_bucket_width_ticks,
            mid_price_ticks: BigInt::from(mid_price_ticks),
        },
        has_explicit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_anchor_requires_both_builtin_dimensions() {
        let dimensions = PairDimensions {
            base_token_decimals: 18,
            quote_token_decimals: 6,
        };
        let (policy, explicit) = canonical_pair_policy(2, 1, dimensions);
        assert!(explicit);
        assert_eq!(policy.mid_price_ticks, BigInt::from(25_000_000));

        let (policy, explicit) = canonical_pair_policy(
            2,
            1,
            PairDimensions {
                base_token_decimals: 6,
                quote_token_decimals: 6,
            },
        );
        assert!(!explicit);
        assert_eq!(policy.mid_price_ticks, BigInt::from(10_000));
    }
}
