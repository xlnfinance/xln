//! Parity target: `core/account/tx/handlers/swap/resolve/remainder.ts`.
//!
//! Either the offer closes (cancelled, fully filled, or the remainder fell
//! below one lot) or it is replaced by a requantized resting row. The row is
//! replaced, never mutated: a radix leaf is immutable by identity.

use num_bigint::BigInt;

use super::settlement::SettledLegs;
use crate::error::ValidationRejection;
use crate::swap::fill_ratio::MAX_SWAP_FILL_RATIO;
use crate::swap::market::SwapMarketPolicy;
use crate::swap::net_authorization::{SwapNetAuthorization, requantize};
use crate::swap::offer::SwapOffer;
use crate::swap::quantization::requantize_remaining_base_at_price;
use crate::{AccountOutput, AccountReplica, Side, TransitionError};

fn rejected(code: &'static str) -> ValidationRejection {
    ValidationRejection::SwapResolve { code }
}

pub(crate) struct RemainderOutcome {
    pub events: Vec<String>,
    pub outputs: Vec<AccountOutput>,
}

pub(crate) fn apply_swap_resolve_remainder(
    replica: &mut AccountReplica,
    policy: &SwapMarketPolicy,
    settled: SettledLegs,
) -> Result<Result<RemainderOutcome, ValidationRejection>, TransitionError> {
    let SettledLegs {
        mut give_delta,
        want_delta,
        applied,
        mut events,
    } = settled;
    let resolve = applied.resolve;
    let hold_side = applied.maker_hold_side;
    let remaining_give = &resolve.canonical_quantized_give - &resolve.filled_give;

    let close = |message: &str| -> String {
        format!(
            "📊 Swap offer {}... {}",
            crate::identity::js_prefix(resolve.offer.offer_id(), 8),
            message,
        )
    };

    if resolve.effective_cancel_remainder || resolve.canonical_fill_ratio == MAX_SWAP_FILL_RATIO {
        if let Err(rejection) = release(&mut give_delta, hold_side, &remaining_give) {
            return Ok(Err(rejection));
        }
        events.push(close(
            if resolve.canonical_fill_ratio == MAX_SWAP_FILL_RATIO {
                "fully filled"
            } else {
                "cancelled"
            },
        ));
        return Ok(Ok(close_offer(
            replica,
            give_delta,
            want_delta,
            &resolve.offer,
            events,
        )?));
    }

    let side = policy.derive_side(resolve.offer.give_token_id(), resolve.offer.want_token_id());
    let (canonical_base, filled_base) = if side == 1 {
        (&resolve.canonical_quantized_give, &resolve.filled_give)
    } else {
        (&resolve.canonical_quantized_want, &resolve.filled_want)
    };
    let remaining_base = canonical_base - filled_base;
    let requantized = requantize_remaining_base_at_price(
        policy,
        resolve.offer.give_token_id(),
        resolve.offer.want_token_id(),
        resolve.offer.give_token_decimals(),
        resolve.offer.want_token_decimals(),
        &remaining_base,
        &resolve.canonical_price_ticks,
    );
    let Some(requantized) = requantized else {
        if let Err(rejection) = release(&mut give_delta, hold_side, &remaining_give) {
            return Ok(Err(rejection));
        }
        events.push(close("filled remainder dropped below lot size"));
        return Ok(Ok(close_offer(
            replica,
            give_delta,
            want_delta,
            &resolve.offer,
            events,
        )?));
    };
    let released_give = &remaining_give - &requantized.effective_give;
    if released_give < BigInt::from(0) {
        return Ok(Err(rejected("SWAP_RESOLVE_REMAINDER_EXCEEDS_HELD_GIVE")));
    }
    let authorization = match requantize(
        resolve.offer.give_amount(),
        resolve.offer.want_amount(),
        &SwapNetAuthorization {
            max_fee: resolve.offer.max_fee().clone(),
            min_net_receive: resolve.offer.min_net_receive().clone(),
        },
        &requantized.effective_give,
        &requantized.effective_want,
    ) {
        Ok(authorization) => authorization,
        Err(error) => {
            return Ok(Err(ValidationRejection::SwapNetAuthorization {
                code: error.code(),
            }));
        }
    };
    if let Err(rejection) = release(&mut give_delta, hold_side, &released_give) {
        return Ok(Err(rejection));
    }
    let remaining_offer = SwapOffer::new(
        resolve.offer.offer_id().to_owned(),
        resolve.offer.give_token_id(),
        resolve.offer.give_token_decimals(),
        requantized.effective_give.clone(),
        resolve.offer.want_token_id(),
        resolve.offer.want_token_decimals(),
        requantized.effective_want.clone(),
        authorization.max_fee,
        authorization.min_net_receive,
        resolve.canonical_price_ticks.clone(),
        resolve.offer.time_in_force(),
        resolve.offer.maker_is_left(),
        resolve.offer.created_height(),
    );
    events.push(format!(
        "📊 Swap offer {}... partially filled, {} remaining",
        crate::identity::js_prefix(resolve.offer.offer_id(), 8),
        requantized.effective_give,
    ));
    let identity = replica.state().identity().clone();
    let output = AccountOutput::SwapOfferUpsert {
        offer: Box::new(remaining_offer.snapshot(
            identity.left().as_hex(),
            identity.entity(Side::Right).as_hex(),
        )),
    };
    replica.state_mut().put_delta(give_delta)?;
    replica.state_mut().put_delta(want_delta)?;
    replica.state_mut().put_swap_offer(remaining_offer)?;
    Ok(Ok(RemainderOutcome {
        events,
        outputs: vec![output],
    }))
}

fn release(
    delta: &mut crate::Delta,
    side: Side,
    amount: &BigInt,
) -> Result<(), ValidationRejection> {
    if amount <= &BigInt::from(0) {
        return Ok(());
    }
    if delta.hold(side) < amount {
        return Err(rejected("SWAP_RESOLVE_HOLD_UNDERFLOW"));
    }
    delta
        .release_hold(side, amount)
        .map_err(|_| rejected("SWAP_RESOLVE_HOLD_UNDERFLOW"))
}

fn close_offer(
    replica: &mut AccountReplica,
    give_delta: crate::Delta,
    want_delta: crate::Delta,
    offer: &SwapOffer,
    events: Vec<String>,
) -> Result<RemainderOutcome, TransitionError> {
    replica.state_mut().put_delta(give_delta)?;
    replica.state_mut().put_delta(want_delta)?;
    replica.state_mut().remove_swap_offer(offer.offer_id())?;
    Ok(RemainderOutcome {
        events,
        outputs: vec![AccountOutput::SwapOfferRemove {
            offer_id: offer.offer_id().to_owned(),
        }],
    })
}
