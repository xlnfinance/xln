//! Long-lived, framed binary host for the deterministic Account batch engine.

mod candidate;
mod canonical;
mod checkpoint_wire;
mod error;
mod session;
mod transport;
mod wire_decode;
mod wire_encode;
mod wire_value;

pub use error::ProcessError;

/// The transaction codec, exposed for the cross-language vector test: the wire
/// is a contract with TypeScript, so it is checked against bytes TypeScript
/// wrote rather than only against this crate's own round trip.
pub fn decode_account_tx(
    value: &xln_rscore_abi::AbiValue,
) -> Result<xln_rscore_engine::AccountTx, ProcessError> {
    wire_decode::decode_tx(value)
}

pub fn encode_account_tx(
    tx: &xln_rscore_engine::AccountTx,
) -> Result<xln_rscore_abi::AbiValue, ProcessError> {
    wire_encode::tx(tx)
}

pub fn decode_wire_value(bytes: &[u8]) -> Result<xln_rscore_abi::AbiValue, ProcessError> {
    Ok(xln_rscore_abi::decode_value(bytes)?)
}

pub fn encode_wire_value(value: &xln_rscore_abi::AbiValue) -> Result<Vec<u8>, ProcessError> {
    Ok(xln_rscore_abi::encode_value(value)?)
}
pub use session::{ProcessReply, ProcessSession};
pub use transport::{read_frame, serve, write_frame};

// 2: Hello carries the authority config, and the authoritative wave joins the
// op set. An older runtime fails at Hello rather than at the first wave.
// 5: that config carries the signer key instead of the runtime seed.
// 6: exact recovery also carries our historical committed-frame Hanko. An
// older runtime fails at Hello rather than losing dispute evidence on restart.
// 7: the diagnostic Account-envelope read and checkpoint operations occupy
// distinct tags in one closed operation set.
// 8: checkpoint changes are bound to the exact pending authority wave and
// return separate live-commit and durable-restore tokens.
// 9: authority waves are staged apply/propose rounds, sealed before checkpoint
// or commit, with candidate-wide operation indices and admission receipts.
// 10: WaveOp::Create installs a strictly validated genesis Account atomically
// inside the same staged candidate as its first admission or peer input.
// 11: Prepare returns a server-issued 32-byte candidate capability bound to a
// fresh process incarnation, the complete session identity, request id and
// monotonic batch candidate id. Every later candidate operation consumes it.
// 12: committed input verdicts carry the exact Account frame and commit
// provenance Entity needs, and exact checkpoints retain the ACK frame Hanko.
pub const PROCESS_ABI_VERSION: u64 = 12;
pub const PROCESS_PROFILE: &str = "payment-v1";
pub const PAYMENT_PROFILE_BINDING: xln_rscore_abi::ProtocolBinding =
    xln_rscore_abi::ProtocolBinding {
        protocol_version: 1,
        storage_schema_version: 1,
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=18")
        // wire=18: commit verdicts carry the exact committed frame and
        // provenance, and exact OutboundAck rows preserve their frame Hanko.
        // wire=17: request ids no longer masquerade as candidate handles;
        // Prepare returns one opaque bin32 token consumed by every later
        // stage, checkpoint read, Commit and Abort.
        // wire=16: ordered wave operations add Create as
        // [2, operationIndex, accountSeed], allowing the first Account input
        // to execute without a non-atomic bootstrap/upsert escape hatch.
        // wire=15: Prepare opens and applies only; Apply/Propose repeat under
        // one candidate token and Seal freezes the cumulative transcript.
        // wire=14: GetCheckpointChanges names the pending PrepareAccountWave
        // request and returns both the live commit token and normalized
        // RestoreExact token before the runtime WAL is written.
        // wire=13: ReadAccountEnvelope keeps tag 18 and the exact checkpoint
        // operations follow at tags 19-21, with no request alias between them.
        // wire=12: the exact consensus snapshot carries the local committed
        // frame Hanko required by canonical Account storage and disputes.
        // wire=11: exact checkpoint changes, acknowledgement and restore are
        // part of the process contract; tag 1 is bootstrap, never recovery.
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
            0x7d, 0x69, 0xbb, 0x5f, 0x69, 0x16, 0xdf, 0x6e, 0x7a, 0x48, 0x71, 0x1a, 0xe7, 0xb0,
            0x8b, 0xb1, 0xc1, 0x46, 0x6b, 0x90, 0x7b, 0xdb, 0x05, 0xdd, 0x98, 0x9d, 0x05, 0x39,
            0xa0, 0x31, 0x65, 0x85,
        ],
    };

#[cfg(test)]
#[path = "tests/fixture.rs"]
mod test_fixture;
#[cfg(test)]
mod tests;
