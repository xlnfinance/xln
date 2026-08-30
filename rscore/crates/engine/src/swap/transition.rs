//! swap_offer: admission, quantization, hold, resting row.

use num_bigint::BigInt;

use super::market::SwapMarketPolicy;
use super::market::lot_scale;
use super::net_authorization::{SwapNetAuthorization, assert_offer_authorization, requantize};
use super::offer::{
    MAX_ACCOUNT_CROSS_J_SWAP_OFFERS, MAX_ACCOUNT_SAME_J_SWAP_OFFERS, MAX_ACCOUNT_SWAP_OFFERS,
    MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET, SwapOffer,
};
use super::quantization::{PreparedSwapOrder, prepare_swap_order, quote_amount_at_price};
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountOutput, AccountRejection, AccountReplica, Side, TokenId, TransitionError,
    ValidationRejection,
};

const MAX_TOKEN_DECIMALS: u32 = 255;

/// FINANCIAL.MAX_PAYMENT_AMOUNT (core/config/constants.ts).
fn max_payment_amount() -> BigInt {
    (BigInt::from(1) << 128u32) - 1
}

pub(crate) struct SwapOfferTx<'a> {
    pub offer_id: &'a str,
    pub give_token_id: u32,
    pub give_token_decimals: u32,
    pub give_amount: &'a BigInt,
    pub want_token_id: u32,
    pub want_token_decimals: u32,
    pub want_amount: &'a BigInt,
    pub max_fee: &'a BigInt,
    pub min_net_receive: &'a BigInt,
    pub time_in_force: Option<u8>,
    /// Explicit book level signed by the maker, when it carried one.
    pub price_ticks: Option<&'a BigInt>,
    pub cross_jurisdiction: Option<&'a xln_rscore_protocol::CanonicalValue>,
}

pub(crate) fn apply_offer(
    replica: &mut AccountReplica,
    policy: &SwapMarketPolicy,
    tx: SwapOfferTx<'_>,
    proposer: Side,
    current_height: u64,
) -> Result<MutationDecision, TransitionError> {
    if policy.is_empty() {
        return Err(TransitionError::SwapMarketPolicyMissing);
    }
    let maker_side = match admission(replica, &tx, proposer) {
        Ok(side) => side,
        Err(reason) => return Ok(rejected(reason)),
    };
    let prepared = match prepare_offer_amounts(policy, &tx) {
        Ok(prepared) => prepared,
        Err(rejection) => return Ok(rejected(rejection)),
    };
    let authorization = match requantize(
        tx.give_amount,
        tx.want_amount,
        &SwapNetAuthorization {
            max_fee: tx.max_fee.clone(),
            min_net_receive: tx.min_net_receive.clone(),
        },
        &prepared.effective_give,
        &prepared.effective_want,
    ) {
        Ok(authorization) => authorization,
        Err(error) => {
            return Ok(rejected(ValidationRejection::SwapNetAuthorization {
                code: error.code(),
            }));
        }
    };

    // The maker is the frame proposer for a same-j offer, and the give leg is
    // locked now: holds and the resting row are both hashed account state, so
    // validation and commit must run this same mutation.
    let maker_is_left = maker_side == Side::Left;
    if tx.cross_jurisdiction.is_none() {
        let token_id = TokenId::new(tx.give_token_id)?;
        let mut delta = replica.state().delta_or_zero(token_id)?;
        let available = delta.perspective(maker_side).out_capacity;
        if prepared.effective_give > available {
            return Ok(rejected(ValidationRejection::InsufficientCapacity {
                payer_suffix: tx.offer_id.to_owned(),
                required: prepared.effective_give.clone(),
                available,
            }));
        }
        delta.add_hold(maker_side, &prepared.effective_give)?;
        replica.state_mut().put_delta(delta)?;
    }

    let identity = replica.state().identity().clone();
    let mut offer = SwapOffer::new(
        tx.offer_id.to_owned(),
        tx.give_token_id,
        tx.give_token_decimals,
        prepared.effective_give.clone(),
        tx.want_token_id,
        tx.want_token_decimals,
        prepared.effective_want.clone(),
        authorization.max_fee,
        authorization.min_net_receive,
        prepared.price_ticks.clone(),
        tx.time_in_force,
        maker_is_left,
        current_height,
    );
    offer.set_cross_jurisdiction(tx.cross_jurisdiction.cloned());
    let events = vec![format!(
        "📊 Swap offer created: {}... give {} token{} for {} token{}",
        crate::state::identity::js_prefix(tx.offer_id, 8),
        prepared.effective_give,
        tx.give_token_id,
        prepared.effective_want,
        tx.want_token_id,
    )];
    let output = AccountOutput::SwapOfferUpsert {
        offer: Box::new(offer.snapshot(
            identity.left().as_hex(),
            identity.entity(Side::Right).as_hex(),
        )),
    };
    replica.state_mut().put_swap_offer(offer)?;
    Ok(MutationDecision::with_outputs(events, vec![output]))
}

