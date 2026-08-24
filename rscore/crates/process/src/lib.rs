//! Long-lived, framed binary host for the deterministic Account batch engine.

mod canonical;
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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=7")
        // wire=7: the account seed and every job carry the authority's replica
        // shell (the Entity account-leaf projection plus the mempool in its
        // canonical frame-hash form), the engine derives the mempool root and
        // the Entity account leaf from it, and the summary row reports both.
        // wire=6: the seed carries rebalance policy and swap offer rows instead
        // of carried roots, Hello installs the swap market tables, the job
        // context carries the signed frame's J height, and the summary row
        // carries the engine-owned section roots, and swap outputs are the
        // canonical AccountOutput rows (upsert/remove/cancel-request), and the
        // prepared reply reports the engine's own execution microseconds. The fingerprint exists to
        // reject a binary built for the older shapes at Hello, so it moves
        // with every request/reply shape change.
        protocol_fingerprint: [
            0xfd, 0x65, 0xeb, 0xd7, 0xd1, 0xc1, 0x60, 0x2e, 0xde, 0x5c, 0x91, 0x46, 0xa4, 0xae,
            0x00, 0xe3, 0x34, 0x95, 0x0a, 0xd6, 0x79, 0xba, 0x08, 0x51, 0x15, 0x52, 0x0e, 0xd8,
            0x28, 0x49, 0x45, 0xd0,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
