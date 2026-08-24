//! Fee authority carried by the maker's signed offer.
//!
//! Parity target: `core/account/swap/swap-net-authorization.ts`. Fee rounds
//! down, required net rounds up, and requantization after a resize subtracts
//! the pro-rata share of the removed give leg.

use num_bigint::BigInt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapNetAuthorization {
    pub max_fee: BigInt,
    pub min_net_receive: BigInt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapNetAuthorizationError {
    OfferAmount,
    MaxFee,
    MinReceive,
    Remainder,
}

impl SwapNetAuthorizationError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::OfferAmount => "SWAP_NET_AUTH_OFFER_AMOUNT_INVALID",
            Self::MaxFee => "SWAP_NET_AUTH_MAX_FEE_INVALID",
            Self::MinReceive => "SWAP_NET_AUTH_MIN_RECEIVE_INVALID",
            Self::Remainder => "SWAP_NET_AUTH_REMAINDER_INVALID",
        }
    }
}

fn ceil_divide(numerator: &BigInt, denominator: &BigInt) -> BigInt {
    (numerator + denominator - 1) / denominator
}

pub fn assert_offer_authorization(
    give_amount: &BigInt,
    want_amount: &BigInt,
    authorization: &SwapNetAuthorization,
) -> Result<(), SwapNetAuthorizationError> {
    let zero = BigInt::from(0);
    if give_amount <= &zero || want_amount <= &zero {
        return Err(SwapNetAuthorizationError::OfferAmount);
    }
    if authorization.max_fee < zero || &authorization.max_fee > want_amount {
        return Err(SwapNetAuthorizationError::MaxFee);
    }
    if authorization.min_net_receive < zero || &authorization.min_net_receive > want_amount {
        return Err(SwapNetAuthorizationError::MinReceive);
    }
    Ok(())
}

/// Authority for the resized offer: the original minus the pro-rata share of
/// the give leg that quantization removed.
pub fn requantize(
    give_amount: &BigInt,
    want_amount: &BigInt,
    authorization: &SwapNetAuthorization,
    next_give_amount: &BigInt,
    next_want_amount: &BigInt,
) -> Result<SwapNetAuthorization, SwapNetAuthorizationError> {
    assert_offer_authorization(give_amount, want_amount, authorization)?;
    let zero = BigInt::from(0);
    if next_give_amount <= &zero || next_give_amount > give_amount || next_want_amount <= &zero {
        return Err(SwapNetAuthorizationError::Remainder);
    }
    let removed_give = give_amount - next_give_amount;
    let removed = SwapNetAuthorization {
        max_fee: (&authorization.max_fee * &removed_give) / give_amount,
        min_net_receive: ceil_divide(
            &(&authorization.min_net_receive * &removed_give),
            give_amount,
        ),
    };
    let next = SwapNetAuthorization {
        max_fee: &authorization.max_fee - removed.max_fee,
        min_net_receive: &authorization.min_net_receive - removed.min_net_receive,
    };
    assert_offer_authorization(next_give_amount, next_want_amount, &next)?;
    Ok(next)
}
