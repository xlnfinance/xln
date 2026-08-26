//! Mirrors `core/account/tx/handlers/j-events`.

mod claim;
mod finality;

pub(crate) use claim::apply_j_event_claim;
