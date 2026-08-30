use std::cmp::Ordering;
use std::collections::BTreeSet;

use num_bigint::{BigInt, Sign};
use serde_json::{Map, Value};
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::CanonicalValue;

use super::event_types::{
    AccountSettledEvent, ExternalAllowance, ExternalTokenBalance, JEventMetadata,
    JurisdictionEvent, ProofBody,
};
use super::event_value::canonical_event_data_value;
use crate::StateError;
use crate::j_claims::codec::j_error;

pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn canonical_events_hash(events: &[JurisdictionEvent]) -> Result<[u8; 32], StateError> {
    let ordered = ordered_events(events)?;
    let keys = ordered
        .iter()
        .map(|(event, _)| canonical_event_key(event))
        .collect::<Result<Vec<_>, _>>()?;
    let json = serde_json::to_string(&keys)
        .map_err(|error| j_error(format!("JURISDICTION_EVENT_JSON:{error}")))?;
    Ok(Keccak256::digest(json.as_bytes()).into())
}

pub fn canonical_events(
    events: &[JurisdictionEvent],
) -> Result<Vec<JurisdictionEvent>, StateError> {
    if events.is_empty() {
        return Err(j_error("ACCOUNT_J_CLAIM_EVENTS_INVALID"));
    }
    let ordered = ordered_events(events)?;
    let mut seen = BTreeSet::new();
    for (event, _) in &ordered {
        if !seen.insert(canonical_event_key(event)?) {
            return Err(j_error("ACCOUNT_J_CLAIM_EVENT_DUPLICATE"));
        }
    }
    Ok(ordered.into_iter().map(|(event, _)| event).collect())
}

fn ordered_events(
    events: &[JurisdictionEvent],
) -> Result<Vec<(JurisdictionEvent, String)>, StateError> {
    let mut ordered = events
        .iter()
        .map(|event| {
            validate_event(event)?;
            Ok((event.clone(), payload_key(event)?))
        })
        .collect::<Result<Vec<_>, StateError>>()?;
    ordered.sort_by(|(left, left_payload), (right, right_payload)| {
        compare_metadata(left.metadata(), right.metadata())
            .then_with(|| left_payload.cmp(right_payload))
    });
    Ok(ordered)
}

pub(crate) fn validate_event(event: &JurisdictionEvent) -> Result<(), StateError> {
    validate_metadata(event.metadata())?;
    match event {
        JurisdictionEvent::AccountSettled(value) => validate_account_settled(value),
        JurisdictionEvent::FoundationBootstrapped(_) => Ok(()),
        JurisdictionEvent::EntityRegistered(_) => Ok(()),
        JurisdictionEvent::BoardActivated(value) => require_positive(
            &value.previous_board_valid_until,
            "BOARD_PREVIOUS_VALID_UNTIL",
        ),
        JurisdictionEvent::ReserveUpdated(value) => {
            validate_entity(&value.entity)?;
            validate_i64(value.token_id, "RESERVE_TOKEN_ID")
        }
        JurisdictionEvent::ExternalWalletSnapshot(value) => {
            validate_entity(&value.entity_id)?;
            validate_wallet_order(&value.token_balances, &value.allowances)
        }
        JurisdictionEvent::ExternalWalletDelta(value) => {
            validate_entity(&value.entity_id)?;
            validate_optional_i64(value.token_id, "WALLET_TOKEN_ID")?;
            let allowance_pair = value.spender.is_some() == value.allowance.is_some();
            if !allowance_pair || (value.balance_delta.is_none() && value.allowance.is_none()) {
                return Err(j_error("EXTERNAL_WALLET_DELTA_INVALID"));
            }
            Ok(())
        }
        JurisdictionEvent::SecretRevealed(value) => {
            if value.revealer.to_lowercase() != value.revealer {
                return Err(j_error("SECRET_REVEALER_NOT_NORMALIZED"));
            }
            Ok(())
        }
        JurisdictionEvent::HankoBatchProcessed(value) => {
            if value.nonce == 0 {
                return Err(j_error("HANKO_BATCH_NONCE_INVALID"));
            }
            validate_u64(value.nonce, "HANKO_BATCH_NONCE")
        }
        JurisdictionEvent::EntityProviderActionExecuted(value) => {
            validate_action(value.action_kind, &value.action_nonce)
        }
        JurisdictionEvent::EntityProviderActionCancelled(value) => {
            validate_action(value.cancelled_action_kind, &value.action_nonce)
        }
        JurisdictionEvent::DebtCreated(value) => {
            validate_entity_pair(&value.debtor, &value.creditor)?;
            validate_i64(value.token_id, "DEBT_TOKEN_ID")?;
            validate_i64(value.debt_index, "DEBT_INDEX")
        }
        JurisdictionEvent::DisputeStarted(value) => {
            validate_entity_pair(&value.sender, &value.counterentity)?;
            validate_proof_body(&value.initial_proofbody)?;
            validate_u64(value.dispute_timeout, "DISPUTE_TIMEOUT")?;
            validate_u64(value.dispute_start_timestamp, "DISPUTE_START_TIMESTAMP")?;
            validate_u64(value.left_response_seconds, "LEFT_RESPONSE_SECONDS")?;
            validate_u64(value.right_response_seconds, "RIGHT_RESPONSE_SECONDS")?;
            if value.dispute_start_timestamp == 0
                || value
                    .dispute_start_timestamp
                    .checked_add(value.left_response_seconds)
                    .and_then(|sum| sum.checked_add(value.right_response_seconds))
                    != Some(value.dispute_timeout)
            {
                return Err(j_error("DISPUTE_TIMEOUT_INVALID"));
            }
            validate_optional_i64(value.batch_nonce, "DISPUTE_BATCH_NONCE")
        }
        JurisdictionEvent::DisputeFinalized(value) => {
            validate_entity_pair(&value.sender, &value.counterentity)?;
            validate_proof_body(&value.final_proofbody)?;
            validate_optional_i64(value.batch_nonce, "DISPUTE_BATCH_NONCE")
        }
        JurisdictionEvent::CounterDisputeRegistered(value) => {
            validate_entity_pair(&value.sender, &value.counterentity)?;
            validate_i64(value.nonce, "COUNTER_DISPUTE_NONCE")?;
            validate_proof_body(&value.counter_proofbody)
        }
        JurisdictionEvent::HashLadderRevealRegistered(value) => {
            validate_entity_pair(&value.entity, &value.counterparty_entity)?;
            if value.fill_ratio == 0 || value.revealed_at == 0 {
                return Err(j_error("HASH_LADDER_REVEAL_INVALID"));
            }
            validate_u64(value.revealed_at, "HASH_LADDER_REVEALED_AT")
        }
        JurisdictionEvent::DebtEnforced(value) => {
            validate_entity_pair(&value.debtor, &value.creditor)?;
            validate_i64(value.token_id, "DEBT_TOKEN_ID")?;
            validate_i64(value.new_debt_index, "DEBT_INDEX")
        }
        JurisdictionEvent::DebtForgiven(value) => {
            validate_entity_pair(&value.debtor, &value.creditor)?;
            validate_i64(value.token_id, "DEBT_TOKEN_ID")?;
            validate_i64(value.debt_index, "DEBT_INDEX")
        }
    }
}

