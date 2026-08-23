//! Transport-neutral, canonical binary ABI for the native Account engine.

mod codec;
mod digest;
mod error;
mod msgpack_decode;
mod msgpack_encode;
mod msgpack_parser;
mod types;
mod value;

pub use codec::{decode_envelope, decode_envelope_with_limits, encode_envelope};
pub use digest::compute_body_digest;
pub use error::AbiError;
pub use types::{
    ABI_DOMAIN, ABI_MAGIC, ABI_VERSION, AbiLimits, BodyTuple, EngineIdentity, Envelope,
    MessageKind, OpTag, ProtocolBinding,
};
pub use value::AbiValue;

#[cfg(test)]
mod tests;