/// Parity target: `prepareSwapOfferAmounts`
/// (core/account/tx/handlers/swap/offer/quantization.ts).
///
/// The canonical order preparation supplies the price and the "too small /
/// bad ratio" gate, but NOT the amounts: offer creation aligns the base to the
/// plain lot scale and recomputes the quote at the committed price. The
/// exact-quote-lot multiple belongs to the remainder path alone.
fn prepare_offer_amounts(
    policy: &SwapMarketPolicy,
    tx: &SwapOfferTx<'_>,
) -> Result<PreparedSwapOrder, ValidationRejection> {
    if let Some(route) = tx.cross_jurisdiction {
        return prepare_cross_j_offer_amounts(policy, tx, route);
    }
    let side = policy.derive_side(tx.give_token_id, tx.want_token_id);
    let (raw_base, base_decimals, quote_decimals) = if side == 1 {
        (
            tx.give_amount,
            tx.give_token_decimals,
            tx.want_token_decimals,
        )
    } else {
        (
            tx.want_amount,
            tx.want_token_decimals,
            tx.give_token_decimals,
        )
    };
    let lot = lot_scale(base_decimals);
    if raw_base < &lot {
        return Err(ValidationRejection::SwapOfferLotSize { lot: lot.clone() });
    }
    let (base_token_id, quote_token_id) = policy.canonical_pair(tx.give_token_id, tx.want_token_id);
    let step = BigInt::from(
        policy
            .price_step_ticks(base_token_id, quote_token_id, base_decimals, quote_decimals)
            .max(1),
    );
    let Some(canonical) = prepare_swap_order(
        policy,
        tx.give_token_id,
        tx.want_token_id,
        tx.give_amount,
        tx.want_amount,
        tx.give_token_decimals,
        tx.want_token_decimals,
    ) else {
        return Err(ValidationRejection::SwapOfferQuantization {
            offer_id: tx.offer_id.to_owned(),
        });
    };
    // An explicit tick is the signed user intent and owns the final book level,
    // as long as it is aligned to the step and within one step of the
    // deterministic price.
    let price_ticks = match tx.price_ticks {
        None => canonical.price_ticks,
        Some(input) => {
            if input <= &BigInt::from(0) {
                return Err(ValidationRejection::SwapOfferPriceTicks);
            }
            if &((input / &step) * &step) != input {
                return Err(ValidationRejection::SwapOfferPriceTicks);
            }
            let drift = if input > &canonical.price_ticks {
                input - &canonical.price_ticks
            } else {
                &canonical.price_ticks - input
            };
            if drift > step {
                return Err(ValidationRejection::SwapOfferPriceTicks);
            }
            input.clone()
        }
    };
    let quantized_base = (raw_base / &lot) * &lot;
    let recomputed_quote =
        quote_amount_at_price(base_decimals, quote_decimals, &quantized_base, &price_ticks);
    let (effective_give, effective_want) = if side == 1 {
        (quantized_base, recomputed_quote)
    } else {
        (recomputed_quote, quantized_base)
    };
    // TypeScript bounds-checks the quantized amounts, not only the raw ones.
    let minimum = BigInt::from(1);
    let maximum = max_payment_amount();
    if effective_give < minimum
        || effective_give > maximum
        || effective_want < minimum
        || effective_want > maximum
    {
        return Err(ValidationRejection::SwapOfferAmount);
    }
    Ok(PreparedSwapOrder {
        price_ticks,
        effective_give,
        effective_want,
    })
}

fn prepare_cross_j_offer_amounts(
    policy: &SwapMarketPolicy,
    tx: &SwapOfferTx<'_>,
    route: &xln_rscore_protocol::CanonicalValue,
) -> Result<PreparedSwapOrder, ValidationRejection> {
    use num_integer::Integer;

    let source_is_base = crate::tx::handlers::cross_j::cross_market_source_is_base(policy, route)
        .map_err(|message| ValidationRejection::AccountTx { message })?;
    let side = if source_is_base { 1 } else { 0 };
    let (raw_base, raw_quote, base_decimals, quote_decimals) = if source_is_base {
        (
            tx.give_amount,
            tx.want_amount,
            tx.give_token_decimals,
            tx.want_token_decimals,
        )
    } else {
        (
            tx.want_amount,
            tx.give_amount,
            tx.want_token_decimals,
            tx.give_token_decimals,
        )
    };
    let lot = lot_scale(base_decimals);
    if raw_base < &lot || (raw_base % &lot) != BigInt::from(0) {
        return Err(ValidationRejection::SwapOfferLotSize { lot });
    }
    let numerator = raw_quote
        * super::market::token_scale(base_decimals)
        * BigInt::from(super::market::ORDERBOOK_PRICE_SCALE);
    let denominator = raw_base * super::market::token_scale(quote_decimals);
    let (mut price_ticks, remainder) = numerator.div_rem(&denominator);
    if side == 1 && remainder > BigInt::from(0) {
        price_ticks += 1;
    }
    if price_ticks <= BigInt::from(0) {
        return Err(ValidationRejection::SwapOfferPriceTicks);
    }
    Ok(PreparedSwapOrder {
        price_ticks,
        effective_give: tx.give_amount.clone(),
        effective_want: tx.want_amount.clone(),
    })
}

