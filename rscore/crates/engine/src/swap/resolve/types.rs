//! Parity target: `core/account/tx/handlers/swap/resolve/types.ts`.

use num_bigint::BigInt;

use crate::Side;
use crate::swap::offer::SwapOffer;

/// The wire form of a swap_resolve, with the optional fields TypeScript marks
/// optional kept optional: absent is not the same as zero for several checks.
pub(crate) struct SwapResolveTx<'a> {
    pub offer_id: &'a str,
    pub fill_ratio: u32,
    pub fill_numerator: Option<BigInt>,
    pub fill_denominator: Option<BigInt>,
    pub cancel_remainder: bool,
    pub fee_token_id: Option<u32>,
    pub fee_amount: Option<BigInt>,
    pub execution_give_amount: Option<BigInt>,
    pub execution_want_amount: Option<BigInt>,
    pub resting_price_ticks: Option<BigInt>,
    pub resting_give_amount: Option<BigInt>,
    pub resting_want_amount: Option<BigInt>,
    pub resting_quantized_give: Option<BigInt>,
    pub resting_quantized_want: Option<BigInt>,
}

pub(crate) struct ValidatedSwapResolve {
    pub offer: SwapOffer,
    pub canonical_quantized_give: BigInt,
    pub canonical_quantized_want: BigInt,
    pub canonical_price_ticks: BigInt,
    pub effective_cancel_remainder: bool,
    pub filled_give: BigInt,
    pub filled_want: BigInt,
    pub canonical_fill_ratio: u32,
    pub effective_fee_token_id: u32,
    pub fee_amount: BigInt,
}

pub(crate) struct AppliedSwapResolve {
    pub resolve: ValidatedSwapResolve,
    pub maker_hold_side: Side,
}

pub(crate) struct ExecutionFill {
    pub filled_give: BigInt,
    pub filled_want: BigInt,
    pub canonical_fill_ratio: u32,
    pub execution_provided: bool,
}
