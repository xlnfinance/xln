//! Strict canonical tagged-JSON decoder for Account inputs stored in Runtime WAL.
//!
//! JSON is only the durable interchange boundary. Once decoded, the Runtime
//! hands typed values to Account consensus; no JSON object is trusted or
//! interpreted inside a financial transition. Decode errors stay attached to
//! one operation index so an unauthenticated peer cannot invalidate its
//! neighbours by placing one malformed input in the same Runtime frame.

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_batch::{AccountId, AccountInputKind, AccountInputRow, AccountPeerInput};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountFrame, AccountPeerEnvelope, AccountSettledEvent,
    AccountTx, BoardHankoRefreshInput, CounterpartyDispute, DeliveryMode, DepositoryAddress,
    EntityId, HtlcDeliveryMode, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx,
    IncomingAck, IncomingFrame, JClaimNode, JClaimProof, JClaimRecord, JClaimSide, JEventClaimTx,
    JEventMetadata, JurisdictionEvent, LendingAction, LendingTermId, OpaqueHtlcCiphertext,
    RebalanceRefundReason, ReserveSide, TokenId, WatchSeed,
};

use super::tagged_json::canonical_value_from_tagged_json;

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("RUNTIME_ACCOUNT_INPUT_JSON:{operation_index}:{path}:{reason}")]
pub struct AccountInputJsonError {
    pub operation_index: u64,
    pub path: String,
    pub reason: String,
}

fn invalid(
    operation_index: u64,
    path: impl Into<String>,
    reason: impl Into<String>,
) -> AccountInputJsonError {
    AccountInputJsonError {
        operation_index,
        path: path.into(),
        reason: reason.into(),
    }
}

fn object<'a>(
    value: &'a Value,
    operation_index: u64,
    path: &str,
) -> Result<&'a Map<String, Value>, AccountInputJsonError> {
    value
        .as_object()
        .ok_or_else(|| invalid(operation_index, path, "OBJECT_REQUIRED"))
}

fn exact_fields(
    value: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    operation_index: u64,
    path: &str,
) -> Result<(), AccountInputJsonError> {
    for field in required {
        if !value.contains_key(*field) {
            return Err(invalid(
                operation_index,
                format!("{path}.{field}"),
                "FIELD_MISSING",
            ));
        }
    }
    for field in value.keys() {
        if !required.contains(&field.as_str()) && !optional.contains(&field.as_str()) {
            return Err(invalid(
                operation_index,
                format!("{path}.{field}"),
                "FIELD_UNKNOWN",
            ));
        }
    }
    Ok(())
}

fn field<'a>(
    value: &'a Map<String, Value>,
    field: &'static str,
    operation_index: u64,
    path: &str,
) -> Result<&'a Value, AccountInputJsonError> {
    value
        .get(field)
        .ok_or_else(|| invalid(operation_index, format!("{path}.{field}"), "FIELD_MISSING"))
}

fn text(value: &Value, operation_index: u64, path: &str) -> Result<String, AccountInputJsonError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| invalid(operation_index, path, "STRING_REQUIRED"))
}

