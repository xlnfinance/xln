use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::j_claims::codec::{JClaimRecord, JClaimSide, j_error};
use crate::j_claims::events::{MAX_SAFE_INTEGER, validate_event, validate_metadata};
use crate::j_claims::types::{JEventMetadata, JurisdictionEvent};
use crate::{JClaimProof, StateError};

pub(crate) fn canonical_event_value(
    event: &JurisdictionEvent,
) -> Result<CanonicalValue, StateError> {
    match event {
        JurisdictionEvent::AccountSettled(event) => {
            validate_event(event)?;
            let mut fields = metadata_fields(&event.metadata)?;
            fields.push(("type".into(), text("AccountSettled")));
            fields.push((
                "data".into(),
                CanonicalValue::Object(vec![
                    ("leftEntity".into(), text(&event.left_entity.as_hex())),
                    ("rightEntity".into(), text(&event.right_entity.as_hex())),
                    ("tokenId".into(), number(u64::from(event.token_id.get()))?),
                    ("leftReserve".into(), text(&event.left_reserve.to_string())),
                    (
                        "rightReserve".into(),
                        text(&event.right_reserve.to_string()),
                    ),
                    ("collateral".into(), text(&event.collateral.to_string())),
                    ("ondelta".into(), text(&event.ondelta.to_string())),
                    ("nonce".into(), number(event.nonce)?),
                ]),
            ));
            Ok(CanonicalValue::Object(fields))
        }
    }
}

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

fn metadata_fields(metadata: &JEventMetadata) -> Result<Vec<(String, CanonicalValue)>, StateError> {
    validate_metadata(metadata)?;
    let mut fields = Vec::new();
    push_number(&mut fields, "blockNumber", metadata.block_number)?;
    push_hash(&mut fields, "blockHash", metadata.block_hash);
    push_hash(&mut fields, "transactionHash", metadata.transaction_hash);
    push_number(&mut fields, "logIndex", metadata.log_index)?;
    push_number(&mut fields, "eventIndex", metadata.event_index)?;
    Ok(fields)
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

fn push_number(
    fields: &mut Vec<(String, CanonicalValue)>,
    name: &str,
    value: Option<u64>,
) -> Result<(), StateError> {
    if let Some(value) = value {
        fields.push((name.into(), number(value)?));
    }
    Ok(())
}

fn push_hash(fields: &mut Vec<(String, CanonicalValue)>, name: &str, value: Option<[u8; 32]>) {
    if let Some(value) = value {
        fields.push((name.into(), text(&hex(&value))));
    }
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
