//! Parity target: `core/account/tx/handlers/swap/resolve/validation.ts`.
//!
//! Immutable maker terms first, then the execution fill, then the economics:
//! the resolving counterparty may never pick the price its own claim is
//! checked against.

use num_bigint::BigInt;

use super::types::{ExecutionFill, SwapResolveTx, ValidatedSwapResolve};
use crate::Side;
use crate::error::ValidationRejection;
use crate::state::AccountState;
use crate::swap::fill_ratio::{
    MAX_SWAP_FILL_RATIO, derive_exact_fill_ratio, exact_fill_ratio_to_uint16,
};
use crate::swap::net_authorization::{SwapNetAuthorization, assert_fill_authorization};
use crate::swap::offer::SwapOffer;

const MAX_PAYMENT_AMOUNT_BITS: u32 = 128;

fn rejected(code: &'static str) -> ValidationRejection {
    ValidationRejection::SwapResolve { code }
}

struct CanonicalOffer {
    offer: SwapOffer,
    quantized_give: BigInt,
    quantized_want: BigInt,
    price_ticks: BigInt,
}

fn resolve_canonical_offer(
    state: &AccountState,
    tx: &SwapResolveTx<'_>,
    proposer: Side,
) -> Result<CanonicalOffer, ValidationRejection> {
    let Some(offer) = state.swap_offer(tx.offer_id) else {
        return Err(ValidationRejection::SwapOfferNotFound {
            offer_id: tx.offer_id.to_owned(),
        });
    };
    let canonical = CanonicalOffer {
        quantized_give: offer.quantized_give().clone(),
        quantized_want: offer.quantized_want().clone(),
        price_ticks: offer.price_ticks().clone(),
        offer: offer.clone(),
    };
    let mismatch = |declared: &Option<BigInt>, canonical: &BigInt| {
        declared.as_ref().is_some_and(|value| value != canonical)
    };
    if mismatch(&tx.resting_give_amount, canonical.offer.give_amount())
        || mismatch(&tx.resting_want_amount, canonical.offer.want_amount())
        || mismatch(&tx.resting_quantized_give, &canonical.quantized_give)
        || mismatch(&tx.resting_quantized_want, &canonical.quantized_want)
        || mismatch(&tx.resting_price_ticks, &canonical.price_ticks)
    {
        return Err(rejected("SWAP_RESOLVE_RESTING_TERMS_MISMATCH"));
    }
    let zero = BigInt::from(0);
    if canonical.offer.give_amount() <= &zero || canonical.offer.want_amount() <= &zero {
        return Err(rejected("SWAP_RESOLVE_OFFER_AMOUNTS_NOT_POSITIVE"));
    }
    if canonical.quantized_give <= zero || canonical.quantized_want <= zero {
        return Err(rejected("SWAP_RESOLVE_QUANTIZED_NOT_POSITIVE"));
    }
    if &canonical.quantized_give > canonical.offer.give_amount()
        || &canonical.quantized_want > canonical.offer.want_amount()
    {
        return Err(rejected("SWAP_RESOLVE_QUANTIZED_EXCEEDS_OFFER"));
    }
    if (proposer == Side::Left) == canonical.offer.maker_is_left() {
        return Err(rejected("SWAP_RESOLVE_ONLY_COUNTERPARTY"));
    }
    Ok(canonical)
}

fn derive_execution_fill(
    tx: &SwapResolveTx<'_>,
    canonical: &CanonicalOffer,
) -> Result<ExecutionFill, ValidationRejection> {
    if tx.fill_ratio > MAX_SWAP_FILL_RATIO {
        return Err(rejected("SWAP_RESOLVE_FILL_RATIO_INVALID"));
    }
    let execution_provided =
        tx.execution_give_amount.is_some() || tx.execution_want_amount.is_some();
    if execution_provided
        && (tx.execution_give_amount.is_none() || tx.execution_want_amount.is_none())
    {
        return Err(rejected("SWAP_RESOLVE_EXECUTION_AMOUNTS_INCOMPLETE"));
    }
    if tx.fill_ratio > 0 && !execution_provided {
        return Err(rejected("SWAP_RESOLVE_EXECUTION_AMOUNTS_REQUIRED"));
    }
    let limit_filled_give = (&canonical.quantized_give * BigInt::from(tx.fill_ratio))
        / BigInt::from(MAX_SWAP_FILL_RATIO);
    let limit_filled_want =
        (&limit_filled_give * &canonical.quantized_want + &canonical.quantized_give - 1)
            / &canonical.quantized_give;
    let filled_give = tx
        .execution_give_amount
        .clone()
        .unwrap_or(limit_filled_give);
    let filled_want = tx
        .execution_want_amount
        .clone()
        .unwrap_or(limit_filled_want);
    let canonical_fill_ratio = if execution_provided {
        exact_fill_ratio_to_uint16(&derive_exact_fill_ratio(
            &canonical.quantized_give,
            &filled_give,
        ))
    } else {
        tx.fill_ratio
    };
    let exact_ratio_provided = tx.fill_numerator.is_some() || tx.fill_denominator.is_some();
    if exact_ratio_provided && (tx.fill_numerator.is_none() || tx.fill_denominator.is_none()) {
        return Err(rejected("SWAP_RESOLVE_EXACT_RATIO_INCOMPLETE"));
    }
    if exact_ratio_provided {
        let numerator = tx.fill_numerator.as_ref().expect("checked above");
        let denominator = tx.fill_denominator.as_ref().expect("checked above");
        let zero = BigInt::from(0);
        if denominator <= &zero || numerator < &zero || numerator > denominator {
            return Err(rejected("SWAP_RESOLVE_EXACT_RATIO_OUT_OF_RANGE"));
        }
        if numerator * &canonical.quantized_give != &filled_give * denominator {
            return Err(rejected("SWAP_RESOLVE_EXACT_RATIO_MISMATCH"));
        }
    }
    Ok(ExecutionFill {
        filled_give,
        filled_want,
        canonical_fill_ratio,
        execution_provided,
    })
}

