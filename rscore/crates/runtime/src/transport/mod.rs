//! Durable direct-Runtime WebSocket publication.
//!
//! The transport accepts only a [`DurableRuntimeFrame`], rereads its exact
//! flat outbox rows from [`NativeRuntimeStore`], and completes the authenticated
//! direct-session handshake before publishing. A row can therefore never
//! escape before the WAL batch and directory fsync that minted the token.

mod crypto;
mod entity_inputs_frame;
mod error;
mod inbound;
pub(crate) mod msgpack;
mod publisher;
mod routing;
mod session;
mod wire;

pub(crate) use crypto::derive_local_runtime_id;
pub use error::RuntimeTransportError;
pub(crate) use inbound::InboundRuntimeEvent;
pub use inbound::{
    DirectRuntimeIngress, DirectRuntimeIngressConfig, DirectRuntimeIngressMetrics,
    InboundEntityInputs, InboundSessionTable,
};
pub use publisher::{
    DirectOutboxPublisher, DirectOutboxPublisherConfig, PublicationBacklog, PublicationReport,
};
pub use routing::{DirectRoute, DirectRouteTable};

#[cfg(test)]
pub(crate) use crypto::encryption_identity;
#[cfg(test)]
pub(crate) use routing::OutboundEnvelope;
#[cfg(test)]
pub(crate) use session::{DirectSession, SessionConfig};

#[cfg(test)]
mod tests;
