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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=4")
        // wire=4: the seed carries rebalance policy and swap offer rows instead
        // of carried roots, Hello installs the swap market tables, the job
        // context carries the signed frame's J height, and the summary row
        // carries the engine-owned section roots. The fingerprint exists to
        // reject a binary built for the older shapes at Hello, so it moves
        // with every request/reply shape change.
        protocol_fingerprint: [
            0xc0, 0xed, 0xea, 0x0b, 0xeb, 0x1c, 0x81, 0x25, 0x58, 0x4d, 0x3c, 0x7b, 0xed, 0x03,
            0x4e, 0x54, 0x8e, 0xeb, 0xae, 0x3b, 0xe9, 0x3b, 0x73, 0xe9, 0x4b, 0xb1, 0x1b, 0xbe,
            0xc3, 0x1b, 0xc4, 0xa7,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
