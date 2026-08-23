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
        protocol_version: 5,
        storage_schema_version: 10,
        // sha256("xln.rscore.account:v1:protocol=5:storage=10:hanko:payment-v1")
        protocol_fingerprint: [
            0xc7, 0xff, 0xf9, 0x07, 0x2a, 0x29, 0x53, 0xc6, 0x54, 0xb0, 0x5c, 0xa2, 0x95, 0x51,
            0xe2, 0xaa, 0x23, 0xf4, 0x10, 0xfb, 0xd5, 0x8c, 0xe2, 0x47, 0x2a, 0xe1, 0xed, 0x63,
            0xac, 0xcd, 0x77, 0x1f,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
