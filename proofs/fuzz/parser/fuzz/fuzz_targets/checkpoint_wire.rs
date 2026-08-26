#![no_main]
//! C7 target 4 — checkpoint wire decode
//! (`rscore/crates/process/src/checkpoint_wire/decode.rs`) plus the entity
//! snapshot orderbook page wire it shares a session with.
//!
//! The checkpoint decoder is reached through the production session entry:
//! `ProcessSession::handle` with `op_tag` pinned to the checkpoint/bootstrap
//! family — RestoreExact (exact checkpoint restore rows), BootstrapAccounts
//! (seed accounts with consensus snapshots), BootstrapEntity (entity snapshot
//! with orderbook pages), AccountInbound/AccountOutbound (wave/peer halves).
//! Property: no panic in any decode path; rejection is a typed error and the
//! error-reply encoding stays panic-free.

use libfuzzer_sys::fuzz_target;
use xln_parser_fuzz_harness::{Cursor, fixed_bytes};
use xln_rscore_abi::{
    BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
};
use xln_rscore_process::ProcessSession;

const OPS: [OpTag; 5] = [
    OpTag::RestoreExact,
    OpTag::BootstrapAccounts,
    OpTag::BootstrapEntity,
    OpTag::AccountInbound,
    OpTag::AccountOutbound,
];

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);
    let op_tag = OPS[usize::from(cursor.u8()) % OPS.len()];
    let value = xln_parser_fuzz_harness::abi_value(&mut cursor, 8);
    let fingerprint = fixed_bytes::<32>(&mut cursor);
    let envelope = Envelope {
        binding: ProtocolBinding {
            protocol_version: 1,
            storage_schema_version: 1,
            protocol_fingerprint: fingerprint,
        },
        identity: EngineIdentity {
            engine_generation: [0; 8],
            runtime_id: [0; 20],
            session_id: [0; 16],
            request_id: [0; 8],
        },
        op_tag,
        message_kind: MessageKind::Request,
        body: BodyTuple::from_vec(vec![value]),
    };
    let mut session = ProcessSession::try_new().expect("process session entropy");
    let _reply = session.handle(envelope);
});
