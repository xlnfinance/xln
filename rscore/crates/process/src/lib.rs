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
// 13: every parent Entity input owns an idempotent savepoint inside the held
// Runtime candidate. Apply/Propose are bound to that exact stage key; rejected
// Entity inputs roll back their Account mutations and operation indices.
// 14: peer inputs carry the exact canonical envelope and Frame/Ack/FrameAck
// shapes. FrameAck is one atomic operation with one ordered composite result.
pub const PROCESS_ABI_VERSION: u64 = 16;
pub const PROCESS_PROFILE: &str = "payment-v1";
pub const PAYMENT_PROFILE_BINDING: xln_rscore_abi::ProtocolBinding =
    xln_rscore_abi::ProtocolBinding {
        protocol_version: 1,
        storage_schema_version: 1,
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=20")
        // wire=20: Account peer inputs carry from/to/domain/dispute/watch-seed
        // exactly, received frames retain deltas and optional Hankos, disputes
        // retain their claimed hash, and FrameAck is one ACK-first result row.
        // wire=19: BeginEntity/FinalizeEntity/DiscardEntity delimit one
        // abortable parent Entity input, and Apply/Propose carry its stage key.
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
            0x07, 0x20, 0xc8, 0x39, 0xd3, 0x87, 0x4f, 0x4a, 0x70, 0xe3, 0x58, 0xf5, 0xf7, 0xe2,
            0xb7, 0xf7, 0x8c, 0xf2, 0xa3, 0xcb, 0x21, 0x32, 0x90, 0x6a, 0xe0, 0x5c, 0xdd, 0x73,
            0x65, 0xf8, 0xb3, 0xa7,
        ],
    };

#[cfg(test)]
#[path = "tests/fixture.rs"]
mod test_fixture;
#[cfg(test)]
mod tests;
