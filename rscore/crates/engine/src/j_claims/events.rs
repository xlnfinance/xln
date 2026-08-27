use std::cmp::Ordering;
use std::collections::BTreeSet;

use sha3::{Digest as _, Keccak256};

use crate::StateError;
use crate::j_claims::codec::j_error;
use crate::j_claims::types::{AccountSettledEvent, JEventMetadata, JurisdictionEvent};

pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn canonical_events_hash(events: &[JurisdictionEvent]) -> Result<[u8; 32], StateError> {
    validate_events(events)?;
    let mut ordered = events.to_vec();
    ordered.sort_by(compare_events);
    let keys = ordered
        .iter()
        .map(canonical_event_key)
        .collect::<Result<Vec<_>, _>>()?;
    let json = format!(
        "[{}]",
        keys.iter()
            .map(|key| json_string(key))
            .collect::<Vec<_>>()
            .join(",")
    );
    Ok(Keccak256::digest(json.as_bytes()).into())
}

/// Canonical TS-equivalent jurisdiction-event ordering and duplicate guard.
///
/// Entity owns the ordering of watcher-derived claims while Account owns their
/// financial application.  Both layers must call this one implementation so a
/// claim cannot acquire a different digest merely by crossing that boundary.
pub fn canonical_events(
    events: &[JurisdictionEvent],
) -> Result<Vec<JurisdictionEvent>, StateError> {
    if events.is_empty() {
        return Err(j_error("ACCOUNT_J_CLAIM_EVENTS_INVALID"));
    }
    validate_events(events)?;
    let mut ordered = events.to_vec();
    ordered.sort_by(compare_events);
    let mut seen = BTreeSet::new();
    for event in &ordered {
        if !seen.insert(canonical_event_key(event)?) {
            return Err(j_error("ACCOUNT_J_CLAIM_EVENT_DUPLICATE"));
        }
    }
    Ok(ordered)
}

pub(crate) fn validate_event(event: &AccountSettledEvent) -> Result<(), StateError> {
    validate_metadata(&event.metadata)?;
    if event.nonce > MAX_SAFE_INTEGER {
        return Err(j_error(format!(
            "ACCOUNT_SETTLED_NONCE_INVALID:{}",
            event.nonce
        )));
    }
    Ok(())
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

fn validate_events(events: &[JurisdictionEvent]) -> Result<(), StateError> {
    for event in events {
        match event {
            JurisdictionEvent::AccountSettled(value) => validate_event(value)?,
        }
    }
    Ok(())
}

fn compare_events(left: &JurisdictionEvent, right: &JurisdictionEvent) -> Ordering {
    let (left_meta, left_payload) = event_order_parts(left);
    let (right_meta, right_payload) = event_order_parts(right);
    compare_optional(left_meta.block_number, right_meta.block_number)
        .then_with(|| compare_optional(left_meta.log_index, right_meta.log_index))
        .then_with(|| compare_optional(left_meta.event_index, right_meta.event_index))
        .then_with(|| left_meta.transaction_hash.cmp(&right_meta.transaction_hash))
        .then_with(|| left_payload.cmp(&right_payload))
}

fn compare_optional(left: Option<u64>, right: Option<u64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn event_order_parts(event: &JurisdictionEvent) -> (&JEventMetadata, String) {
    match event {
        JurisdictionEvent::AccountSettled(event) => (&event.metadata, payload_key(event)),
    }
}

fn canonical_event_key(event: &JurisdictionEvent) -> Result<String, StateError> {
    let (metadata, payload) = event_order_parts(event);
    validate_metadata(metadata)?;
    Ok(format!(
        "[{},{},{},{},{},\"{payload}\"]",
        optional_number(metadata.block_number),
        optional_hash(metadata.block_hash),
        optional_hash(metadata.transaction_hash),
        optional_number(metadata.log_index),
        optional_number(metadata.event_index),
    ))
}

fn payload_key(event: &AccountSettledEvent) -> String {
    format!(
        "AccountSettled:{}:{}:{}:{}:{}:{}:{}:{}",
        event.left_entity,
        event.right_entity,
        event.token_id,
        event.left_reserve,
        event.right_reserve,
        event.collateral,
        event.ondelta,
        event.nonce,
    )
}

fn optional_number(value: Option<u64>) -> String {
    value.map_or_else(|| "null".into(), |value| value.to_string())
}

fn optional_hash(value: Option<[u8; 32]>) -> String {
    value.map_or_else(|| "null".into(), |value| format!("\"{}\"", hex(&value)))
}

fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            _ => output.push(character),
        }
    }
    output.push('"');
    output
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