fn nonempty_text(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<String, AccountInputJsonError> {
    let value = text(value, operation_index, path)?;
    if value.is_empty() {
        return Err(invalid(operation_index, path, "STRING_EMPTY"));
    }
    Ok(value)
}

fn boolean(value: &Value, operation_index: u64, path: &str) -> Result<bool, AccountInputJsonError> {
    value
        .as_bool()
        .ok_or_else(|| invalid(operation_index, path, "BOOLEAN_REQUIRED"))
}

fn unsigned(value: &Value, operation_index: u64, path: &str) -> Result<u64, AccountInputJsonError> {
    let value = value
        .as_u64()
        .ok_or_else(|| invalid(operation_index, path, "SAFE_INTEGER_REQUIRED"))?;
    if value > JS_MAX_SAFE_INTEGER {
        return Err(invalid(operation_index, path, "SAFE_INTEGER_EXCEEDED"));
    }
    Ok(value)
}

fn signed(value: &Value, operation_index: u64, path: &str) -> Result<i64, AccountInputJsonError> {
    let value = value
        .as_i64()
        .ok_or_else(|| invalid(operation_index, path, "SAFE_INTEGER_REQUIRED"))?;
    if value.unsigned_abs() > JS_MAX_SAFE_INTEGER {
        return Err(invalid(operation_index, path, "SAFE_INTEGER_EXCEEDED"));
    }
    Ok(value)
}

fn canonical_object(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<xln_rscore_engine::CanonicalValue, AccountInputJsonError> {
    let canonical = canonical_value_from_tagged_json(value)
        .map_err(|error| invalid(operation_index, path, error.to_string()))?;
    if !matches!(canonical, xln_rscore_engine::CanonicalValue::Object(_)) {
        return Err(invalid(operation_index, path, "OBJECT_REQUIRED"));
    }
    Ok(canonical)
}

fn u32_value(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<u32, AccountInputJsonError> {
    u32::try_from(unsigned(value, operation_index, path)?)
        .map_err(|_| invalid(operation_index, path, "U32_EXCEEDED"))
}

fn u16_value(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<u16, AccountInputJsonError> {
    u16::try_from(unsigned(value, operation_index, path)?)
        .map_err(|_| invalid(operation_index, path, "U16_EXCEEDED"))
}

fn canonical_decimal(value: &str) -> bool {
    if value == "0" {
        return true;
    }
    let digits = match value.strip_prefix('-') {
        Some(digits) => digits,
        None => value,
    };
    !digits.is_empty()
        && !digits.starts_with('0')
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn decimal_bigint(
    value: &str,
    operation_index: u64,
    path: &str,
) -> Result<BigInt, AccountInputJsonError> {
    if !canonical_decimal(value) {
        return Err(invalid(operation_index, path, "BIGINT_NON_CANONICAL"));
    }
    value
        .parse::<BigInt>()
        .map_err(|_| invalid(operation_index, path, "BIGINT_INVALID"))
}

fn tagged_bigint(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<BigInt, AccountInputJsonError> {
    let tagged = object(value, operation_index, path)?;
    exact_fields(tagged, &["__xlnType", "value"], &[], operation_index, path)?;
    if field(tagged, "__xlnType", operation_index, path)?.as_str() != Some("BigInt") {
        return Err(invalid(operation_index, path, "BIGINT_TAG_INVALID"));
    }
    let decimal = text(
        field(tagged, "value", operation_index, path)?,
        operation_index,
        &format!("{path}.value"),
    )?;
    decimal_bigint(&decimal, operation_index, path)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn fixed_hex<const N: usize>(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<[u8; N], AccountInputJsonError> {
    let value = text(value, operation_index, path)?;
    let payload = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(operation_index, path, "HEX_PREFIX_REQUIRED"))?;
    if payload.len() != N * 2 {
        return Err(invalid(operation_index, path, "HEX_LENGTH_INVALID"));
    }
    let mut output = [0_u8; N];
    for (index, pair) in payload.as_bytes().chunks_exact(2).enumerate() {
        let high =
            hex_nibble(pair[0]).ok_or_else(|| invalid(operation_index, path, "HEX_INVALID"))?;
        let low =
            hex_nibble(pair[1]).ok_or_else(|| invalid(operation_index, path, "HEX_INVALID"))?;
        output[index] = (high << 4) | low;
    }
    Ok(output)
}

fn hex_bytes(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<Vec<u8>, AccountInputJsonError> {
    let value = text(value, operation_index, path)?;
    let payload = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(operation_index, path, "HEX_PREFIX_REQUIRED"))?;
    if payload.is_empty() || payload.len() % 2 != 0 {
        return Err(invalid(operation_index, path, "HEX_LENGTH_INVALID"));
    }
    let mut output = Vec::with_capacity(payload.len() / 2);
    for pair in payload.as_bytes().chunks_exact(2) {
        let high =
            hex_nibble(pair[0]).ok_or_else(|| invalid(operation_index, path, "HEX_INVALID"))?;
        let low =
            hex_nibble(pair[1]).ok_or_else(|| invalid(operation_index, path, "HEX_INVALID"))?;
        output.push((high << 4) | low);
    }
    Ok(output)
}

fn token_id(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<TokenId, AccountInputJsonError> {
    TokenId::new(u32_value(value, operation_index, path)?)
        .map_err(|error| invalid(operation_index, path, error.to_string()))
}

fn optional_bigint(
    value: &Map<String, Value>,
    name: &str,
    operation_index: u64,
    path: &str,
) -> Result<Option<BigInt>, AccountInputJsonError> {
    value
        .get(name)
        .map(|value| tagged_bigint(value, operation_index, &format!("{path}.{name}")))
        .transpose()
}

fn optional_u32(
    value: &Map<String, Value>,
    name: &str,
    operation_index: u64,
    path: &str,
) -> Result<Option<u32>, AccountInputJsonError> {
    value
        .get(name)
        .map(|value| u32_value(value, operation_index, &format!("{path}.{name}")))
        .transpose()
}

fn optional_text(
    value: &Map<String, Value>,
    name: &str,
    operation_index: u64,
    path: &str,
) -> Result<Option<String>, AccountInputJsonError> {
    value
        .get(name)
        .map(|value| text(value, operation_index, &format!("{path}.{name}")))
        .transpose()
}

fn decode_direct_payment(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "tokenId",
            "amount",
            "route",
            "fromEntityId",
            "toEntityId",
            "deliveryMode",
        ],
        &["description", "trustedGatewayEntityId"],
        operation_index,
        path,
    )?;
    let route = field(value, "route", operation_index, path)?
        .as_array()
        .ok_or_else(|| invalid(operation_index, format!("{path}.route"), "ARRAY_REQUIRED"))?
        .iter()
        .enumerate()
        .map(|(index, value)| text(value, operation_index, &format!("{path}.route[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    let delivery = text(
        field(value, "deliveryMode", operation_index, path)?,
        operation_index,
        &format!("{path}.deliveryMode"),
    )?;
    let delivery_mode = match delivery.as_str() {
        "direct" => DeliveryMode::Direct,
        "trusted" => DeliveryMode::Trusted,
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.deliveryMode"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(AccountTx::DirectPayment {
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        route,
        description: optional_text(value, "description", operation_index, path)?,
        from_entity_id: text(
            field(value, "fromEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.fromEntityId"),
        )?,
        to_entity_id: text(
            field(value, "toEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.toEntityId"),
        )?,
        delivery_mode,
        trusted_gateway_entity_id: optional_text(
            value,
            "trustedGatewayEntityId",
            operation_index,
            path,
        )?,
    })
}

fn decode_htlc_lock(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "lockId",
            "hashlock",
            "timelock",
            "revealBeforeHeight",
            "amount",
            "tokenId",
        ],
        &["deliveryMode", "envelope"],
        operation_index,
        path,
    )?;
    let hashlock_text = text(
        field(value, "hashlock", operation_index, path)?,
        operation_index,
        &format!("{path}.hashlock"),
    )?;
    let delivery_mode = match value.get("deliveryMode") {
        None => None,
        Some(mode) => Some(
            match text(mode, operation_index, &format!("{path}.deliveryMode"))?.as_str() {
                "instant" => HtlcDeliveryMode::Instant,
                "async" => HtlcDeliveryMode::Async,
                _ => {
                    return Err(invalid(
                        operation_index,
                        format!("{path}.deliveryMode"),
                        "VALUE_INVALID",
                    ));
                }
            },
        ),
    };
    let envelope = match value.get("envelope") {
        None => None,
        Some(envelope) => {
            let envelope = object(envelope, operation_index, &format!("{path}.envelope"))?;
            exact_fields(
                envelope,
                &["version", "ciphertext"],
                &[],
                operation_index,
                &format!("{path}.envelope"),
            )?;
            let version = text(
                field(envelope, "version", operation_index, path)?,
                operation_index,
                &format!("{path}.envelope.version"),
            )?;
            let ciphertext = text(
                field(envelope, "ciphertext", operation_index, path)?,
                operation_index,
                &format!("{path}.envelope.ciphertext"),
            )?;
            Some(
                OpaqueHtlcCiphertext::parse(&version, &ciphertext).map_err(|error| {
                    invalid(
                        operation_index,
                        format!("{path}.envelope"),
                        error.to_string(),
                    )
                })?,
            )
        }
    };
    Ok(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: text(
            field(value, "lockId", operation_index, path)?,
            operation_index,
            &format!("{path}.lockId"),
        )?,
        hashlock: HtlcHashlock::parse(&hashlock_text).map_err(|error| {
            invalid(
                operation_index,
                format!("{path}.hashlock"),
                error.to_string(),
            )
        })?,
        timelock: tagged_bigint(
            field(value, "timelock", operation_index, path)?,
            operation_index,
            &format!("{path}.timelock"),
        )?,
        reveal_before_height: unsigned(
            field(value, "revealBeforeHeight", operation_index, path)?,
            operation_index,
            &format!("{path}.revealBeforeHeight"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        delivery_mode,
        envelope,
    }))
}

fn decode_htlc_resolve(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    let outcome = text(
        field(value, "outcome", operation_index, path)?,
        operation_index,
        &format!("{path}.outcome"),
    )?;
    let outcome = match outcome.as_str() {
        "secret" => {
            exact_fields(
                value,
                &["lockId", "outcome", "secret"],
                &[],
                operation_index,
                path,
            )?;
            HtlcResolveOutcome::Secret {
                secret: text(
                    field(value, "secret", operation_index, path)?,
                    operation_index,
                    &format!("{path}.secret"),
                )?,
            }
        }
        "error" => {
            exact_fields(
                value,
                &["lockId", "outcome"],
                &["reason"],
                operation_index,
                path,
            )?;
            HtlcResolveOutcome::Error {
                reason: optional_text(value, "reason", operation_index, path)?,
            }
        }
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.outcome"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: text(
            field(value, "lockId", operation_index, path)?,
            operation_index,
            &format!("{path}.lockId"),
        )?,
        outcome,
    }))
}

fn decode_swap_offer(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "offerId",
            "giveTokenId",
            "giveTokenDecimals",
            "giveAmount",
            "wantTokenId",
            "wantTokenDecimals",
            "wantAmount",
            "maxFee",
            "minNetReceive",
        ],
        &["timeInForce", "priceTicks", "crossJurisdiction"],
        operation_index,
        path,
    )?;
    let time_in_force = match value.get("timeInForce") {
        None => None,
        Some(value) => {
            let value = u16_value(value, operation_index, &format!("{path}.timeInForce"))?;
            if value > 2 {
                return Err(invalid(
                    operation_index,
                    format!("{path}.timeInForce"),
                    "VALUE_INVALID",
                ));
            }
            Some(value as u8)
        }
    };
    Ok(AccountTx::SwapOffer {
        offer_id: text(
            field(value, "offerId", operation_index, path)?,
            operation_index,
            &format!("{path}.offerId"),
        )?,
        give_token_id: u32_value(
            field(value, "giveTokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.giveTokenId"),
        )?,
        give_token_decimals: u32_value(
            field(value, "giveTokenDecimals", operation_index, path)?,
            operation_index,
            &format!("{path}.giveTokenDecimals"),
        )?,
        give_amount: tagged_bigint(
            field(value, "giveAmount", operation_index, path)?,
            operation_index,
            &format!("{path}.giveAmount"),
        )?,
        want_token_id: u32_value(
            field(value, "wantTokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.wantTokenId"),
        )?,
        want_token_decimals: u32_value(
            field(value, "wantTokenDecimals", operation_index, path)?,
            operation_index,
            &format!("{path}.wantTokenDecimals"),
        )?,
        want_amount: tagged_bigint(
            field(value, "wantAmount", operation_index, path)?,
            operation_index,
            &format!("{path}.wantAmount"),
        )?,
        max_fee: tagged_bigint(
            field(value, "maxFee", operation_index, path)?,
            operation_index,
            &format!("{path}.maxFee"),
        )?,
        min_net_receive: tagged_bigint(
            field(value, "minNetReceive", operation_index, path)?,
            operation_index,
            &format!("{path}.minNetReceive"),
        )?,
        time_in_force,
        price_ticks: optional_bigint(value, "priceTicks", operation_index, path)?,
        cross_jurisdiction: value
            .get("crossJurisdiction")
            .map(|route| {
                canonical_object(route, operation_index, &format!("{path}.crossJurisdiction"))
            })
            .transpose()?,
    })
}

