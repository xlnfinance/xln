#![forbid(unsafe_code)]

//! Long-lived, framed binary host for the deterministic Account batch engine.

mod candidate;
mod canonical;
mod checkpoint_wire;
#[path = "wire/entity.rs"]
mod entity_wire;
mod error;
mod session;
#[cfg(feature = "bench")]
pub mod transcript;
mod transport;
#[path = "wire/decode.rs"]
mod wire_decode;
#[path = "wire/encode.rs"]
mod wire_encode;
#[path = "wire/value.rs"]
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
#[cfg(feature = "bench")]
pub use session::ResidentAuthorityBootstrap;
pub use session::{ProcessReply, ProcessSession};
pub use transport::{read_frame, serve, write_frame};

/// Decode one captured Entity round for a native replay without retaining the
/// process ABI in the execution loop. The capture is an import fixture; after
/// this boundary Runtime, Entity and Account communicate through typed values.
#[cfg(feature = "bench")]
pub fn decode_resident_entity_round(
    envelope: &xln_rscore_abi::Envelope,
) -> Result<
    (
        xln_rscore_entity_kernel::ResidentEntityRequest,
        xln_rscore_entity_kernel::DeterministicContext,
    ),
    ProcessError,
> {
    match wire_decode::decode_command(envelope)? {
        wire_decode::Command::EntityRound { request, context } => Ok((*request, *context)),
        _ => Err(ProcessError::Expected("entityRound")),
    }
}

/// Encode parity evidence after a native replay sample has stopped timing.
/// Production does not serialize this internal Entity/Account boundary.
#[cfg(feature = "bench")]
pub fn encode_resident_entity_round(
    result: &xln_rscore_entity_kernel::ResidentEntityResult,
    sections: &[xln_rscore_entity_kernel::EntityConsensusSection],
) -> Result<xln_rscore_abi::BodyTuple, ProcessError> {
    entity_wire::encode_entity_round(result, sections, 0)
}

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
// 21: an inbound row may carry trusted Entity genesis policy; the round reply
// has a separate exact H=1 materialization list for authenticated new Accounts.
// 22: AccountOutbound carries checkpointDue and the same reply carries the
// worker-resident checkpoint rows separately from temporary read-model rows.
// 23: that reply carries an optional exact incremental checkpoint manifest;
// the next inbound root implicitly accepts or rejects its pending baseline.
// 24: swap-offer removal carries the maker side observed by the Account
// transition, so the two-call parent never needs a stale Account read model.
// 25: AccountSettled J-claim bodies, witnesses and typed finality output.
// 26: exact checkpoints persist the J-claim Patricia nodes needed to prove
// non-empty accumulator roots after a process restart.
// 27: one resident Entity round owns Account inbound, paybook/orderbook work,
// and Account outbound without returning Account replicas to TypeScript.
pub const PROCESS_ABI_VERSION: u64 = 27;
pub const PROCESS_PROFILE: &str = "payment-v1";
pub const PAYMENT_PROFILE_BINDING: xln_rscore_abi::ProtocolBinding =
    xln_rscore_abi::ProtocolBinding {
        protocol_version: 1,
        storage_schema_version: 1,
        // sha256("xln.rscore.account:v1:protocol=1:storage=1:hanko:payment-v1:wire=31")
        // wire=30: checkpoint deltas and exact restore rows carry the
        // content-verified J-claim Patricia node store.
        // wire=29: AccountSettled J-claim transactions, Patricia witnesses,
        // and their typed finality output are part of the authority ABI.
        // wire=28: swap-offer removal carries its exact maker side because
        // the removed row is absent from the post-state.
        // wire=27: checkpoint rows are wrapped with exact incremental and
        // restore tokens; Nil means checkpointDue was false.
        // wire=26: checkpoint cadence is part of AccountOutbound and its
        // exact worker-resident delta is a separate round-reply field.
        // wire=25: peer rows carry optional Entity-owned genesis policy and
        // replies separate H=1 create materialization from final Account rows.
        // wire=24: outbound carries the reachable forwarded-HTLC route
        // closure; failed-lock rows bind the lock and exact generated upstream
        // resolution, so the second visit reaches fixed point without a third
        // process request.
        // wire=23: every proposal carries exact failed HTLC lock rows.
        // wire=22: direct two-visit authority has no rollback savepoint ops;
        // AccountInbound carries the parent's canonical forest root, which
        // promotes or drops the prior internal path-copy candidate.
        // wire=21: AccountOutbound names inbound-touched accounts whose final
        // bodies are returned only after all Entity-derived work has run.
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
            0x2b, 0xa0, 0x24, 0xe2, 0x94, 0xf2, 0x21, 0xb1, 0xd5, 0x3d, 0x46, 0xfc, 0xef, 0x3b,
            0xb2, 0x14, 0xd5, 0x5a, 0xee, 0x5d, 0x12, 0x84, 0xaf, 0xb5, 0xf4, 0x8a, 0xfa, 0xf5,
            0x7a, 0x0c, 0xc6, 0xd2,
        ],
    };

#[cfg(test)]
#[path = "tests/fixture.rs"]
mod test_fixture;
#[cfg(test)]
mod tests;
