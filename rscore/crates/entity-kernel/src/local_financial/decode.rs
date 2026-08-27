use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{CanonicalValue, DeliveryMode, TokenId};
use xln_rscore_protocol::encode_canonical_consensus_bytes;

use crate::{CanonicalEntityTx, EntityKernelError, EntityTxKind, OriginatedHtlcDeliveryMode};

use super::types::{
    DirectPaymentEntityTx, HtlcPaymentEntityTx, LocalEntityFinancialTx, PlaceSwapOfferEntityTx,
    ProposeCancelSwapEntityTx,
};

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn invalid(kind: &'static str, detail: &'static str) -> EntityKernelError {
    EntityKernelError::local(kind, detail)
}

fn object<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(entries) => Ok(entries),
        _ => Err(invalid(kind, "DATA_OBJECT")),
    }
}

fn exact_fields(
    entries: &[(String, CanonicalValue)],
    required: &[&str],
    optional: &[&str],
    kind: &'static str,
) -> Result<(), EntityKernelError> {
    if required
        .iter()
        .any(|field| !entries.iter().any(|(key, _)| key == field))
        || entries
            .iter()
            .any(|(key, _)| !required.iter().chain(optional).any(|field| key == field))
    {
        return Err(invalid(kind, "DATA_FIELDS"));
    }
    Ok(())
}

fn field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(kind, "DATA_FIELDS"))
}

fn optional_field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
) -> Option<&'a CanonicalValue> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn string(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(kind, detail)),
    }
}

fn entity_id(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<String, EntityKernelError> {
    let value = string(value, kind, detail)?;
    let valid = value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64
            && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
            && value == value.to_lowercase()
    });
    valid.then_some(value).ok_or_else(|| invalid(kind, detail))
}

fn bigint(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<BigInt, EntityKernelError> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(kind, detail)),
    }
}

fn u64_number(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = value else {
        return Err(invalid(kind, detail));
    };
    value
        .as_str()
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= JS_MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(kind, detail))
}