fn validate_account_settled(event: &AccountSettledEvent) -> Result<(), StateError> {
    validate_u64(event.nonce, "ACCOUNT_SETTLED_NONCE")
}

pub(crate) fn validate_metadata(metadata: &JEventMetadata) -> Result<(), StateError> {
    for (field, value) in [
        ("blockNumber", metadata.block_number),
        ("logIndex", metadata.log_index),
        ("eventIndex", metadata.event_index),
    ] {
        if value.is_some_and(|value| value > MAX_SAFE_INTEGER) {
            return Err(j_error(format!("JURISDICTION_EVENT_{field}_INVALID")));
        }
    }
    Ok(())
}

fn validate_proof_body(value: &ProofBody) -> Result<(), StateError> {
    validate_u64(value.left_response_seconds, "PROOF_LEFT_RESPONSE_SECONDS")?;
    validate_u64(value.right_response_seconds, "PROOF_RIGHT_RESPONSE_SECONDS")?;
    if value
        .token_ids
        .iter()
        .any(|token| token.sign() == Sign::Minus)
    {
        return Err(j_error("PROOF_TOKEN_ID_NEGATIVE"));
    }
    Ok(())
}

fn validate_wallet_order(
    balances: &[ExternalTokenBalance],
    allowances: &[ExternalAllowance],
) -> Result<(), StateError> {
    if balances
        .windows(2)
        .any(|pair| wallet_balance_key(&pair[0]) > wallet_balance_key(&pair[1]))
    {
        return Err(j_error("EXTERNAL_WALLET_BALANCES_NOT_CANONICAL"));
    }
    if allowances
        .windows(2)
        .any(|pair| wallet_allowance_key(&pair[0]) > wallet_allowance_key(&pair[1]))
    {
        return Err(j_error("EXTERNAL_WALLET_ALLOWANCES_NOT_CANONICAL"));
    }
    for balance in balances {
        validate_optional_i64(balance.token_id, "WALLET_TOKEN_ID")?;
    }
    Ok(())
}

fn wallet_balance_key(value: &ExternalTokenBalance) -> (String, i64, String) {
    (
        hex20(&value.token_address),
        value.token_id.unwrap_or(-1),
        value.balance.to_string(),
    )
}

fn wallet_allowance_key(value: &ExternalAllowance) -> (String, String, String) {
    (
        hex20(&value.token_address),
        hex20(&value.spender),
        value.allowance.to_string(),
    )
}

fn validate_entity_pair(left: &str, right: &str) -> Result<(), StateError> {
    validate_entity(left)?;
    validate_entity(right)
}

