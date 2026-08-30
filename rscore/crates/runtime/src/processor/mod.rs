//! Production Runtime transition, durability and publication boundary.

#[path = "projection/checkpoint.rs"]
mod checkpoint_projection;
mod context_projection;
mod durable;
#[path = "projection/entity_checkpoint.rs"]
mod entity_checkpoint_projection;
mod envelope;
mod live;
mod machine_snapshot;
mod output;
mod profile_route;
mod projection;
#[path = "projection/replica_meta.rs"]
mod replica_meta;
mod routing;

#[cfg(test)]
pub(crate) use context_projection::prepare_entity_context_rows;

#[cfg(test)]
mod tests;

pub use durable::{
    DurableRuntimeProcessor, DurableRuntimeProcessorError, RuntimeDurableCommitments,
    RuntimeDurableEntityCommitment, RuntimeProcessReport, RuntimeSignerLabel,
};
pub use envelope::{RuntimeDurableEnvelope, RuntimeDurableEnvelopeError, RuntimeOperatorConfig};
pub use live::{ResidentRuntimeService, ResidentRuntimeServiceError};
pub use output::{EntityOutputEncodingError, encode_local_entity_outputs};
pub use routing::{EntityRoute, EntityRouteError, EntityRouteTable};
