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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=2")
        // wire=2: the seed carries rebalance policy rows instead of a carried
        // root, and the summary row carries the full account state root. The
        // fingerprint exists to reject a binary built for the older shapes at
        // Hello, so it moves with every request/reply shape change.
        protocol_fingerprint: [
            0x8d, 0x08, 0xcd, 0x9d, 0xa6, 0x52, 0xb3,
            0x42, 0xf3, 0xac, 0x3e, 0x6c, 0x59, 0x50,
            0xf4, 0xbb, 0x53, 0xcd, 0xae, 0xab, 0xfc,
            0xa1, 0x3f, 0x23, 0x43, 0x1c, 0xb2, 0xcd,
            0x8d, 0x02, 0x90, 0x2b
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
