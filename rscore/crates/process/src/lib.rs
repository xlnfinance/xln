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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=3")
        // wire=3: the seed carries rebalance policy and swap offer rows instead
        // of carried roots, Hello installs the swap market tables, and the job
        // context carries the signed frame's J height. The fingerprint exists
        // to reject a binary built for the older shapes at Hello, so it moves
        // with every request/reply shape change.
        protocol_fingerprint: [
            0x90, 0xf4, 0x1c, 0x54, 0x2e, 0xe7, 0xd5, 0x41, 0x05, 0x8f, 0x81, 0xba, 0xb9, 0xa7,
            0x78, 0xd7, 0xa9, 0xa6, 0x51, 0xf9, 0x01, 0xc6, 0xa9, 0x73, 0xdf, 0x58, 0xaf, 0xf4,
            0x49, 0xa5, 0x44, 0x20,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
