//! Exact certified Entity-history evidence for native replay diagnostics.

use std::collections::BTreeMap;

use serde_json::Value;
use xln_rscore_entity_kernel::compute_entity_events_parity_digest;
use xln_rscore_runtime::{RuntimeDurableCommitments, restore::decode_certified_entity_frame_head};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct EntityEventEvidence {
    pub count: u64,
    pub digest: [u8; 32],
}

pub(super) fn entity_event_evidence(
    history: &BTreeMap<u64, Vec<Value>>,
    owner: &str,
) -> Result<BTreeMap<u64, EntityEventEvidence>, String> {
    let mut output = BTreeMap::new();
    for (runtime_height, records) in history {
        let mut owner_rows = records
            .iter()
            .filter(|record| history_owner(record).as_deref() == Some(owner))
            .collect::<Vec<_>>();
        if owner_rows.len() != 1 {
            return Err(format!(
                "RUNTIME_REPLAY_ENTITY_HISTORY_COUNT:{runtime_height}:{}",
                owner_rows.len(),
            ));
        }
        let record = owner_rows.pop().expect("one checked row");
        let link = record
            .as_object()
            .and_then(|value| value.get("link"))
            .ok_or_else(|| format!("RUNTIME_REPLAY_ENTITY_HISTORY_LINK:{runtime_height}"))?;
        let decoded = decode_certified_entity_frame_head(link)
            .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_HISTORY:{runtime_height}:{error}"))?;
        let count = u64::try_from(decoded.frame.events.len())
            .map_err(|_| "RUNTIME_REPLAY_ENTITY_EVENT_COUNT_OVERFLOW".to_string())?;
        let digest = compute_entity_events_parity_digest(&decoded.frame.events)
            .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_EVENTS:{runtime_height}:{error}"))?;
        output.insert(*runtime_height, EntityEventEvidence { count, digest });
    }
    Ok(output)
}

/// Exact TypeScript-certified Entity link for one Runtime height. This is
/// diagnostic evidence only: native execution has already finished before a
/// caller compares it with the Rust-produced link.
pub(super) fn entity_history_link<'a>(
    history: &'a BTreeMap<u64, Vec<Value>>,
    runtime_height: u64,
    owner: &str,
) -> Result<&'a Value, String> {
    let records = history
        .get(&runtime_height)
        .ok_or_else(|| format!("RUNTIME_REPLAY_ENTITY_HISTORY_MISSING:{runtime_height}"))?;
    let mut owner_rows = records
        .iter()
        .filter(|record| history_owner(record).as_deref() == Some(owner))
        .collect::<Vec<_>>();
    if owner_rows.len() != 1 {
        return Err(format!(
            "RUNTIME_REPLAY_ENTITY_HISTORY_COUNT:{runtime_height}:{}",
            owner_rows.len(),
        ));
    }
    owner_rows
        .pop()
        .and_then(|record| record.as_object()?.get("link"))
        .ok_or_else(|| format!("RUNTIME_REPLAY_ENTITY_HISTORY_LINK:{runtime_height}"))
}

pub(super) fn assert_entity_events(
    height: u64,
    expected: Option<&EntityEventEvidence>,
    entity_frame_committed: bool,
    actual: &RuntimeDurableCommitments,
) -> Result<(), String> {
    let empty = EntityEventEvidence {
        count: 0,
        digest: compute_entity_events_parity_digest(&[])
            .map_err(|error| format!("RUNTIME_REPLAY_ENTITY_EVENTS:{height}:{error}"))?,
    };
    let expected = match (expected, entity_frame_committed) {
        (Some(expected), true) => expected,
        (None, false) => &empty,
        _ => return Err(format!("RUNTIME_REPLAY_ENTITY_HISTORY_SHAPE:{height}")),
    };
    if expected.count == actual.entity_event_count && expected.digest == actual.events_parity_digest
    {
        Ok(())
    } else {
        Err(format!(
            "RUNTIME_REPLAY_ENTITY_EVENTS_MISMATCH:{height}:expectedCount={}:actualCount={}:expectedDigest={}:actualDigest={}",
            expected.count,
            actual.entity_event_count,
            hex(&expected.digest),
            hex(&actual.events_parity_digest),
        ))
    }
}

fn history_owner(record: &Value) -> Option<String> {
    record
        .as_object()?
        .get("link")?
        .as_object()?
        .get("frame")?
        .as_object()?
        .get("entityContext")?
        .as_object()?
        .get("entityId")?
        .as_str()
        .map(str::to_ascii_lowercase)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
