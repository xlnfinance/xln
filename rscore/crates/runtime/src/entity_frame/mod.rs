//! Canonical Entity-frame projection and replay prefix selection.
//!
//! The modules mirror `core/entity/consensus/frame/`. They consume decoded
//! WAL values and never a TypeScript-generated selection count; the replay
//! prefix itself is selected in `machine::apply` (fit_replay_entity_prefix).

mod account_input_commitment;
mod j_event;

use serde_json::Value;
use thiserror::Error;
use xln_rscore_entity_kernel::{CanonicalEntityTx, EntityTxKind};


#[derive(Debug, Error)]
pub enum EntityFrameError {
    #[error("RUNTIME_ENTITY_FRAME_VALUE:{0}")]
    Value(String),
    #[error("RUNTIME_ENTITY_FRAME_ENCODING:{0}")]
    Encoding(String),
    #[error(transparent)]
    Tagged(#[from] crate::TaggedJsonError),
}

/// Build the one trusted Entity-frame projection from the exact logical tx.
/// Account inputs have a specialized commitment; j_event ranges use the
/// canonical J-event projection. Every other supported MVP tx commits its
/// exact tagged-storage data.
pub(crate) fn project_entity_tx(value: &Value) -> Result<CanonicalEntityTx, EntityFrameError> {
    let tx = value
        .as_object()
        .ok_or_else(|| EntityFrameError::Value("OBJECT:entityTx".into()))?;
    if tx.len() != 2 || !tx.contains_key("type") || !tx.contains_key("data") {
        return Err(EntityFrameError::Value("FIELDS:entityTx:type,data".into()));
    }
    let kind_text = tx
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| EntityFrameError::Value("STRING:entityTx.type".into()))?;
    let kind = EntityTxKind::parse(kind_text)
        .map_err(|error| EntityFrameError::Value(error.to_string()))?;
    let data = tx
        .get("data")
        .ok_or_else(|| EntityFrameError::Value("FIELD:entityTx.data".into()))?;
    let wire_data = crate::canonical_value_from_tagged_json(data)?;
    let projected = if kind == EntityTxKind::AccountInput {
        let commitment = account_input_commitment::account_input_commitment(&wire_data)?;
        return CanonicalEntityTx::from_wire_and_frame_projection(kind, wire_data, commitment)
            .map_err(|error| EntityFrameError::Value(error.to_string()));
    } else if kind == EntityTxKind::JEvent {
        j_event::canonical_j_event_data_for_frame_hash(data)?
    } else {
        data.clone()
    };
    let canonical = crate::canonical_value_from_tagged_json(&projected)?;
    CanonicalEntityTx::from_wire_and_frame_projection(kind, wire_data, canonical)
        .map_err(|error| EntityFrameError::Value(error.to_string()))
}