fn validate_fee_authorization(
    tx: &SwapResolveTx<'_>,
    canonical: &CanonicalOffer,
    fill: &ExecutionFill,
) -> Result<(), ValidationRejection> {
    let zero = BigInt::from(0);
    let fee_amount = tx.fee_amount.clone().unwrap_or_else(|| zero.clone());
    let fee_token_id = tx.fee_token_id.unwrap_or(canonical.offer.want_token_id());
    if fee_amount < zero {
        return Err(rejected("SWAP_RESOLVE_FEE_NEGATIVE"));
    }
    if fee_amount > zero && fill.filled_give <= zero {
        return Err(rejected("SWAP_RESOLVE_FEE_WITHOUT_FILL"));
    }
    if fee_amount > zero && fee_token_id != canonical.offer.want_token_id() {
        return Err(rejected("SWAP_RESOLVE_FEE_TOKEN_MISMATCH"));
    }
    if fee_amount >= fill.filled_want && fill.filled_want > zero {
        return Err(rejected("SWAP_RESOLVE_FEE_EXCEEDS_FILL"));
    }
    assert_fill_authorization(
        canonical.offer.give_amount(),
        canonical.offer.want_amount(),
        &SwapNetAuthorization {
            max_fee: canonical.offer.max_fee().clone(),
            min_net_receive: canonical.offer.min_net_receive().clone(),
        },
        &fill.filled_give,
        &fill.filled_want,
        &fee_amount,
        tx.cancel_remainder,
    )
    .map_err(|error| ValidationRejection::SwapNetAuthorization { code: error.code() })
}

fn validate_execution_economics(
    tx: &SwapResolveTx<'_>,
    canonical: &CanonicalOffer,
    fill: &ExecutionFill,
) -> Result<(), ValidationRejection> {
    validate_fee_authorization(tx, canonical, fill)?;
    let zero = BigInt::from(0);
    if fill.execution_provided {
        let has_fill = fill.filled_give > zero || fill.filled_want > zero;
        if has_fill && (fill.filled_give <= zero || fill.filled_want <= zero) {
            return Err(rejected("SWAP_RESOLVE_EXECUTION_AMOUNTS_NOT_POSITIVE"));
        }
        if tx.fill_ratio != fill.canonical_fill_ratio {
            return Err(rejected("SWAP_RESOLVE_FILL_RATIO_NOT_CANONICAL"));
        }
        if has_fill {
            if fill.filled_give > canonical.quantized_give {
                return Err(rejected("SWAP_RESOLVE_FILL_EXCEEDS_OFFER"));
            }
            if &fill.filled_want * &canonical.quantized_give
                < &fill.filled_give * &canonical.quantized_want
            {
                return Err(rejected("SWAP_RESOLVE_MAKER_LIMIT_PRICE"));
            }
        }
    }
    validate_filled_amount_bounds(fill)
}

fn validate_filled_amount_bounds(fill: &ExecutionFill) -> Result<(), ValidationRejection> {
    if fill.canonical_fill_ratio == 0 {
        return Ok(());
    }
    let minimum = BigInt::from(1);
    let maximum = (BigInt::from(1) << MAX_PAYMENT_AMOUNT_BITS) - 1;
    if fill.filled_give < minimum || fill.filled_give > maximum {
        return Err(rejected("SWAP_RESOLVE_FILLED_GIVE_OUT_OF_BOUNDS"));
    }
    if fill.filled_want < minimum || fill.filled_want > maximum {
        return Err(rejected("SWAP_RESOLVE_FILLED_WANT_OUT_OF_BOUNDS"));
    }
    Ok(())
}

pub(crate) fn validate_swap_resolve(
    state: &AccountState,
    tx: &SwapResolveTx<'_>,
    proposer: Side,
) -> Result<ValidatedSwapResolve, ValidationRejection> {
    let canonical = resolve_canonical_offer(state, tx, proposer)?;
    let fill = derive_execution_fill(tx, &canonical)?;
    validate_execution_economics(tx, &canonical, &fill)?;
    Ok(ValidatedSwapResolve {
        effective_fee_token_id: tx.fee_token_id.unwrap_or(canonical.offer.want_token_id()),
        fee_amount: tx.fee_amount.clone().unwrap_or_else(|| BigInt::from(0)),
        effective_cancel_remainder: tx.cancel_remainder || tx.fill_ratio == 0,
        canonical_quantized_give: canonical.quantized_give,
        canonical_quantized_want: canonical.quantized_want,
        canonical_price_ticks: canonical.price_ticks,
        offer: canonical.offer,
        filled_give: fill.filled_give,
        filled_want: fill.filled_want,
        canonical_fill_ratio: fill.canonical_fill_ratio,
    })
}