fn decode_swap_resolve(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &["offerId", "fillRatio", "cancelRemainder"],
        &[
            "fillNumerator",
            "fillDenominator",
            "comment",
            "feeTokenId",
            "feeAmount",
            "executionGiveAmount",
            "executionWantAmount",
            "restingGiveTokenId",
            "restingWantTokenId",
            "restingPriceTicks",
            "restingGiveAmount",
            "restingWantAmount",
            "restingQuantizedGive",
            "restingQuantizedWant",
        ],
        operation_index,
        path,
    )?;
    Ok(AccountTx::SwapResolve {
        offer_id: text(
            field(value, "offerId", operation_index, path)?,
            operation_index,
            &format!("{path}.offerId"),
        )?,
        fill_ratio: u32_value(
            field(value, "fillRatio", operation_index, path)?,
            operation_index,
            &format!("{path}.fillRatio"),
        )?,
        fill_numerator: optional_bigint(value, "fillNumerator", operation_index, path)?,
        fill_denominator: optional_bigint(value, "fillDenominator", operation_index, path)?,
        cancel_remainder: boolean(
            field(value, "cancelRemainder", operation_index, path)?,
            operation_index,
            &format!("{path}.cancelRemainder"),
        )?,
        comment: optional_text(value, "comment", operation_index, path)?,
        fee_token_id: optional_u32(value, "feeTokenId", operation_index, path)?,
        fee_amount: optional_bigint(value, "feeAmount", operation_index, path)?,
        execution_give_amount: optional_bigint(
            value,
            "executionGiveAmount",
            operation_index,
            path,
        )?,
        execution_want_amount: optional_bigint(
            value,
            "executionWantAmount",
            operation_index,
            path,
        )?,
        resting_give_token_id: optional_u32(value, "restingGiveTokenId", operation_index, path)?,
        resting_want_token_id: optional_u32(value, "restingWantTokenId", operation_index, path)?,
        resting_price_ticks: optional_bigint(value, "restingPriceTicks", operation_index, path)?,
        resting_give_amount: optional_bigint(value, "restingGiveAmount", operation_index, path)?,
        resting_want_amount: optional_bigint(value, "restingWantAmount", operation_index, path)?,
        resting_quantized_give: optional_bigint(
            value,
            "restingQuantizedGive",
            operation_index,
            path,
        )?,
        resting_quantized_want: optional_bigint(
            value,
            "restingQuantizedWant",
            operation_index,
            path,
        )?,
    })
}

fn lending_term(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<LendingTermId, AccountInputJsonError> {
    match text(value, operation_index, path)?.as_str() {
        "1h" => Ok(LendingTermId::OneHour),
        "1d" => Ok(LendingTermId::OneDay),
        "1m" => Ok(LendingTermId::OneMonth),
        _ => Err(invalid(operation_index, path, "VALUE_INVALID")),
    }
}

fn decode_lending_fund(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "positionId",
            "hubEntityId",
            "lenderEntityId",
            "tokenId",
            "amount",
            "termId",
            "interestBps",
        ],
        &[],
        operation_index,
        path,
    )?;
    Ok(AccountTx::LendingFund {
        position_id: text(
            field(value, "positionId", operation_index, path)?,
            operation_index,
            &format!("{path}.positionId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        lender_entity_id: text(
            field(value, "lenderEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.lenderEntityId"),
        )?,
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        term_id: lending_term(
            field(value, "termId", operation_index, path)?,
            operation_index,
            &format!("{path}.termId"),
        )?,
        interest_bps: signed(
            field(value, "interestBps", operation_index, path)?,
            operation_index,
            &format!("{path}.interestBps"),
        )?,
    })
}

fn decode_lending_borrow_request(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "requestId",
            "hubEntityId",
            "borrowerEntityId",
            "tokenId",
            "amount",
            "termId",
            "maxInterestBps",
        ],
        &[],
        operation_index,
        path,
    )?;
    Ok(AccountTx::LendingBorrowRequest {
        request_id: text(
            field(value, "requestId", operation_index, path)?,
            operation_index,
            &format!("{path}.requestId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        borrower_entity_id: text(
            field(value, "borrowerEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.borrowerEntityId"),
        )?,
        token_id: unsigned(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        term_id: lending_term(
            field(value, "termId", operation_index, path)?,
            operation_index,
            &format!("{path}.termId"),
        )?,
        max_interest_bps: signed(
            field(value, "maxInterestBps", operation_index, path)?,
            operation_index,
            &format!("{path}.maxInterestBps"),
        )?,
    })
}

fn decode_lending_repay(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "loanId",
            "hubEntityId",
            "borrowerEntityId",
            "tokenId",
            "amount",
        ],
        &[],
        operation_index,
        path,
    )?;
    Ok(AccountTx::LendingRepay {
        loan_id: text(
            field(value, "loanId", operation_index, path)?,
            operation_index,
            &format!("{path}.loanId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        borrower_entity_id: text(
            field(value, "borrowerEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.borrowerEntityId"),
        )?,
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
    })
}

fn decode_lending_credit(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "action",
            "loanId",
            "hubEntityId",
            "borrowerEntityId",
            "tokenId",
            "creditLimit",
        ],
        &[],
        operation_index,
        path,
    )?;
    let action = match text(
        field(value, "action", operation_index, path)?,
        operation_index,
        &format!("{path}.action"),
    )?
    .as_str()
    {
        "grant" => LendingAction::Grant,
        "revoke" => LendingAction::Revoke,
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.action"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(AccountTx::LendingCredit {
        action,
        loan_id: text(
            field(value, "loanId", operation_index, path)?,
            operation_index,
            &format!("{path}.loanId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        borrower_entity_id: text(
            field(value, "borrowerEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.borrowerEntityId"),
        )?,
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        credit_limit: tagged_bigint(
            field(value, "creditLimit", operation_index, path)?,
            operation_index,
            &format!("{path}.creditLimit"),
        )?,
    })
}

fn decode_lending_close_request(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &["positionId", "hubEntityId", "lenderEntityId"],
        &[],
        operation_index,
        path,
    )?;
    Ok(AccountTx::LendingCloseRequest {
        position_id: text(
            field(value, "positionId", operation_index, path)?,
            operation_index,
            &format!("{path}.positionId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        lender_entity_id: text(
            field(value, "lenderEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.lenderEntityId"),
        )?,
    })
}

fn decode_lending_close_payout(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "positionId",
            "hubEntityId",
            "lenderEntityId",
            "tokenId",
            "amount",
        ],
        &[],
        operation_index,
        path,
    )?;
    Ok(AccountTx::LendingClosePayout {
        position_id: text(
            field(value, "positionId", operation_index, path)?,
            operation_index,
            &format!("{path}.positionId"),
        )?,
        hub_entity_id: text(
            field(value, "hubEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.hubEntityId"),
        )?,
        lender_entity_id: text(
            field(value, "lenderEntityId", operation_index, path)?,
            operation_index,
            &format!("{path}.lenderEntityId"),
        )?,
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
    })
}

fn decode_reserve_to_collateral(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &[
            "tokenId",
            "collateral",
            "ondelta",
            "side",
            "blockNumber",
            "transactionHash",
        ],
        &[],
        operation_index,
        path,
    )?;
    let side = match text(
        field(value, "side", operation_index, path)?,
        operation_index,
        &format!("{path}.side"),
    )?
    .as_str()
    {
        "receiving" => ReserveSide::Receiving,
        "counterparty" => ReserveSide::Counterparty,
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.side"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(AccountTx::ReserveToCollateral {
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        collateral: text(
            field(value, "collateral", operation_index, path)?,
            operation_index,
            &format!("{path}.collateral"),
        )?,
        ondelta: text(
            field(value, "ondelta", operation_index, path)?,
            operation_index,
            &format!("{path}.ondelta"),
        )?,
        side,
        block_number: signed(
            field(value, "blockNumber", operation_index, path)?,
            operation_index,
            &format!("{path}.blockNumber"),
        )?,
        transaction_hash: text(
            field(value, "transactionHash", operation_index, path)?,
            operation_index,
            &format!("{path}.transactionHash"),
        )?,
    })
}

