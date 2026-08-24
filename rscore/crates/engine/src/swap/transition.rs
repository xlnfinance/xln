//! swap_offer: admission, quantization, hold, resting row.

use num_bigint::BigInt;

use super::market::SwapMarketPolicy;
use super::net_authorization::{SwapNetAuthorization, assert_offer_authorization, requantize};
use super::offer::{
    MAX_ACCOUNT_SAME_J_SWAP_OFFERS, MAX_ACCOUNT_SWAP_OFFERS,
    MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET, SwapOffer,
};
use super::quantization::prepare_swap_order;
use crate::mutation::MutationDecision;
use crate::{
    AccountOutput, AccountRejection, AccountReplica, Side, TokenId, TransitionError,
    ValidationRejection,
};

const MAX_TOKEN_DECIMALS: u32 = 255;

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
    if let Some(reason) = admission(replica, &tx, proposer) {
        return Ok(rejected(reason));
    }
    let Some(prepared) = prepare_swap_order(
        policy,
        tx.give_token_id,
        tx.want_token_id,
        tx.give_amount,
        tx.want_amount,
        tx.give_token_decimals,
        tx.want_token_decimals,
    ) else {
        return Ok(rejected(ValidationRejection::SwapOfferQuantization {
            offer_id: tx.offer_id.to_owned(),
        }));
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
    let maker_is_left = proposer == Side::Left;
    let token_id = TokenId::new(tx.give_token_id)?;
    let mut delta = replica.state().delta_or_zero(token_id)?;
    let available = delta.perspective(proposer).out_capacity;
    if prepared.effective_give > available {
        return Ok(rejected(ValidationRejection::InsufficientCapacity {
            payer_suffix: tx.offer_id.to_owned(),
            required: prepared.effective_give.clone(),
            available,
        }));
    }
    delta.add_hold(proposer, &prepared.effective_give)?;
    replica.state_mut().put_delta(delta)?;

    let identity = replica.state().identity().clone();
    let max_fee = authorization.max_fee.clone();
    let min_net_receive = authorization.min_net_receive.clone();
    let offer = SwapOffer::new(
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
    let events = vec![format!(
        "📊 Swap offer created: {}... give {} token{} for {} token{}",
        &tx.offer_id[..tx.offer_id.len().min(8)],
        prepared.effective_give,
        tx.give_token_id,
        prepared.effective_want,
        tx.want_token_id,
    )];
    let output = AccountOutput::SwapOfferCreated {
        offer_id: tx.offer_id.to_owned(),
        maker_is_left,
        from_entity: identity.left().as_hex(),
        to_entity: identity.entity(Side::Right).as_hex(),
        created_height: current_height,
        give_token_id: tx.give_token_id,
        give_token_decimals: tx.give_token_decimals,
        give_amount: prepared.effective_give,
        want_token_id: tx.want_token_id,
        want_token_decimals: tx.want_token_decimals,
        want_amount: prepared.effective_want,
        max_fee,
        min_net_receive,
        price_ticks: prepared.price_ticks,
        time_in_force: tx.time_in_force,
    };
    replica.state_mut().put_swap_offer(offer)?;
    Ok(MutationDecision::with_outputs(events, vec![output]))
}

fn admission(
    replica: &AccountReplica,
    tx: &SwapOfferTx<'_>,
    proposer: Side,
) -> Option<ValidationRejection> {
    let state = replica.state();
    if tx.offer_id.contains(':') {
        return Some(ValidationRejection::SwapOfferId {
            offer_id: tx.offer_id.to_owned(),
        });
    }
    if state.swap_offer(tx.offer_id).is_some() {
        return Some(ValidationRejection::SwapOfferExists {
            offer_id: tx.offer_id.to_owned(),
        });
    }
    if state.swap_offer_count() >= MAX_ACCOUNT_SWAP_OFFERS
        || state.swap_offer_count() >= MAX_ACCOUNT_SAME_J_SWAP_OFFERS
    {
        return Some(ValidationRejection::SwapOfferLimit {
            maximum: MAX_ACCOUNT_SAME_J_SWAP_OFFERS,
        });
    }
    if tx.give_token_decimals > MAX_TOKEN_DECIMALS || tx.want_token_decimals > MAX_TOKEN_DECIMALS {
        return Some(ValidationRejection::SwapOfferDecimals);
    }
    // FINANCIAL.MIN_PAYMENT_AMOUNT..=MAX_PAYMENT_AMOUNT (1..=U128 max).
    let zero = BigInt::from(0);
    let max_amount = (BigInt::from(1) << 128u32) - 1;
    if tx.give_amount <= &zero
        || tx.want_amount <= &zero
        || tx.give_amount > &max_amount
        || tx.want_amount > &max_amount
    {
        return Some(ValidationRejection::SwapOfferAmount);
    }
    if tx.max_fee >= tx.want_amount || tx.min_net_receive <= &zero {
        return Some(ValidationRejection::SwapNetAuthorization {
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
        return Some(ValidationRejection::SwapNetAuthorization {
            code: "SWAP_NET_AUTH_INITIAL_TERMS_INVALID",
        });
    }
    if tx.give_token_id == tx.want_token_id {
        return Some(ValidationRejection::SwapOfferSameToken {
            token_id: tx.give_token_id,
        });
    }
    if tx.time_in_force.is_some_and(|value| value > 2) {
        return Some(ValidationRejection::SwapOfferTimeInForce);
    }
    market_limit(replica, tx, proposer)
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
