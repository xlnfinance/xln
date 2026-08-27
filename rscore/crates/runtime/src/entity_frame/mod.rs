//! Canonical Entity-frame projection and replay prefix selection.
//!
//! The modules mirror `core/entity/consensus/frame/` and
//! `core/entity/consensus/proposal/wire-budget.ts`. They consume decoded WAL
//! values and never a TypeScript-generated selection count.

mod account_input_commitment;
mod wire_budget;

use serde_json::Value;
use thiserror::Error;
use xln_rscore_entity_kernel::{CanonicalEntityTx, EntityTxKind};

pub use wire_budget::fit_entity_account_input_prefix;

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
/// Account inputs have a specialized commitment; every other supported MVP
/// tx commits its exact tagged-storage data. J-event ranges require their own
/// normalization and stay loud until that decoder is connected here.
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
        .and_then(EntityTxKind::require_native_mvp)
        .map_err(|error| EntityFrameError::Value(error.to_string()))?;
    if kind == EntityTxKind::JEvent {
        return Err(EntityFrameError::Value(
            "J_EVENT_CANONICAL_PROJECTION_NOT_CONNECTED".into(),
        ));
    }
    let data = tx
        .get("data")
        .ok_or_else(|| EntityFrameError::Value("FIELD:entityTx.data".into()))?;
    let wire_data = crate::canonical_value_from_tagged_json(data)?;
    let projected = if kind == EntityTxKind::AccountInput {
        account_input_commitment::account_input_commitment(data)?
    } else {
        data.clone()
    };
    let canonical = crate::canonical_value_from_tagged_json(&projected)?;
    CanonicalEntityTx::from_wire_and_frame_projection(kind, wire_data, canonical)
        .map_err(|error| EntityFrameError::Value(error.to_string()))
}
