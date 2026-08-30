use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::j_claims::codec::{JClaimRecord, JClaimSide, j_error};
use crate::j_claims::events::MAX_SAFE_INTEGER;
use crate::{JClaimProof, StateError};

pub(crate) fn canonical_proof_value(proof: &JClaimProof) -> Result<CanonicalValue, StateError> {
    crate::j_claims::proof::validate_proof_size(proof)?;
    Ok(CanonicalValue::Object(vec![
        ("version".into(), number(1)?),
        (
            "nodes".into(),
            CanonicalValue::Array(
                proof
                    .nodes
                    .iter()
                    .map(canonical_node_value)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
    ]))
}

fn canonical_node_value(node: &crate::JClaimNode) -> Result<CanonicalValue, StateError> {
    match node {
        crate::JClaimNode::Leaf { key, record } => Ok(CanonicalValue::Object(vec![
            ("version".into(), number(1)?),
            ("type".into(), text("leaf")),
            ("key".into(), text(&hex(key))),
            ("record".into(), canonical_record_value(record)?),
        ])),
        crate::JClaimNode::Branch { bit, left, right } => Ok(CanonicalValue::Object(vec![
            ("version".into(), number(1)?),
            ("type".into(), text("branch")),
            ("bit".into(), number(u64::from(*bit))?),
            ("left".into(), text(&hex(left))),
            ("right".into(), text(&hex(right))),
        ])),
    }
}

fn canonical_record_value(record: &JClaimRecord) -> Result<CanonicalValue, StateError> {
    Ok(CanonicalValue::Object(vec![
        ("version".into(), number(1)?),
        ("accountKey".into(), text(&hex(&record.account_key))),
        (
            "side".into(),
            text(match record.side {
                JClaimSide::Left => "left",
                JClaimSide::Right => "right",
            }),
        ),
        ("jHeight".into(), number(record.j_height)?),
        ("jBlockHash".into(), text(&hex(&record.j_block_hash))),
        ("eventsHash".into(), text(&hex(&record.events_hash))),
    ]))
}

fn number(value: u64) -> Result<CanonicalValue, StateError> {
    if value > MAX_SAFE_INTEGER {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_SAFE_INTEGER_INVALID:{value}"
        )));
    }
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value)
            .map_err(|error| j_error(format!("ACCOUNT_J_CLAIM_NUMBER_INVALID:{error}")))?,
    ))
}

fn text(value: &str) -> CanonicalValue {
    CanonicalValue::String(value.to_owned())
}

fn hex(value: &[u8; 32]) -> String {
    crate::state::identity::render_hex(value)
}
