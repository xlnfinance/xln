use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{
    AccountTx, DeliveryMode, Delta, HtlcDeliveryMode, HtlcResolveOutcome, JClaimNode, JClaimProof,
    JurisdictionEvent, Side,
};

use super::{AccountWireEncodeError, integer, tuple};

pub fn encode_delta(value: &Delta) -> AbiValue {
    tuple(vec![
        integer(value.token_id().get()),
        encode_bigint(value.collateral()),
        encode_bigint(value.ondelta()),
        encode_bigint(value.offdelta()),
        encode_bigint(value.left_credit_limit()),
        encode_bigint(value.right_credit_limit()),
        encode_bigint(value.allowance(Side::Left)),
        encode_bigint(value.allowance(Side::Right)),
        encode_bigint(value.hold(Side::Left)),
        encode_bigint(value.hold(Side::Right)),
    ])
}

pub fn encode_account_tx(value: &AccountTx) -> Result<AbiValue, AccountWireEncodeError> {
    let fields = match value {
        AccountTx::DirectPayment {
            token_id,
            amount,
            route,
            description,
            from_entity_id,
            to_entity_id,
            delivery_mode,
            trusted_gateway_entity_id,
        } => vec![
            integer(0),
            integer(token_id.get()),
            encode_bigint(amount),
            tuple(route.iter().cloned().map(AbiValue::Text).collect()),
            optional_text(description),
            AbiValue::Text(from_entity_id.clone()),
            AbiValue::Text(to_entity_id.clone()),
            integer(match delivery_mode {
                DeliveryMode::Direct => 0,
                DeliveryMode::Trusted => 1,
            }),
            optional_text(trusted_gateway_entity_id),
        ],
        AccountTx::HtlcLock(lock) => vec![
            integer(1),
            AbiValue::Text(lock.lock_id.clone()),
            hex_bytes(lock.hashlock.as_str(), 32)?,
            encode_bigint(&lock.timelock),
            integer(lock.reveal_before_height),
            encode_bigint(&lock.amount),
            integer(lock.token_id.get()),
            match lock.delivery_mode {
                None => AbiValue::Nil,
                Some(HtlcDeliveryMode::Instant) => integer(0),
                Some(HtlcDeliveryMode::Async) => integer(1),
            },
            lock.envelope.as_ref().map_or(AbiValue::Nil, |envelope| {
                AbiValue::Bytes(envelope.packed().to_vec())
            }),
        ],
        AccountTx::HtlcResolve(resolve) => {
            let (outcome, payload) = match &resolve.outcome {
                HtlcResolveOutcome::Secret { secret } => (integer(0), hex_bytes(secret, 32)?),
                HtlcResolveOutcome::Error { reason } => (integer(1), optional_text(reason)),
            };
            vec![
                integer(2),
                AbiValue::Text(resolve.lock_id.clone()),
                outcome,
                payload,
            ]
        }
        AccountTx::AddDelta { token_id } => vec![integer(3), integer(token_id.get())],
        AccountTx::SetCreditLimit { token_id, amount } => {
            vec![integer(4), integer(token_id.get()), encode_bigint(amount)]
        }
        AccountTx::RebalancePolicy {
            token_id,
            policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
        } => vec![
            integer(5),
            integer(*token_id),
            integer(*policy_version),
            encode_bigint(base_fee),
            encode_bigint(liquidity_fee_bps),
            encode_bigint(gas_fee),
        ],
        AccountTx::SwapOffer {
            offer_id,
            give_token_id,
            give_token_decimals,
            give_amount,
            want_token_id,
            want_token_decimals,
            want_amount,
            max_fee,
            min_net_receive,
            time_in_force,
            price_ticks,
        } => vec![
            integer(6),
            AbiValue::Text(offer_id.clone()),
            integer(*give_token_id),
            integer(*give_token_decimals),
            encode_bigint(give_amount),
            integer(*want_token_id),
            integer(*want_token_decimals),
            encode_bigint(want_amount),
            encode_bigint(max_fee),
            encode_bigint(min_net_receive),
            time_in_force.map_or(AbiValue::Nil, integer),
            optional_bigint(price_ticks),
        ],
        AccountTx::SwapCancelRequest { offer_id } => {
            vec![integer(7), AbiValue::Text(offer_id.clone())]
        }
        AccountTx::SwapResolve {
            offer_id,
            fill_ratio,
            fill_numerator,
            fill_denominator,
            cancel_remainder,
            comment,
            fee_token_id,
            fee_amount,
            execution_give_amount,
            execution_want_amount,
            resting_give_token_id,
            resting_want_token_id,
            resting_price_ticks,
            resting_give_amount,
            resting_want_amount,
            resting_quantized_give,
            resting_quantized_want,
        } => vec![
            integer(8),
            AbiValue::Text(offer_id.clone()),
            integer(*fill_ratio),
            optional_bigint(fill_numerator),
            optional_bigint(fill_denominator),
            integer(u8::from(*cancel_remainder)),
            comment.clone().map_or(AbiValue::Nil, AbiValue::Text),
            resting_give_token_id.map_or(AbiValue::Nil, integer),
            resting_want_token_id.map_or(AbiValue::Nil, integer),
            fee_token_id.map_or(AbiValue::Nil, integer),
            optional_bigint(fee_amount),
            optional_bigint(execution_give_amount),
            optional_bigint(execution_want_amount),
            optional_bigint(resting_price_ticks),
            optional_bigint(resting_give_amount),
            optional_bigint(resting_want_amount),
            optional_bigint(resting_quantized_give),
            optional_bigint(resting_quantized_want),
        ],
        AccountTx::JEventClaim(claim) => vec![
            integer(9),
            integer(claim.j_height),
            AbiValue::Bytes(claim.j_block_hash.to_vec()),
            AbiValue::Bytes(xln_rscore_engine::canonical_events_hash(&claim.events)?.to_vec()),
            tuple(
                claim
                    .events
                    .iter()
                    .map(jurisdiction_event)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            j_claim_proof(claim.left_proof.as_ref())?,
            j_claim_proof(claim.right_proof.as_ref())?,
        ],
        other => {
            return Err(AccountWireEncodeError::Unsupported(
                xln_rscore_engine::StateError::UnsupportedFrameTx(
                    xln_rscore_engine::unsupported_frame_tx_kind(other),
                )
                .to_string(),
            ));
        }
    };
    Ok(tuple(fields))
}

fn jurisdiction_event(value: &JurisdictionEvent) -> Result<AbiValue, AccountWireEncodeError> {
    match value {
        JurisdictionEvent::AccountSettled(event) => Ok(tuple(vec![
            integer(0),
            tuple(vec![
                event.metadata.block_number.map_or(AbiValue::Nil, integer),
                event
                    .metadata
                    .block_hash
                    .map_or(AbiValue::Nil, |hash| AbiValue::Bytes(hash.to_vec())),
                event
                    .metadata
                    .transaction_hash
                    .map_or(AbiValue::Nil, |hash| AbiValue::Bytes(hash.to_vec())),
                event.metadata.log_index.map_or(AbiValue::Nil, integer),
                event.metadata.event_index.map_or(AbiValue::Nil, integer),
            ]),
            AbiValue::Bytes(event.left_entity.as_bytes().to_vec()),
            AbiValue::Bytes(event.right_entity.as_bytes().to_vec()),
            integer(event.token_id.get()),
            encode_bigint(&event.left_reserve),
            encode_bigint(&event.right_reserve),
            encode_bigint(&event.collateral),
            encode_bigint(&event.ondelta),
            integer(event.nonce),
        ])),
    }
}

fn j_claim_proof(value: Option<&JClaimProof>) -> Result<AbiValue, AccountWireEncodeError> {
    let Some(proof) = value else {
        return Ok(AbiValue::Nil);
    };
    Ok(tuple(vec![
        integer(1),
        tuple(
            proof
                .nodes
                .iter()
                .map(encode_j_claim_node)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    ]))
}

pub fn encode_j_claim_node(value: &JClaimNode) -> Result<AbiValue, AccountWireEncodeError> {
    Ok(match value {
        JClaimNode::Leaf { key, record } => tuple(vec![
            integer(0),
            AbiValue::Bytes(key.to_vec()),
            tuple(vec![
                AbiValue::Bytes(record.account_key.to_vec()),
                integer(match record.side {
                    xln_rscore_engine::JClaimSide::Left => 0,
                    xln_rscore_engine::JClaimSide::Right => 1,
                }),
                integer(record.j_height),
                AbiValue::Bytes(record.j_block_hash.to_vec()),
                AbiValue::Bytes(record.events_hash.to_vec()),
            ]),
        ]),
        JClaimNode::Branch { bit, left, right } => tuple(vec![
            integer(1),
            integer(*bit),
            AbiValue::Bytes(left.to_vec()),
            AbiValue::Bytes(right.to_vec()),
        ]),
    })
}

fn hex_bytes(value: &str, length: usize) -> Result<AbiValue, AccountWireEncodeError> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() != length * 2 {
        return Err(AccountWireEncodeError::Expected("wireHexLength"));
    }
    let mut bytes = Vec::with_capacity(length);
    for pair in hex.as_bytes().chunks_exact(2) {
        let nibble = |value: u8| match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        };
        let high = nibble(pair[0]).ok_or(AccountWireEncodeError::Expected("wireHexDigit"))?;
        let low = nibble(pair[1]).ok_or(AccountWireEncodeError::Expected("wireHexDigit"))?;
        bytes.push((high << 4) | low);
    }
    Ok(AbiValue::Bytes(bytes))
}

pub fn encode_bigint(value: &BigInt) -> AbiValue {
    AbiValue::Text(value.to_string())
}

fn optional_bigint(value: &Option<BigInt>) -> AbiValue {
    value.as_ref().map_or(AbiValue::Nil, encode_bigint)
}

fn optional_text(value: &Option<String>) -> AbiValue {
    value.clone().map_or(AbiValue::Nil, AbiValue::Text)
}
