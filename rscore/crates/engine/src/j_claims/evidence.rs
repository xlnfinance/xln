use std::collections::BTreeSet;

use serde_json::Value;
use sha3::{Digest as _, Keccak256};

use super::event_types::DisputeFinalizationEvidence;
use crate::StateError;
use crate::j_claims::codec::j_error;

pub fn canonical_dispute_finalization_evidence_key(
    evidence: &DisputeFinalizationEvidence,
) -> Result<String, StateError> {
    serde_json::to_string(&Value::Array(vec![
        Value::String(norm_hex(&evidence.sender)),
        Value::String(norm_hex(&evidence.counterentity)),
        Value::String(norm_decimal(&evidence.initial_nonce)),
        Value::String(norm_decimal(&evidence.final_nonce)),
        Value::String(norm_hex(&evidence.initial_proofbody_hash)),
        Value::String(norm_hex(&evidence.final_proofbody_hash)),
        Value::Bool(evidence.proposer_is_left),
        Value::String(norm_hex(&evidence.left_arguments)),
        Value::String(norm_hex(&evidence.right_arguments)),
        Value::Bool(evidence.started_by_left),
        Value::String(norm_hex(&evidence.sig)),
    ]))
    .map_err(|error| j_error(format!("J_DISPUTE_FINALIZATION_EVIDENCE_JSON:{error}")))
}

pub fn normalize_dispute_finalization_evidence(
    evidence: &[DisputeFinalizationEvidence],
) -> Result<Vec<DisputeFinalizationEvidence>, StateError> {
    let mut ordered = evidence
        .iter()
        .map(|entry| {
            Ok((
                canonical_dispute_finalization_evidence_key(entry)?,
                entry.clone(),
            ))
        })
        .collect::<Result<Vec<_>, StateError>>()?;
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let mut seen = BTreeSet::new();
    for (key, _) in &ordered {
        if !seen.insert(key) {
            return Err(j_error("J_DISPUTE_FINALIZATION_EVIDENCE_DUPLICATE"));
        }
    }
    Ok(ordered.into_iter().map(|(_, entry)| entry).collect())
}

pub fn canonical_dispute_finalization_evidence_hash(
    evidence: &[DisputeFinalizationEvidence],
) -> Result<[u8; 32], StateError> {
    let keys = normalize_dispute_finalization_evidence(evidence)?
        .iter()
        .map(canonical_dispute_finalization_evidence_key)
        .collect::<Result<Vec<_>, _>>()?;
    let json = serde_json::to_string(&keys)
        .map_err(|error| j_error(format!("J_DISPUTE_FINALIZATION_EVIDENCE_JSON:{error}")))?;
    Ok(Keccak256::digest(json.as_bytes()).into())
}

fn norm_hex(value: &str) -> String {
    let value = value.trim();
    if value.starts_with("0x") {
        value.to_lowercase()
    } else {
        value.to_owned()
    }
}

fn norm_decimal(value: &str) -> String {
    value.trim().to_owned()
}
