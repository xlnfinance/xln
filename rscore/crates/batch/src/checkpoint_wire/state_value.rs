use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{
    BilateralRebalanceFeePolicy, HtlcLock, LendingIntentKind, RebalanceFeePolicySnapshot, Side,
    SwapOffer,
};

use super::{encode_bigint, encode_canonical_value, integer, tuple};

pub(super) fn encode_lock(value: &HtlcLock) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.lock_id().to_owned()),
        AbiValue::Bytes(value.hashlock().bytes().to_vec()),
        encode_bigint(value.timelock()),
        integer(value.reveal_before_height()),
        encode_bigint(value.amount()),
        integer(value.token_id().get()),
        integer(match value.sender() {
            Side::Left => 0,
            Side::Right => 1,
        }),
        integer(value.created_height()),
        integer(value.created_timestamp()),
        value
            .envelope_hash()
            .map_or(AbiValue::Nil, |hash| AbiValue::Bytes(hash.to_vec())),
    ])
}

pub(super) fn encode_swap_offer(value: &SwapOffer) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.offer_id().to_owned()),
        integer(value.give_token_id()),
        integer(value.give_token_decimals()),
        encode_bigint(value.give_amount()),
        integer(value.want_token_id()),
        integer(value.want_token_decimals()),
        encode_bigint(value.want_amount()),
        encode_bigint(value.max_fee()),
        encode_bigint(value.min_net_receive()),
        encode_bigint(value.price_ticks()),
        value.time_in_force().map_or(AbiValue::Nil, integer),
        integer(if value.maker_is_left() { 0 } else { 1 }),
        integer(value.created_height()),
        encode_bigint(value.quantized_give()),
        encode_bigint(value.quantized_want()),
        value
            .cross_jurisdiction()
            .map_or(AbiValue::Nil, encode_canonical_value),
    ])
}

pub(super) fn encode_policy(value: &BilateralRebalanceFeePolicy) -> AbiValue {
    tuple(vec![
        value
            .side(Side::Left)
            .map_or(AbiValue::Nil, encode_policy_snapshot),
        value
            .side(Side::Right)
            .map_or(AbiValue::Nil, encode_policy_snapshot),
    ])
}

fn encode_policy_snapshot(value: &RebalanceFeePolicySnapshot) -> AbiValue {
    tuple(vec![
        integer(value.policy_version()),
        encode_bigint(value.base_fee()),
        encode_bigint(value.liquidity_fee_bps()),
        encode_bigint(value.gas_fee()),
        integer(value.updated_at()),
    ])
}

pub(super) fn encode_lending_kind(value: &LendingIntentKind) -> AbiValue {
    integer(match value {
        LendingIntentKind::Fund => 0,
        LendingIntentKind::Borrow => 1,
        LendingIntentKind::Repay => 2,
        LendingIntentKind::CreditGrant => 3,
        LendingIntentKind::CreditRevoke => 4,
        LendingIntentKind::CloseRequest => 5,
        LendingIntentKind::ClosePayout => 6,
    })
}
