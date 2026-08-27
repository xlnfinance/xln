//! Durable direct-Runtime WebSocket publication.
//!
//! The transport accepts only a [`DurableRuntimeFrame`], rereads its exact
//! flat outbox rows from [`NativeRuntimeStore`], and completes the authenticated
//! direct-session handshake before publishing. A row can therefore never
//! escape before the WAL batch and directory fsync that minted the token.

mod crypto;
mod error;
pub(crate) mod msgpack;
mod publisher;
mod routing;
mod session;
mod wire;

pub(crate) use crypto::derive_local_runtime_id;
pub use error::RuntimeTransportError;
pub use publisher::{DirectOutboxPublisher, DirectOutboxPublisherConfig, PublicationReport};
pub use routing::{DirectRoute, DirectRouteTable};

#[cfg(test)]
mod tests;