fn decode_request_collateral(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &["tokenId", "amount", "feeAmount", "policyVersion"],
        &["feeTokenId"],
        operation_index,
        path,
    )?;
    Ok(AccountTx::RequestCollateral {
        token_id: token_id(
            field(value, "tokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.tokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        fee_token_id: value
            .get("feeTokenId")
            .map(|value| token_id(value, operation_index, &format!("{path}.feeTokenId")))
            .transpose()?,
        fee_amount: tagged_bigint(
            field(value, "feeAmount", operation_index, path)?,
            operation_index,
            &format!("{path}.feeAmount"),
        )?,
        policy_version: unsigned(
            field(value, "policyVersion", operation_index, path)?,
            operation_index,
            &format!("{path}.policyVersion"),
        )?,
    })
}

fn decode_rebalance_refund(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &["requestId", "requestTokenId", "amount", "reason"],
        &[],
        operation_index,
        path,
    )?;
    let reason = match text(
        field(value, "reason", operation_index, path)?,
        operation_index,
        &format!("{path}.reason"),
    )?
    .as_str()
    {
        "policy_mismatch" => RebalanceRefundReason::PolicyMismatch,
        "timeout" => RebalanceRefundReason::Timeout,
        "fee_too_low" => RebalanceRefundReason::FeeTooLow,
        "manual" => RebalanceRefundReason::Manual,
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.reason"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(AccountTx::RebalanceRefund {
        request_id: text(
            field(value, "requestId", operation_index, path)?,
            operation_index,
            &format!("{path}.requestId"),
        )?,
        request_token_id: token_id(
            field(value, "requestTokenId", operation_index, path)?,
            operation_index,
            &format!("{path}.requestTokenId"),
        )?,
        amount: tagged_bigint(
            field(value, "amount", operation_index, path)?,
            operation_index,
            &format!("{path}.amount"),
        )?,
        reason,
    })
}

fn decode_j_claim_record(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<JClaimRecord, AccountInputJsonError> {
    let value = object(value, operation_index, path)?;
    exact_fields(
        value,
        &[
            "version",
            "accountKey",
            "side",
            "jHeight",
            "jBlockHash",
            "eventsHash",
        ],
        &[],
        operation_index,
        path,
    )?;
    if unsigned(
        field(value, "version", operation_index, path)?,
        operation_index,
        &format!("{path}.version"),
    )? != 1
    {
        return Err(invalid(
            operation_index,
            format!("{path}.version"),
            "VERSION_UNSUPPORTED",
        ));
    }
    let side = match text(
        field(value, "side", operation_index, path)?,
        operation_index,
        &format!("{path}.side"),
    )?
    .as_str()
    {
        "left" => JClaimSide::Left,
        "right" => JClaimSide::Right,
        _ => {
            return Err(invalid(
                operation_index,
                format!("{path}.side"),
                "VALUE_INVALID",
            ));
        }
    };
    Ok(JClaimRecord {
        account_key: fixed_hex(
            field(value, "accountKey", operation_index, path)?,
            operation_index,
            &format!("{path}.accountKey"),
        )?,
        side,
        j_height: unsigned(
            field(value, "jHeight", operation_index, path)?,
            operation_index,
            &format!("{path}.jHeight"),
        )?,
        j_block_hash: fixed_hex(
            field(value, "jBlockHash", operation_index, path)?,
            operation_index,
            &format!("{path}.jBlockHash"),
        )?,
        events_hash: fixed_hex(
            field(value, "eventsHash", operation_index, path)?,
            operation_index,
            &format!("{path}.eventsHash"),
        )?,
    })
}

fn decode_j_claim_proof(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<JClaimProof, AccountInputJsonError> {
    let value = object(value, operation_index, path)?;
    exact_fields(value, &["version", "nodes"], &[], operation_index, path)?;
    if unsigned(
        field(value, "version", operation_index, path)?,
        operation_index,
        &format!("{path}.version"),
    )? != 1
    {
        return Err(invalid(
            operation_index,
            format!("{path}.version"),
            "VERSION_UNSUPPORTED",
        ));
    }
    let nodes = field(value, "nodes", operation_index, path)?
        .as_array()
        .ok_or_else(|| invalid(operation_index, format!("{path}.nodes"), "ARRAY_REQUIRED"))?;
    let mut decoded = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let node_path = format!("{path}.nodes[{index}]");
        let node = object(node, operation_index, &node_path)?;
        let kind = text(
            field(node, "type", operation_index, &node_path)?,
            operation_index,
            &format!("{node_path}.type"),
        )?;
        match kind.as_str() {
            "branch" => {
                exact_fields(
                    node,
                    &["version", "type", "bit", "left", "right"],
                    &[],
                    operation_index,
                    &node_path,
                )?;
                if unsigned(
                    field(node, "version", operation_index, &node_path)?,
                    operation_index,
                    &format!("{node_path}.version"),
                )? != 1
                {
                    return Err(invalid(
                        operation_index,
                        format!("{node_path}.version"),
                        "VERSION_UNSUPPORTED",
                    ));
                }
                let bit = u16_value(
                    field(node, "bit", operation_index, &node_path)?,
                    operation_index,
                    &format!("{node_path}.bit"),
                )?;
                if bit > 255 {
                    return Err(invalid(
                        operation_index,
                        format!("{node_path}.bit"),
                        "VALUE_INVALID",
                    ));
                }
                decoded.push(JClaimNode::Branch {
                    bit,
                    left: fixed_hex(
                        field(node, "left", operation_index, &node_path)?,
                        operation_index,
                        &format!("{node_path}.left"),
                    )?,
                    right: fixed_hex(
                        field(node, "right", operation_index, &node_path)?,
                        operation_index,
                        &format!("{node_path}.right"),
                    )?,
                });
            }
            "leaf" => {
                exact_fields(
                    node,
                    &["version", "type", "key", "record"],
                    &[],
                    operation_index,
                    &node_path,
                )?;
                if unsigned(
                    field(node, "version", operation_index, &node_path)?,
                    operation_index,
                    &format!("{node_path}.version"),
                )? != 1
                {
                    return Err(invalid(
                        operation_index,
                        format!("{node_path}.version"),
                        "VERSION_UNSUPPORTED",
                    ));
                }
                decoded.push(JClaimNode::Leaf {
                    key: fixed_hex(
                        field(node, "key", operation_index, &node_path)?,
                        operation_index,
                        &format!("{node_path}.key"),
                    )?,
                    record: decode_j_claim_record(
                        field(node, "record", operation_index, &node_path)?,
                        operation_index,
                        &format!("{node_path}.record"),
                    )?,
                });
            }
            _ => {
                return Err(invalid(
                    operation_index,
                    format!("{node_path}.type"),
                    "VALUE_INVALID",
                ));
            }
        }
    }
    Ok(JClaimProof { nodes: decoded })
}

fn optional_metadata_hex(
    value: &Map<String, Value>,
    name: &str,
    operation_index: u64,
    path: &str,
) -> Result<Option<[u8; 32]>, AccountInputJsonError> {
    value
        .get(name)
        .map(|value| fixed_hex(value, operation_index, &format!("{path}.{name}")))
        .transpose()
}

fn optional_unsigned(
    value: &Map<String, Value>,
    name: &str,
    operation_index: u64,
    path: &str,
) -> Result<Option<u64>, AccountInputJsonError> {
    value
        .get(name)
        .map(|value| unsigned(value, operation_index, &format!("{path}.{name}")))
        .transpose()
}

fn decode_account_settled_event(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<JurisdictionEvent, AccountInputJsonError> {
    exact_fields(
        value,
        &["type", "data"],
        &[
            "blockNumber",
            "blockHash",
            "transactionHash",
            "logIndex",
            "eventIndex",
        ],
        operation_index,
        path,
    )?;
    if field(value, "type", operation_index, path)?.as_str() != Some("AccountSettled") {
        return Err(invalid(
            operation_index,
            format!("{path}.type"),
            "J_EVENT_UNSUPPORTED",
        ));
    }
    let data_path = format!("{path}.data");
    let data = object(
        field(value, "data", operation_index, path)?,
        operation_index,
        &data_path,
    )?;
    exact_fields(
        data,
        &[
            "leftEntity",
            "rightEntity",
            "tokenId",
            "leftReserve",
            "rightReserve",
            "collateral",
            "ondelta",
            "nonce",
        ],
        &[],
        operation_index,
        &data_path,
    )?;
    let left = nonempty_text(
        field(data, "leftEntity", operation_index, &data_path)?,
        operation_index,
        &format!("{data_path}.leftEntity"),
    )?;
    let right = nonempty_text(
        field(data, "rightEntity", operation_index, &data_path)?,
        operation_index,
        &format!("{data_path}.rightEntity"),
    )?;
    Ok(JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: optional_unsigned(value, "blockNumber", operation_index, path)?,
            block_hash: optional_metadata_hex(value, "blockHash", operation_index, path)?,
            transaction_hash: optional_metadata_hex(
                value,
                "transactionHash",
                operation_index,
                path,
            )?,
            log_index: optional_unsigned(value, "logIndex", operation_index, path)?,
            event_index: optional_unsigned(value, "eventIndex", operation_index, path)?,
        },
        left_entity: EntityId::parse(&left).map_err(|error| {
            invalid(
                operation_index,
                format!("{data_path}.leftEntity"),
                error.to_string(),
            )
        })?,
        right_entity: EntityId::parse(&right).map_err(|error| {
            invalid(
                operation_index,
                format!("{data_path}.rightEntity"),
                error.to_string(),
            )
        })?,
        token_id: token_id(
            field(data, "tokenId", operation_index, &data_path)?,
            operation_index,
            &format!("{data_path}.tokenId"),
        )?,
        left_reserve: decimal_bigint(
            &text(
                field(data, "leftReserve", operation_index, &data_path)?,
                operation_index,
                &format!("{data_path}.leftReserve"),
            )?,
            operation_index,
            &format!("{data_path}.leftReserve"),
        )?,
        right_reserve: decimal_bigint(
            &text(
                field(data, "rightReserve", operation_index, &data_path)?,
                operation_index,
                &format!("{data_path}.rightReserve"),
            )?,
            operation_index,
            &format!("{data_path}.rightReserve"),
        )?,
        collateral: decimal_bigint(
            &text(
                field(data, "collateral", operation_index, &data_path)?,
                operation_index,
                &format!("{data_path}.collateral"),
            )?,
            operation_index,
            &format!("{data_path}.collateral"),
        )?,
        ondelta: decimal_bigint(
            &text(
                field(data, "ondelta", operation_index, &data_path)?,
                operation_index,
                &format!("{data_path}.ondelta"),
            )?,
            operation_index,
            &format!("{data_path}.ondelta"),
        )?,
        nonce: unsigned(
            field(data, "nonce", operation_index, &data_path)?,
            operation_index,
            &format!("{data_path}.nonce"),
        )?,
    }))
}

