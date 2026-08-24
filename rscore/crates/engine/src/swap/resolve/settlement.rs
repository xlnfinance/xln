//! Parity target: `core/account/tx/handlers/swap/resolve/settlement.ts`.
//!
//! Both token legs and the maker hold move together on the candidate: holds
//! and offdeltas are hashed Account state, so validation and commit run this
//! same mutation.

use num_bigint::BigInt;

use super::types::{AppliedSwapResolve, ValidatedSwapResolve};
use crate::error::ValidationRejection;
use crate::{AccountReplica, Delta, Side, TokenId, TransitionError};

fn rejected(code: &'static str) -> ValidationRejection {
    ValidationRejection::SwapResolve { code }
}

/// The counterparty pays the want leg, so its own out capacity bounds the fill.
fn validate_counterparty_capacity(
    want_delta: &Delta,
    resolve: &ValidatedSwapResolve,
) -> Result<(), ValidationRejection> {
    if resolve.filled_want <= BigInt::from(0) {
        return Ok(());
    }
    let taker = if resolve.offer.maker_is_left() {
        Side::Right
    } else {
        Side::Left
    };
    if resolve.filled_want > want_delta.perspective(taker).out_capacity {
        return Err(rejected("SWAP_RESOLVE_COUNTERPARTY_CAPACITY"));
    }
    Ok(())
}

pub(crate) struct SettledLegs {
    pub give_delta: Delta,
    pub want_delta: Delta,
    pub applied: AppliedSwapResolve,
    pub events: Vec<String>,
}

pub(crate) fn apply_swap_resolve_financials(
    replica: &AccountReplica,
    resolve: ValidatedSwapResolve,
) -> Result<Result<SettledLegs, ValidationRejection>, TransitionError> {
    let give_token = TokenId::new(resolve.offer.give_token_id())?;
    let want_token = TokenId::new(resolve.offer.want_token_id())?;
    let mut give_delta = replica.state().delta_or_zero(give_token)?;
    let mut want_delta = replica.state().delta_or_zero(want_token)?;
    if let Err(rejection) = validate_counterparty_capacity(&want_delta, &resolve) {
        return Ok(Err(rejection));
    }
    let maker_hold_side = if resolve.offer.maker_is_left() {
        Side::Left
    } else {
        Side::Right
    };
    if give_delta.hold(maker_hold_side) < &resolve.canonical_quantized_give {
        return Ok(Err(rejected("SWAP_RESOLVE_HOLD_UNDERFLOW")));
    }
    let mut events = Vec::new();
    let zero = BigInt::from(0);
    if resolve.filled_give > zero {
        // The maker sends give, the taker sends want.
        give_delta.apply_transfer(maker_hold_side, &resolve.filled_give)?;
        want_delta.apply_transfer(maker_hold_side.opposite(), &resolve.filled_want)?;
        events.push(format!(
            "💱 Swap filled: {} token{} for {} token{}",
            resolve.filled_give,
            resolve.offer.give_token_id(),
            resolve.filled_want,
            resolve.offer.want_token_id(),
        ));
    }
    if resolve.fee_amount > zero {
        // The fee moves on the want leg from the maker to the taker.
        want_delta.apply_transfer(maker_hold_side, &resolve.fee_amount)?;
        events.push(format!(
            "💸 Swap taker fee: {} token{}",
            resolve.fee_amount, resolve.effective_fee_token_id,
        ));
    }
    if give_delta.hold(maker_hold_side) < &resolve.filled_give {
        return Ok(Err(rejected("SWAP_RESOLVE_HOLD_UNDERFLOW")));
    }
    give_delta.release_hold(maker_hold_side, &resolve.filled_give)?;
    Ok(Ok(SettledLegs {
        give_delta,
        want_delta,
        applied: AppliedSwapResolve {
            resolve,
            maker_hold_side,
        },
        events,
    }))
}