fn admission(
    replica: &AccountReplica,
    tx: &SwapOfferTx<'_>,
    proposer: Side,
) -> Result<Side, ValidationRejection> {
    let state = replica.state();
    if tx.offer_id.contains(':') {
        return Err(ValidationRejection::SwapOfferId {
            offer_id: tx.offer_id.to_owned(),
        });
    }
    if state.swap_offer(tx.offer_id).is_some() {
        return Err(ValidationRejection::SwapOfferExists {
            offer_id: tx.offer_id.to_owned(),
        });
    }
    if state.swap_offer_count() >= MAX_ACCOUNT_SWAP_OFFERS {
        return Err(ValidationRejection::SwapOfferLimit {
            maximum: MAX_ACCOUNT_SWAP_OFFERS,
        });
    }
    let cross_count = state
        .swap_offers()
        .filter(|offer| offer.cross_jurisdiction().is_some())
        .count();
    let same_count = state.swap_offer_count() - cross_count;
    if tx.cross_jurisdiction.is_some() && cross_count >= MAX_ACCOUNT_CROSS_J_SWAP_OFFERS {
        return Err(ValidationRejection::SwapOfferLimit {
            maximum: MAX_ACCOUNT_CROSS_J_SWAP_OFFERS,
        });
    }
    if tx.cross_jurisdiction.is_none() && same_count >= MAX_ACCOUNT_SAME_J_SWAP_OFFERS {
        return Err(ValidationRejection::SwapOfferLimit {
            maximum: MAX_ACCOUNT_SAME_J_SWAP_OFFERS,
        });
    }
    if tx.give_token_decimals > MAX_TOKEN_DECIMALS || tx.want_token_decimals > MAX_TOKEN_DECIMALS {
        return Err(ValidationRejection::SwapOfferDecimals);
    }
    // FINANCIAL.MIN_PAYMENT_AMOUNT..=MAX_PAYMENT_AMOUNT (1..=U128 max).
    let zero = BigInt::from(0);
    let max_amount = max_payment_amount();
    if tx.give_amount <= &zero
        || tx.want_amount <= &zero
        || tx.give_amount > &max_amount
        || tx.want_amount > &max_amount
    {
        return Err(ValidationRejection::SwapOfferAmount);
    }
    if tx.max_fee >= tx.want_amount || tx.min_net_receive <= &zero {
        return Err(ValidationRejection::SwapNetAuthorization {
            code: "SWAP_NET_AUTH_INITIAL_TERMS_INVALID",
        });
    }
    if assert_offer_authorization(
        tx.give_amount,
        tx.want_amount,
        &SwapNetAuthorization {
            max_fee: tx.max_fee.clone(),
            min_net_receive: tx.min_net_receive.clone(),
        },
    )
    .is_err()
    {
        return Err(ValidationRejection::SwapNetAuthorization {
            code: "SWAP_NET_AUTH_INITIAL_TERMS_INVALID",
        });
    }
    if tx.cross_jurisdiction.is_some()
        && (tx.max_fee != &BigInt::from(0) || tx.min_net_receive != tx.want_amount)
    {
        return Err(ValidationRejection::AccountTx {
            message: "CROSS_J_SWAP_NET_AUTH_INVALID".into(),
        });
    }
    if tx.give_token_id == tx.want_token_id && tx.cross_jurisdiction.is_none() {
        return Err(ValidationRejection::SwapOfferSameToken {
            token_id: tx.give_token_id,
        });
    }
    if tx.time_in_force.is_some_and(|value| value > 2) {
        return Err(ValidationRejection::SwapOfferTimeInForce);
    }
    let maker_side = match tx.cross_jurisdiction {
        Some(route) => crate::tx::handlers::cross_j::validate_swap_offer_route(
            replica,
            route,
            tx.give_token_id,
            tx.want_token_id,
            proposer,
        )
        .map_err(|message| ValidationRejection::AccountTx { message })?,
        None => proposer,
    };
    if let Some(rejection) = market_limit(replica, tx, maker_side) {
        return Err(rejection);
    }
    Ok(maker_side)
}

/// One market, one side: the same ceiling the TypeScript admission applies.
fn market_limit(
    replica: &AccountReplica,
    tx: &SwapOfferTx<'_>,
    proposer: Side,
) -> Option<ValidationRejection> {
    // Same-j: the maker is the proposer of the frame, not the owner of this
    // replica — the owner sees both its own and its counterparty's offers.
    let maker_is_left = proposer == Side::Left;
    let market_key = format!("same:{}>{}", tx.give_token_id, tx.want_token_id);
    let count = replica
        .state()
        .swap_offers()
        .filter(|offer| offer.maker_is_left() == maker_is_left)
        .filter(|offer| offer.market_key() == market_key)
        .count();
    (count >= MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET).then_some(
        ValidationRejection::SwapOfferMarketLimit {
            market: market_key,
            maximum: MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET,
        },
    )
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}