fn decode_j_event_claim(
    value: &Map<String, Value>,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    exact_fields(
        value,
        &["jHeight", "jBlockHash", "events"],
        &["leftProof", "rightProof"],
        operation_index,
        path,
    )?;
    let events = field(value, "events", operation_index, path)?
        .as_array()
        .ok_or_else(|| invalid(operation_index, format!("{path}.events"), "ARRAY_REQUIRED"))?
        .iter()
        .enumerate()
        .map(|(index, event)| {
            let event_path = format!("{path}.events[{index}]");
            let event = object(event, operation_index, &event_path)?;
            decode_account_settled_event(event, operation_index, &event_path)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AccountTx::JEventClaim(JEventClaimTx {
        j_height: unsigned(
            field(value, "jHeight", operation_index, path)?,
            operation_index,
            &format!("{path}.jHeight"),
        )?,
        j_block_hash: fixed_hex(
            field(value, "jBlockHash", operation_index, path)?,
            operation_index,
            &format!("{path}.jBlockHash"),
        )?,
        events,
        left_proof: value
            .get("leftProof")
            .map(|proof| decode_j_claim_proof(proof, operation_index, &format!("{path}.leftProof")))
            .transpose()?,
        right_proof: value
            .get("rightProof")
            .map(|proof| {
                decode_j_claim_proof(proof, operation_index, &format!("{path}.rightProof"))
            })
            .transpose()?,
    }))
}

/// Decode one exact canonical `{type,data}` transaction from tagged Runtime JSON.
pub fn decode_account_tx_json(
    value: &Value,
    operation_index: u64,
) -> Result<AccountTx, AccountInputJsonError> {
    decode_account_tx_at(value, operation_index, "accountTx")
}

fn decode_account_tx_at(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<AccountTx, AccountInputJsonError> {
    let tx = object(value, operation_index, path)?;
    exact_fields(tx, &["type", "data"], &[], operation_index, path)?;
    let kind = nonempty_text(
        field(tx, "type", operation_index, path)?,
        operation_index,
        &format!("{path}.type"),
    )?;
    let data_path = format!("{path}.data");
    let data = object(
        field(tx, "data", operation_index, path)?,
        operation_index,
        &data_path,
    )?;
    match kind.as_str() {
        "direct_payment" => decode_direct_payment(data, operation_index, &data_path),
        "lending_fund" => decode_lending_fund(data, operation_index, &data_path),
        "lending_borrow_request" => {
            decode_lending_borrow_request(data, operation_index, &data_path)
        }
        "lending_repay" => decode_lending_repay(data, operation_index, &data_path),
        "lending_credit" => decode_lending_credit(data, operation_index, &data_path),
        "lending_close_request" => decode_lending_close_request(data, operation_index, &data_path),
        "lending_close_payout" => decode_lending_close_payout(data, operation_index, &data_path),
        "add_delta" => {
            exact_fields(data, &["tokenId"], &[], operation_index, &data_path)?;
            Ok(AccountTx::AddDelta {
                token_id: token_id(
                    field(data, "tokenId", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.tokenId"),
                )?,
            })
        }
        "set_credit_limit" => {
            exact_fields(
                data,
                &["tokenId", "amount"],
                &[],
                operation_index,
                &data_path,
            )?;
            Ok(AccountTx::SetCreditLimit {
                token_id: token_id(
                    field(data, "tokenId", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.tokenId"),
                )?,
                amount: tagged_bigint(
                    field(data, "amount", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.amount"),
                )?,
            })
        }
        "htlc_lock" => decode_htlc_lock(data, operation_index, &data_path),
        "htlc_resolve" => decode_htlc_resolve(data, operation_index, &data_path),
        "reserve_to_collateral" => decode_reserve_to_collateral(data, operation_index, &data_path),
        "request_collateral" => decode_request_collateral(data, operation_index, &data_path),
        "rebalance_refund" => decode_rebalance_refund(data, operation_index, &data_path),
        "rebalance_policy" => {
            exact_fields(
                data,
                &[
                    "tokenId",
                    "policyVersion",
                    "baseFee",
                    "liquidityFeeBps",
                    "gasFee",
                ],
                &[],
                operation_index,
                &data_path,
            )?;
            Ok(AccountTx::RebalancePolicy {
                token_id: u32_value(
                    field(data, "tokenId", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.tokenId"),
                )?,
                policy_version: unsigned(
                    field(data, "policyVersion", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.policyVersion"),
                )?,
                base_fee: tagged_bigint(
                    field(data, "baseFee", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.baseFee"),
                )?,
                liquidity_fee_bps: tagged_bigint(
                    field(data, "liquidityFeeBps", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.liquidityFeeBps"),
                )?,
                gas_fee: tagged_bigint(
                    field(data, "gasFee", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.gasFee"),
                )?,
            })
        }
        "swap_offer" => decode_swap_offer(data, operation_index, &data_path),
        "swap_cancel_request" => {
            exact_fields(data, &["offerId"], &[], operation_index, &data_path)?;
            Ok(AccountTx::SwapCancelRequest {
                offer_id: text(
                    field(data, "offerId", operation_index, &data_path)?,
                    operation_index,
                    &format!("{data_path}.offerId"),
                )?,
            })
        }
        "swap_resolve" => decode_swap_resolve(data, operation_index, &data_path),
        "cross_pull_lock" => Ok(AccountTx::CrossPullLock {
            data: canonical_object(
                field(tx, "data", operation_index, path)?,
                operation_index,
                &data_path,
            )?,
        }),
        "cross_pull_close" => Ok(AccountTx::CrossPullClose {
            data: canonical_object(
                field(tx, "data", operation_index, path)?,
                operation_index,
                &data_path,
            )?,
        }),
        "cross_pull_progress" => Ok(AccountTx::CrossPullProgress {
            data: canonical_object(
                field(tx, "data", operation_index, path)?,
                operation_index,
                &data_path,
            )?,
        }),
        "cross_swap_fill_ack" => Ok(AccountTx::CrossSwapFillAck {
            data: canonical_object(
                field(tx, "data", operation_index, path)?,
                operation_index,
                &data_path,
            )?,
        }),
        "settle_transition" => Ok(AccountTx::SettleTransition {
            data: canonical_object(
                field(tx, "data", operation_index, path)?,
                operation_index,
                &data_path,
            )?,
        }),
        "j_event_claim" => decode_j_event_claim(data, operation_index, &data_path),
        _ => Err(invalid(
            operation_index,
            format!("{path}.type"),
            format!("TX_UNSUPPORTED:{kind}"),
        )),
    }
}

fn decode_frame(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<(AccountFrame, [u8; 32]), AccountInputJsonError> {
    let frame = object(value, operation_index, path)?;
    exact_fields(
        frame,
        &[
            "height",
            "timestamp",
            "jHeight",
            "accountTxs",
            "prevFrameHash",
            "accountStateRoot",
            "stateHash",
        ],
        &[],
        operation_index,
        path,
    )?;
    let height = unsigned(
        field(frame, "height", operation_index, path)?,
        operation_index,
        &format!("{path}.height"),
    )?;
    if height == 0 {
        return Err(invalid(
            operation_index,
            format!("{path}.height"),
            "PEER_FRAME_HEIGHT_ZERO",
        ));
    }
    let previous = text(
        field(frame, "prevFrameHash", operation_index, path)?,
        operation_index,
        &format!("{path}.prevFrameHash"),
    )?;
    if height == 1 {
        if previous != "genesis" {
            return Err(invalid(
                operation_index,
                format!("{path}.prevFrameHash"),
                "GENESIS_HASH_REQUIRED",
            ));
        }
    } else {
        fixed_hex::<32>(
            field(frame, "prevFrameHash", operation_index, path)?,
            operation_index,
            &format!("{path}.prevFrameHash"),
        )?;
    }
    let tx_values = field(frame, "accountTxs", operation_index, path)?
        .as_array()
        .ok_or_else(|| {
            invalid(
                operation_index,
                format!("{path}.accountTxs"),
                "ARRAY_REQUIRED",
            )
        })?;
    let txs = tx_values
        .iter()
        .enumerate()
        .map(|(index, tx)| {
            decode_account_tx_at(tx, operation_index, &format!("{path}.accountTxs[{index}]"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let state_hash = fixed_hex(
        field(frame, "stateHash", operation_index, path)?,
        operation_index,
        &format!("{path}.stateHash"),
    )?;
    Ok((
        AccountFrame {
            height,
            timestamp: unsigned(
                field(frame, "timestamp", operation_index, path)?,
                operation_index,
                &format!("{path}.timestamp"),
            )?,
            j_height: unsigned(
                field(frame, "jHeight", operation_index, path)?,
                operation_index,
                &format!("{path}.jHeight"),
            )?,
            txs,
            prev_frame_hash: previous,
            account_state_root: fixed_hex(
                field(frame, "accountStateRoot", operation_index, path)?,
                operation_index,
                &format!("{path}.accountStateRoot"),
            )?,
        },
        state_hash,
    ))
}

fn decode_dispute(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<CounterpartyDispute, AccountInputJsonError> {
    let dispute = object(value, operation_index, path)?;
    exact_fields(
        dispute,
        &["hash", "proofBodyHash", "proofNonce", "proposerIsLeft"],
        &["hanko"],
        operation_index,
        path,
    )?;
    Ok(CounterpartyDispute {
        hanko: dispute
            .get("hanko")
            .map(|value| hex_bytes(value, operation_index, &format!("{path}.hanko")))
            .transpose()?,
        hash: fixed_hex(
            field(dispute, "hash", operation_index, path)?,
            operation_index,
            &format!("{path}.hash"),
        )?,
        proof_body_hash: fixed_hex(
            field(dispute, "proofBodyHash", operation_index, path)?,
            operation_index,
            &format!("{path}.proofBodyHash"),
        )?,
        nonce: unsigned(
            field(dispute, "proofNonce", operation_index, path)?,
            operation_index,
            &format!("{path}.proofNonce"),
        )?,
        proposer_is_left: boolean(
            field(dispute, "proposerIsLeft", operation_index, path)?,
            operation_index,
            &format!("{path}.proposerIsLeft"),
        )?,
    })
}

fn decode_ack(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<IncomingAck, AccountInputJsonError> {
    let ack = object(value, operation_index, path)?;
    exact_fields(
        ack,
        &["height", "frameHash"],
        &["frameHanko", "disputeHanko"],
        operation_index,
        path,
    )?;
    let height = unsigned(
        field(ack, "height", operation_index, path)?,
        operation_index,
        &format!("{path}.height"),
    )?;
    if height == 0 {
        return Err(invalid(
            operation_index,
            format!("{path}.height"),
            "ACK_HEIGHT_ZERO",
        ));
    }
    Ok(IncomingAck {
        height,
        frame_hash: fixed_hex(
            field(ack, "frameHash", operation_index, path)?,
            operation_index,
            &format!("{path}.frameHash"),
        )?,
        frame_hanko: ack
            .get("frameHanko")
            .map(|value| hex_bytes(value, operation_index, &format!("{path}.frameHanko")))
            .transpose()?,
        dispute: ack
            .get("disputeHanko")
            .map(|value| decode_dispute(value, operation_index, &format!("{path}.disputeHanko")))
            .transpose()?,
    })
}

fn decode_board_hanko_refresh(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<BoardHankoRefreshInput, AccountInputJsonError> {
    let refresh = object(value, operation_index, path)?;
    exact_fields(
        refresh,
        &[
            "height",
            "frameHash",
            "boardActivationJHeight",
            "boardActivationLogIndex",
        ],
        &["frameHanko", "disputeHanko"],
        operation_index,
        path,
    )?;
    let height = unsigned(
        field(refresh, "height", operation_index, path)?,
        operation_index,
        &format!("{path}.height"),
    )?;
    if height == 0 {
        return Err(invalid(
            operation_index,
            format!("{path}.height"),
            "ACK_HEIGHT_ZERO",
        ));
    }
    Ok(BoardHankoRefreshInput {
        height,
        frame_hash: fixed_hex(
            field(refresh, "frameHash", operation_index, path)?,
            operation_index,
            &format!("{path}.frameHash"),
        )?,
        frame_hanko: refresh
            .get("frameHanko")
            .map(|value| hex_bytes(value, operation_index, &format!("{path}.frameHanko")))
            .transpose()?,
        dispute: refresh
            .get("disputeHanko")
            .map(|value| decode_dispute(value, operation_index, &format!("{path}.disputeHanko")))
            .transpose()?,
        board_activation_j_height: unsigned(
            field(refresh, "boardActivationJHeight", operation_index, path)?,
            operation_index,
            &format!("{path}.boardActivationJHeight"),
        )?,
        board_activation_log_index: unsigned(
            field(refresh, "boardActivationLogIndex", operation_index, path)?,
            operation_index,
            &format!("{path}.boardActivationLogIndex"),
        )?,
    })
}

fn decode_proposal(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<IncomingFrame, AccountInputJsonError> {
    let proposal = object(value, operation_index, path)?;
    exact_fields(
        proposal,
        &["frame"],
        &["frameHanko", "disputeHanko"],
        operation_index,
        path,
    )?;
    let (frame, state_hash) = decode_frame(
        field(proposal, "frame", operation_index, path)?,
        operation_index,
        &format!("{path}.frame"),
    )?;
    Ok(IncomingFrame {
        frame,
        state_hash,
        frame_hanko: proposal
            .get("frameHanko")
            .map(|value| hex_bytes(value, operation_index, &format!("{path}.frameHanko")))
            .transpose()?,
        dispute: proposal
            .get("disputeHanko")
            .map(|value| decode_dispute(value, operation_index, &format!("{path}.disputeHanko")))
            .transpose()?,
    })
}

fn decode_domain(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<AccountDomain, AccountInputJsonError> {
    let domain = object(value, operation_index, path)?;
    exact_fields(
        domain,
        &["chainId", "depositoryAddress"],
        &[],
        operation_index,
        path,
    )?;
    let address_text = nonempty_text(
        field(domain, "depositoryAddress", operation_index, path)?,
        operation_index,
        &format!("{path}.depositoryAddress"),
    )?;
    let address = DepositoryAddress::parse(&address_text).map_err(|error| {
        invalid(
            operation_index,
            format!("{path}.depositoryAddress"),
            error.to_string(),
        )
    })?;
    AccountDomain::new(
        unsigned(
            field(domain, "chainId", operation_index, path)?,
            operation_index,
            &format!("{path}.chainId"),
        )?,
        address,
    )
    .map_err(|error| invalid(operation_index, path, error.to_string()))
}

fn decode_dispute_config(
    value: &Value,
    operation_index: u64,
    path: &str,
) -> Result<AccountDisputeConfig, AccountInputJsonError> {
    let config = object(value, operation_index, path)?;
    exact_fields(
        config,
        &["leftResponseSeconds", "rightResponseSeconds"],
        &[],
        operation_index,
        path,
    )?;
    AccountDisputeConfig::new(
        unsigned(
            field(config, "leftResponseSeconds", operation_index, path)?,
            operation_index,
            &format!("{path}.leftResponseSeconds"),
        )?,
        unsigned(
            field(config, "rightResponseSeconds", operation_index, path)?,
            operation_index,
            &format!("{path}.rightResponseSeconds"),
        )?,
    )
    .map_err(|error| invalid(operation_index, path, error.to_string()))
}

/// Decode one Account peer input (`EntityTx.data`) for a known owning Entity.
pub fn decode_account_input_row(
    owner_entity_id: &str,
    operation_index: u64,
    value: &Value,
) -> Result<AccountInputRow, AccountInputJsonError> {
    let path = "accountInput";
    let input = object(value, operation_index, path)?;
    let kind = nonempty_text(
        field(input, "kind", operation_index, path)?,
        operation_index,
        "accountInput.kind",
    )?;
    let (required, optional): (&[&str], &[&str]) = match kind.as_str() {
        "frame" => (
            &[
                "fromEntityId",
                "toEntityId",
                "domain",
                "disputeConfig",
                "kind",
                "proposal",
            ],
            &["watchSeed"],
        ),
        "ack" => (
            &[
                "fromEntityId",
                "toEntityId",
                "domain",
                "disputeConfig",
                "kind",
                "ack",
            ],
            &["watchSeed"],
        ),
        "ack_frame" => (
            &[
                "fromEntityId",
                "toEntityId",
                "domain",
                "disputeConfig",
                "kind",
                "ack",
                "proposal",
            ],
            &["watchSeed"],
        ),
        "dispute" => (
            &[
                "fromEntityId",
                "toEntityId",
                "domain",
                "disputeConfig",
                "kind",
                "disputeHanko",
            ],
            &["watchSeed"],
        ),
        "board_hanko_refresh" => (
            &[
                "fromEntityId",
                "toEntityId",
                "domain",
                "disputeConfig",
                "kind",
                "boardHankoRefresh",
            ],
            &["watchSeed"],
        ),
        _ => {
            return Err(invalid(
                operation_index,
                "accountInput.kind",
                format!("INPUT_KIND_UNSUPPORTED:{kind}"),
            ));
        }
    };
    exact_fields(input, required, optional, operation_index, path)?;
    let owner = EntityId::parse(owner_entity_id)
        .map_err(|error| invalid(operation_index, "ownerEntityId", error.to_string()))?;
    let from_text = nonempty_text(
        field(input, "fromEntityId", operation_index, path)?,
        operation_index,
        "accountInput.fromEntityId",
    )?;
    let to_text = nonempty_text(
        field(input, "toEntityId", operation_index, path)?,
        operation_index,
        "accountInput.toEntityId",
    )?;
    let from = EntityId::parse(&from_text).map_err(|error| {
        invalid(
            operation_index,
            "accountInput.fromEntityId",
            error.to_string(),
        )
    })?;
    let to = EntityId::parse(&to_text).map_err(|error| {
        invalid(
            operation_index,
            "accountInput.toEntityId",
            error.to_string(),
        )
    })?;
    if to != owner {
        return Err(invalid(
            operation_index,
            "accountInput.toEntityId",
            "OWNER_MISMATCH",
        ));
    }
    if from == to {
        return Err(invalid(
            operation_index,
            "accountInput.fromEntityId",
            "SELF_ACCOUNT_FORBIDDEN",
        ));
    }
    let account_id = AccountId::from_bytes(*from.as_bytes());
    let envelope = AccountPeerEnvelope {
        from_entity_id: *from.as_bytes(),
        to_entity_id: *to.as_bytes(),
        domain: decode_domain(
            field(input, "domain", operation_index, path)?,
            operation_index,
            "accountInput.domain",
        )?,
        dispute_config: decode_dispute_config(
            field(input, "disputeConfig", operation_index, path)?,
            operation_index,
            "accountInput.disputeConfig",
        )?,
        watch_seed: input
            .get("watchSeed")
            .map(|value| {
                let value = nonempty_text(value, operation_index, "accountInput.watchSeed")?;
                WatchSeed::parse(&value).map_err(|error| {
                    invalid(operation_index, "accountInput.watchSeed", error.to_string())
                })
            })
            .transpose()?,
    };
    let kind = match kind.as_str() {
        "frame" => AccountInputKind::Frame(Box::new(decode_proposal(
            field(input, "proposal", operation_index, path)?,
            operation_index,
            "accountInput.proposal",
        )?)),
        "ack" => AccountInputKind::Ack(decode_ack(
            field(input, "ack", operation_index, path)?,
            operation_index,
            "accountInput.ack",
        )?),
        "ack_frame" => AccountInputKind::AckFrame {
            ack: decode_ack(
                field(input, "ack", operation_index, path)?,
                operation_index,
                "accountInput.ack",
            )?,
            frame: Box::new(decode_proposal(
                field(input, "proposal", operation_index, path)?,
                operation_index,
                "accountInput.proposal",
            )?),
        },
        "dispute" => AccountInputKind::Dispute(decode_dispute(
            field(input, "disputeHanko", operation_index, path)?,
            operation_index,
            "accountInput.disputeHanko",
        )?),
        "board_hanko_refresh" => AccountInputKind::BoardHankoRefresh(decode_board_hanko_refresh(
            field(input, "boardHankoRefresh", operation_index, path)?,
            operation_index,
            "accountInput.boardHankoRefresh",
        )?),
        _ => {
            return Err(invalid(
                operation_index,
                "accountInput.kind",
                "INPUT_KIND_UNREACHABLE",
            ));
        }
    };
    Ok(AccountInputRow {
        operation_index,
        account_id,
        genesis_policy: None,
        // Peer bytes cannot prove that a peer is unregistered. Parent Entity
        // must resolve this row from its certified board registry before the
        // Account reducer may execute it.
        certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Unresolved,
        local_certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Unresolved,
        input: AccountPeerInput { envelope, kind },
    })
}

/// Decode the exact outer Entity transaction used by canonical HLT recordings.
pub fn decode_entity_account_input_row(
    owner_entity_id: &str,
    operation_index: u64,
    value: &Value,
) -> Result<AccountInputRow, AccountInputJsonError> {
    let tx = object(value, operation_index, "entityTx")?;
    exact_fields(tx, &["type", "data"], &[], operation_index, "entityTx")?;
    if field(tx, "type", operation_index, "entityTx")?.as_str() != Some("accountInput") {
        return Err(invalid(
            operation_index,
            "entityTx.type",
            "ACCOUNT_INPUT_REQUIRED",
        ));
    }
    decode_account_input_row(
        owner_entity_id,
        operation_index,
        field(tx, "data", operation_index, "entityTx")?,
    )
}

/// Preserve source order and isolate every malformed row as its own result.
pub fn decode_entity_account_input_rows(
    owner_entity_id: &str,
    first_operation_index: u64,
    values: &[Value],
) -> Vec<Result<AccountInputRow, AccountInputJsonError>> {
    values
        .iter()
        .enumerate()
        .map(|(offset, value)| {
            let offset = u64::try_from(offset).map_err(|_| {
                invalid(
                    first_operation_index,
                    "entityTx",
                    "OPERATION_INDEX_EXCEEDED",
                )
            })?;
            let operation_index = first_operation_index.checked_add(offset).ok_or_else(|| {
                invalid(
                    first_operation_index,
                    "entityTx",
                    "OPERATION_INDEX_EXCEEDED",
                )
            })?;
            decode_entity_account_input_row(owner_entity_id, operation_index, value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    fn address(byte: &str) -> String {
        format!("0x{}", byte.repeat(20))
    }

    fn big(value: &str) -> Value {
        json!({ "__xlnType": "BigInt", "value": value })
    }

    fn proposal() -> Value {
        json!({
            "frame": {
                "height": 1,
                "timestamp": 1_700_000_000_000_u64,
                "jHeight": 2,
                "accountTxs": [{
                    "type": "htlc_lock",
                    "data": {
                        "lockId": id("44"),
                        "hashlock": id("55"),
                        "timelock": big("1700000100000"),
                        "revealBeforeHeight": 99,
                        "amount": big("1"),
                        "tokenId": 1,
                        "deliveryMode": "async"
                    }
                }],
                "prevFrameHash": "genesis",
                "accountStateRoot": id("66"),
                "stateHash": id("77")
            },
            "frameHanko": "0x0102"
        })
    }

    fn ack() -> Value {
        json!({
            "height": 1,
            "frameHash": id("77"),
            "frameHanko": "0x0304"
        })
    }

    fn dispute() -> Value {
        json!({
            "hash": id("91"),
            "proofBodyHash": id("92"),
            "proofNonce": 3,
            "proposerIsLeft": true,
            "hanko": "0x0102"
        })
    }

    fn peer(owner: &str, counterparty: &str, kind: &str) -> Value {
        let mut value = json!({
            "fromEntityId": counterparty,
            "toEntityId": owner,
            "domain": { "chainId": 31337, "depositoryAddress": address("aa") },
            "disputeConfig": { "leftResponseSeconds": 3600, "rightResponseSeconds": 86400 },
            "watchSeed": id("88"),
            "kind": kind
        });
        if let Some(row) = value.as_object_mut() {
            if kind == "ack" || kind == "ack_frame" {
                row.insert("ack".to_string(), ack());
            }
            if kind == "frame" || kind == "ack_frame" {
                row.insert("proposal".to_string(), proposal());
            }
        }
        value
    }

    fn entity_tx(owner: &str, counterparty: &str, kind: &str) -> Value {
        json!({ "type": "accountInput", "data": peer(owner, counterparty, kind) })
    }

    #[test]
    fn ack_frame_decodes_to_one_atomic_row() {
        let owner = id("11");
        let counterparty = id("22");
        let decoded = decode_entity_account_input_row(
            &owner,
            7,
            &entity_tx(&owner, &counterparty, "ack_frame"),
        );
        let row = match decoded {
            Ok(row) => row,
            Err(error) => panic!("decode failed: {error}"),
        };
        assert_eq!(row.operation_index, 7);
        let expected_account_id = match EntityId::parse(&counterparty) {
            Ok(entity_id) => *entity_id.as_bytes(),
            Err(error) => panic!("test entity id invalid: {error}"),
        };
        assert_eq!(row.account_id.as_bytes(), &expected_account_id);
        match row.input.kind {
            AccountInputKind::AckFrame { ack, frame } => {
                assert_eq!(ack.height, 1);
                assert_eq!(frame.frame.txs.len(), 1);
                assert!(matches!(frame.frame.txs[0], AccountTx::HtlcLock(_)));
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn malformed_row_does_not_hide_valid_neighbours() {
        let owner = id("11");
        let counterparty = id("22");
        let mut malformed = entity_tx(&owner, &counterparty, "ack");
        if let Some(data) = malformed.get_mut("data").and_then(Value::as_object_mut) {
            data.insert("unexpected".to_string(), Value::Bool(true));
        }
        let rows = decode_entity_account_input_rows(
            &owner,
            40,
            &[
                entity_tx(&owner, &counterparty, "ack"),
                malformed,
                entity_tx(&owner, &counterparty, "frame"),
            ],
        );
        assert!(rows[0].as_ref().is_ok_and(|row| row.operation_index == 40));
        assert!(
            rows[1]
                .as_ref()
                .is_err_and(|error| error.operation_index == 41)
        );
        assert!(rows[2].as_ref().is_ok_and(|row| row.operation_index == 42));
    }

    #[test]
    fn standalone_dispute_and_board_refresh_decode_without_payload_authority() {
        let owner = id("11");
        let counterparty = id("22");
        let mut dispute_input = peer(&owner, &counterparty, "dispute");
        dispute_input
            .as_object_mut()
            .expect("dispute input object")
            .insert("disputeHanko".into(), dispute());
        let dispute_row =
            decode_account_input_row(&owner, 12, &dispute_input).expect("standalone dispute row");
        assert!(matches!(
            dispute_row.certified_board_authority,
            xln_rscore_batch::PeerBoardAuthority::Unresolved
        ));
        assert!(matches!(
            dispute_row.input.kind,
            AccountInputKind::Dispute(_)
        ));

        let mut refresh_input = peer(&owner, &counterparty, "board_hanko_refresh");
        refresh_input
            .as_object_mut()
            .expect("refresh input object")
            .insert(
                "boardHankoRefresh".into(),
                json!({
                    "height": 4,
                    "frameHash": id("77"),
                    "frameHanko": "0x0304",
                    "disputeHanko": dispute(),
                    "boardActivationJHeight": 9,
                    "boardActivationLogIndex": 2
                }),
            );
        let refresh_row =
            decode_account_input_row(&owner, 13, &refresh_input).expect("board refresh row");
        assert!(matches!(
            refresh_row.input.kind,
            AccountInputKind::BoardHankoRefresh(BoardHankoRefreshInput {
                height: 4,
                board_activation_j_height: 9,
                board_activation_log_index: 2,
                ..
            })
        ));

        refresh_input
            .as_object_mut()
            .expect("refresh input object")
            .insert("certifiedBoardHash".into(), Value::String(id("aa")));
        assert!(decode_account_input_row(&owner, 14, &refresh_input).is_err());
    }

    #[test]
    fn swap_resolve_preserves_false_and_every_optional_amount() {
        let tx = json!({
            "type": "swap_resolve",
            "data": {
                "offerId": "offer-1",
                "fillRatio": 3333,
                "fillNumerator": big("1"),
                "fillDenominator": big("3"),
                "cancelRemainder": false,
                "comment": "partial",
                "feeTokenId": 1,
                "feeAmount": big("2"),
                "executionGiveAmount": big("100"),
                "executionWantAmount": big("200"),
                "restingGiveTokenId": 1,
                "restingWantTokenId": 2,
                "restingPriceTicks": big("300"),
                "restingGiveAmount": big("400"),
                "restingWantAmount": big("500"),
                "restingQuantizedGive": big("600"),
                "restingQuantizedWant": big("700")
            }
        });
        let decoded = decode_account_tx_json(&tx, 0);
        match decoded {
            Ok(AccountTx::SwapResolve {
                cancel_remainder,
                fill_numerator,
                resting_want_token_id,
                ..
            }) => {
                assert!(!cancel_remainder);
                assert_eq!(fill_numerator, Some(BigInt::from(1)));
                assert_eq!(resting_want_token_id, Some(2));
            }
            Ok(other) => panic!("wrong tx: {other:?}"),
            Err(error) => panic!("decode failed: {error}"),
        }
    }

    #[test]
    fn noncanonical_bigint_is_loud_and_cross_j_offer_decodes() {
        let payment = json!({
            "type": "direct_payment",
            "data": {
                "tokenId": 1,
                "amount": big("01"),
                "route": [],
                "fromEntityId": id("11"),
                "toEntityId": id("22"),
                "deliveryMode": "direct"
            }
        });
        assert!(decode_account_tx_json(&payment, 4).is_err());

        let offer = json!({
            "type": "swap_offer",
            "data": {
                "offerId": "offer-1",
                "giveTokenId": 1,
                "giveTokenDecimals": 6,
                "giveAmount": big("1"),
                "wantTokenId": 2,
                "wantTokenDecimals": 6,
                "wantAmount": big("2"),
                "maxFee": big("0"),
                "minNetReceive": big("1"),
                "crossJurisdiction": {}
            }
        });
        assert!(matches!(
            decode_account_tx_json(&offer, 5),
            Ok(AccountTx::SwapOffer {
                cross_jurisdiction: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn account_settled_j_event_claim_decodes_with_empty_proofs() {
        let claim = json!({
            "type": "j_event_claim",
            "data": {
                "jHeight": 5,
                "jBlockHash": id("99"),
                "events": [{
                    "type": "AccountSettled",
                    "blockNumber": 100,
                    "logIndex": 2,
                    "data": {
                        "leftEntity": id("11"),
                        "rightEntity": id("22"),
                        "tokenId": 1,
                        "leftReserve": "10",
                        "rightReserve": "20",
                        "collateral": "30",
                        "ondelta": "-5",
                        "nonce": 7
                    }
                }],
                "leftProof": { "version": 1, "nodes": [] }
            }
        });
        let decoded = decode_account_tx_json(&claim, 9);
        match decoded {
            Ok(AccountTx::JEventClaim(claim)) => {
                assert_eq!(claim.events.len(), 1);
                assert!(claim.left_proof.is_some());
            }
            Ok(other) => panic!("wrong tx: {other:?}"),
            Err(error) => panic!("decode failed: {error}"),
        }
    }
}
