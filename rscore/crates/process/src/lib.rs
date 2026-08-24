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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=5")
        // wire=5: the seed carries rebalance policy and swap offer rows instead
        // of carried roots, Hello installs the swap market tables, the job
        // context carries the signed frame's J height, and the summary row
        // carries the engine-owned section roots, and swap outputs are the
        // canonical AccountOutput rows (upsert/remove/cancel-request). The fingerprint exists to
        // reject a binary built for the older shapes at Hello, so it moves
        // with every request/reply shape change.
        protocol_fingerprint: [
            0x9e, 0x9c, 0xb3, 0xe3, 0xce, 0x49, 0xde, 0xa5, 0x90, 0x90, 0x0e, 0x67, 0xfb, 0xd8,
            0x74, 0xcc, 0x0f, 0x81, 0xcb, 0x6d, 0x54, 0x5b, 0x33, 0xf6, 0x2c, 0x12, 0x79, 0x8b,
            0xa6, 0x13, 0xc7, 0x88,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