fn u32_number(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<u32, EntityKernelError> {
    u32::try_from(u64_number(value, kind, detail)?).map_err(|_| invalid(kind, detail))
}

fn token(value: &CanonicalValue, kind: &'static str) -> Result<TokenId, EntityKernelError> {
    TokenId::new(u32_number(value, kind, "TOKEN_ID")?).map_err(|_| invalid(kind, "TOKEN_ID"))
}

fn string_array(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<Vec<String>, EntityKernelError> {
    let CanonicalValue::Array(values) = value else {
        return Err(invalid(kind, detail));
    };
    values
        .iter()
        .map(|value| entity_id(value, kind, detail))
        .collect()
}

fn optional_string(
    entries: &[(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
    detail: &'static str,
) -> Result<Option<String>, EntityKernelError> {
    optional_field(entries, name)
        .map(|value| string(value, kind, detail))
        .transpose()
}

fn optional_bigint(
    entries: &[(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
    detail: &'static str,
) -> Result<Option<BigInt>, EntityKernelError> {
    optional_field(entries, name)
        .map(|value| bigint(value, kind, detail))
        .transpose()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2 + 2);
    value.push_str("0x");
    for byte in bytes {
        value.push(char::from(DIGITS[usize::from(byte >> 4)]));
        value.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    value
}

fn raw_tx_hash(tx: &CanonicalEntityTx) -> Result<String, EntityKernelError> {
    let value = CanonicalValue::Object(vec![
        (
            "type".into(),
            CanonicalValue::String(tx.kind.as_str().into()),
        ),
        ("data".into(), tx.data.clone()),
    ]);
    let bytes = encode_canonical_consensus_bytes(&value)
        .map_err(|_| invalid("htlcPayment", "TX_HASH_ENCODING"))?;
    Ok(hex(&Keccak256::digest(bytes)))
}

fn direct_payment(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "directPayment";
    let data = object(&tx.data, KIND)?;
    exact_fields(
        data,
        &[
            "targetEntityId",
            "tokenId",
            "amount",
            "route",
            "deliveryMode",
        ],
        &["description", "trustedGatewayEntityId"],
        KIND,
    )?;
    let mode = match string(field(data, "deliveryMode", KIND)?, KIND, "DELIVERY_MODE")?.as_str() {
        "direct" => DeliveryMode::Direct,
        "trusted" => DeliveryMode::Trusted,
        _ => return Err(invalid(KIND, "DELIVERY_MODE")),
    };
    let trusted_gateway_entity_id = optional_field(data, "trustedGatewayEntityId")
        .map(|value| entity_id(value, KIND, "TRUSTED_GATEWAY"))
        .transpose()?;
    if (mode == DeliveryMode::Trusted) != trusted_gateway_entity_id.is_some() {
        return Err(invalid(KIND, "TRUSTED_GATEWAY"));
    }
    Ok(LocalEntityFinancialTx::DirectPayment(
        DirectPaymentEntityTx {
            target_entity_id: entity_id(field(data, "targetEntityId", KIND)?, KIND, "TARGET")?,
            token_id: token(field(data, "tokenId", KIND)?, KIND)?,
            amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
            route: string_array(field(data, "route", KIND)?, KIND, "ROUTE")?,
            description: optional_string(data, "description", KIND, "DESCRIPTION")?,
            delivery_mode: mode,
            trusted_gateway_entity_id,
        },
    ))
}

fn htlc_payment(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "htlcPayment";
    let data = object(&tx.data, KIND)?;
    exact_fields(
        data,
        &[
            "targetEntityId",
            "tokenId",
            "amount",
            "maxSenderDebit",
            "route",
            "deliveryMode",
        ],
        &["description", "startedAtMs", "hashlock"],
        KIND,
    )?;
    let mode = match string(field(data, "deliveryMode", KIND)?, KIND, "DELIVERY_MODE")?.as_str() {
        "instant" => OriginatedHtlcDeliveryMode::Instant,
        "async" => OriginatedHtlcDeliveryMode::Async,
        _ => return Err(invalid(KIND, "DELIVERY_MODE")),
    };
    Ok(LocalEntityFinancialTx::HtlcPayment(HtlcPaymentEntityTx {
        target_entity_id: entity_id(field(data, "targetEntityId", KIND)?, KIND, "TARGET")?,
        token_id: token(field(data, "tokenId", KIND)?, KIND)?,
        amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
        max_sender_debit: bigint(
            field(data, "maxSenderDebit", KIND)?,
            KIND,
            "MAX_SENDER_DEBIT",
        )?,
        route: string_array(field(data, "route", KIND)?, KIND, "ROUTE")?,
        description: optional_string(data, "description", KIND, "DESCRIPTION")?,
        delivery_mode: mode,
        started_at_ms: optional_field(data, "startedAtMs")
            .map(|value| u64_number(value, KIND, "STARTED_AT"))
            .transpose()?,
        hashlock: optional_string(data, "hashlock", KIND, "HASHLOCK")?,
        tx_hash: raw_tx_hash(tx)?,
    }))
}

fn place_swap_offer(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "placeSwapOffer";
    let data = object(&tx.data, KIND)?;
    exact_fields(
        data,
        &[
            "counterpartyEntityId",
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
        &["priceTicks", "timeInForce"],
        KIND,
    )?;
    let time_in_force = optional_field(data, "timeInForce")
        .map(|value| u64_number(value, KIND, "TIME_IN_FORCE"))
        .transpose()?
        .map(|value| u8::try_from(value).map_err(|_| invalid(KIND, "TIME_IN_FORCE")))
        .transpose()?;
    if time_in_force.is_some_and(|value| value > 2) {
        return Err(invalid(KIND, "TIME_IN_FORCE"));
    }
    Ok(LocalEntityFinancialTx::PlaceSwapOffer(
        PlaceSwapOfferEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY",
            )?,
            offer_id: string(field(data, "offerId", KIND)?, KIND, "OFFER_ID")?,
            give_token_id: u32_number(field(data, "giveTokenId", KIND)?, KIND, "GIVE_TOKEN")?,
            give_token_decimals: u32_number(
                field(data, "giveTokenDecimals", KIND)?,
                KIND,
                "GIVE_DECIMALS",
            )?,
            give_amount: bigint(field(data, "giveAmount", KIND)?, KIND, "GIVE_AMOUNT")?,
            want_token_id: u32_number(field(data, "wantTokenId", KIND)?, KIND, "WANT_TOKEN")?,
            want_token_decimals: u32_number(
                field(data, "wantTokenDecimals", KIND)?,
                KIND,
                "WANT_DECIMALS",
            )?,
            want_amount: bigint(field(data, "wantAmount", KIND)?, KIND, "WANT_AMOUNT")?,
            max_fee: bigint(field(data, "maxFee", KIND)?, KIND, "MAX_FEE")?,
            min_net_receive: bigint(field(data, "minNetReceive", KIND)?, KIND, "MIN_NET_RECEIVE")?,
            price_ticks: optional_bigint(data, "priceTicks", KIND, "PRICE_TICKS")?,
            time_in_force,
        },
    ))
}

fn cancel_swap(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "proposeCancelSwap";
    let data = object(&tx.data, KIND)?;
    exact_fields(data, &["counterpartyEntityId", "offerId"], &[], KIND)?;
    Ok(LocalEntityFinancialTx::ProposeCancelSwap(
        ProposeCancelSwapEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY",
            )?,
            offer_id: string(field(data, "offerId", KIND)?, KIND, "OFFER_ID")?,
        },
    ))
}

pub fn decode_local_entity_financial_tx(
    tx: &CanonicalEntityTx,
) -> Result<Option<LocalEntityFinancialTx>, EntityKernelError> {
    match tx.kind {
        EntityTxKind::DirectPayment => direct_payment(tx).map(Some),
        EntityTxKind::HtlcPayment => htlc_payment(tx).map(Some),
        EntityTxKind::PlaceSwapOffer => place_swap_offer(tx).map(Some),
        EntityTxKind::ProposeCancelSwap => cancel_swap(tx).map(Some),
        _ => Ok(None),
    }
}