fn validate_entity(value: &str) -> Result<(), StateError> {
    if value.is_empty() || value.trim() != value || value.to_lowercase() != value {
        return Err(j_error("JURISDICTION_ENTITY_NOT_NORMALIZED"));
    }
    Ok(())
}

fn validate_action(kind: u8, nonce: &BigInt) -> Result<(), StateError> {
    if kind > 1 {
        return Err(j_error("ENTITY_PROVIDER_ACTION_KIND_INVALID"));
    }
    require_positive(nonce, "ENTITY_PROVIDER_ACTION_NONCE")?;
    if nonce.bits() > 256 {
        return Err(j_error("ENTITY_PROVIDER_ACTION_NONCE_INVALID"));
    }
    Ok(())
}

fn require_positive(value: &BigInt, field: &str) -> Result<(), StateError> {
    if value.sign() != Sign::Plus {
        return Err(j_error(format!("{field}_INVALID")));
    }
    Ok(())
}

fn validate_optional_i64(value: Option<i64>, field: &str) -> Result<(), StateError> {
    value.map_or(Ok(()), |value| validate_i64(value, field))
}

fn validate_i64(value: i64, field: &str) -> Result<(), StateError> {
    if value.unsigned_abs() > MAX_SAFE_INTEGER {
        return Err(j_error(format!("{field}_INVALID:{value}")));
    }
    Ok(())
}

fn validate_u64(value: u64, field: &str) -> Result<(), StateError> {
    if value > MAX_SAFE_INTEGER {
        return Err(j_error(format!("{field}_INVALID:{value}")));
    }
    Ok(())
}

fn ordered_payload(event: &JurisdictionEvent) -> Result<String, StateError> {
    let value = canonical_event_data_value(event)?;
    let json = canonical_value_json(&value)?;
    serde_json::to_string(&json)
        .map_err(|error| j_error(format!("JURISDICTION_EVENT_JSON:{error}")))
}

fn payload_key(event: &JurisdictionEvent) -> Result<String, StateError> {
    if let JurisdictionEvent::AccountSettled(event) = event {
        return Ok(format!(
            "AccountSettled:{}:{}:{}:{}:{}:{}:{}:{}",
            event.left_entity,
            event.right_entity,
            event.token_id,
            event.left_reserve,
            event.right_reserve,
            event.collateral,
            event.ondelta,
            event.nonce,
        ));
    }
    Ok(format!("{}:{}", event.kind(), ordered_payload(event)?))
}

pub fn canonical_event_key(event: &JurisdictionEvent) -> Result<String, StateError> {
    validate_event(event)?;
    serde_json::to_string(&Value::Array(vec![
        optional_u64(event.metadata().block_number),
        optional_hash(event.metadata().block_hash),
        optional_hash(event.metadata().transaction_hash),
        optional_u64(event.metadata().log_index),
        optional_u64(event.metadata().event_index),
        Value::String(payload_key(event)?),
    ]))
    .map_err(|error| j_error(format!("JURISDICTION_EVENT_JSON:{error}")))
}

fn compare_metadata(left: &JEventMetadata, right: &JEventMetadata) -> Ordering {
    compare_optional(left.block_number, right.block_number)
        .then_with(|| compare_optional(left.log_index, right.log_index))
        .then_with(|| compare_optional(left.event_index, right.event_index))
        .then_with(|| left.transaction_hash.cmp(&right.transaction_hash))
}

fn compare_optional(left: Option<u64>, right: Option<u64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn canonical_value_json(value: &CanonicalValue) -> Result<Value, StateError> {
    Ok(match value {
        CanonicalValue::Null => Value::Null,
        CanonicalValue::Bool(value) => Value::Bool(*value),
        CanonicalValue::Number(value) => serde_json::from_str(value.as_str())
            .map_err(|error| j_error(format!("JURISDICTION_EVENT_NUMBER:{error}")))?,
        CanonicalValue::BigInt(value) => Value::Object(Map::from_iter([
            ("__xlnType".into(), Value::String("BigInt".into())),
            ("value".into(), Value::String(value.to_string())),
        ])),
        CanonicalValue::String(value) => Value::String(value.clone()),
        CanonicalValue::Array(values) => Value::Array(
            values
                .iter()
                .map(canonical_value_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        CanonicalValue::Object(fields) => Value::Object(Map::from_iter(
            fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), canonical_value_json(value)?)))
                .collect::<Result<Vec<_>, StateError>>()?,
        )),
        CanonicalValue::Map(_) | CanonicalValue::Set(_) => {
            return Err(j_error("JURISDICTION_EVENT_VALUE_UNSUPPORTED"));
        }
    })
}

fn optional_u64(value: Option<u64>) -> Value {
    value.map_or(Value::Null, |value| Value::Number(value.into()))
}

fn optional_hash(value: Option<[u8; 32]>) -> Value {
    value.map_or(Value::Null, |value| Value::String(hex32(&value)))
}

fn hex20(value: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(value))
}

fn hex32(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
