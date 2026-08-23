//! Long-lived, framed binary host for the deterministic Account batch engine.

mod error;
mod session;
mod transport;
mod wire_decode;
mod wire_encode;
mod wire_value;

pub use error::ProcessError;
pub use session::{ProcessReply, ProcessSession};
pub use transport::{read_frame, serve, write_frame};

pub const PROCESS_ABI_VERSION: u64 = 1;
pub const PROCESS_PROFILE: &str = "payment-v1";
pub const PAYMENT_PROFILE_BINDING: xln_rscore_abi::ProtocolBinding =
    xln_rscore_abi::ProtocolBinding {
        protocol_version: 1,
        storage_schema_version: 1,
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1")
        protocol_fingerprint: [
            0x88, 0x3b, 0xd6, 0x65, 0x0c, 0xbc, 0x2f, 0xdd, 0x9f, 0xf7, 0x3a, 0xda, 0x85, 0x0f,
            0x1b, 0x87, 0x6c, 0x97, 0x6f, 0x53, 0xd3, 0x72, 0x1b, 0x98, 0x7b, 0x61, 0x5e, 0x93,
            0x04, 0x33, 0x3d, 0x4f,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
