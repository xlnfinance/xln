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
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=10")
        // wire=10: every job carries the authority for its account input
        // (frame digest, signature, expected signer) or null, and the engine
        // recovers the signer itself before the transaction touches state.
        // wire=9: RemoveAccounts drops an account the caller stopped
        // mirroring, so an abandoned leaf cannot hold the whole tree apart.
        // wire=8: UpdateAccountShells refreshes a replica shell without
        // touching the financial state, so the engine's leaf tracks the
        // Entity's leaf between account frames as well.
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
            0x41, 0x67, 0x09, 0x84, 0x43, 0x19, 0x32, 0x49, 0xc0, 0x83, 0x0a, 0xaf, 0x37, 0x90,
            0x42, 0x96, 0x1a, 0x1a, 0x8a, 0x0f, 0x84, 0xfe, 0xf4, 0x8a, 0xfd, 0xae, 0xfa, 0x1e,
            0x29, 0x7e, 0x40, 0xc0,
        ],
    };

#[cfg(test)]
mod test_fixture;
#[cfg(test)]
mod tests;
