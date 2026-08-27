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
//!
//! Properties (wave-2, audit A3 — the reply is no longer discarded):
//! 1. No panic in any decode path.
//! 2. Typed error surface: every rejection replies `MessageKind::Error` with
//!    body `[Text(code), Text(message)]` where `code` is a non-empty
//!    `A-Z0-9_` error code from `ProcessError::code` — never a panic and
//!    never an unstructured body.
//! 3. Reply canonicality: every reply (Ok and Error) re-encodes byte-exactly
//!    through the production envelope encoder and decodes back to the
//!    identical value, and the reply preserves the request's op tag.

use libfuzzer_sys::fuzz_target;
use xln_parser_fuzz_harness::{Cursor, fixed_bytes};
use xln_rscore_abi::{
    AbiValue, BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
    decode_envelope, encode_envelope,
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
    let reply = session.handle(envelope.clone());

    // The reply keeps the request's operation and session identity.
    assert_eq!(
        reply.envelope.op_tag, envelope.op_tag,
        "CHECKPOINT_REPLY_OP_TAG_DIVERGED"
    );
    assert_eq!(
        reply.envelope.identity, envelope.identity,
        "CHECKPOINT_REPLY_IDENTITY_DIVERGED"
    );

    match reply.envelope.message_kind {
        MessageKind::Ok => {
            let bytes = encode_envelope(&reply.envelope)
                .expect("CHECKPOINT_OK_REPLY_MUST_ENCODE: encoder rejected a session Ok reply");
            let arity = reply.envelope.body.fields().len();
            let re_decoded = decode_envelope(&bytes, arity)
                .expect("CHECKPOINT_OK_REPLY_BYTES_MUST_DECODE: encoder output rejected by decoder");
            assert_eq!(
                re_decoded, reply.envelope,
                "CHECKPOINT_OK_REPLY_NOT_CANONICAL: decode(encode(reply)) != reply"
            );
        }
        MessageKind::Error => {
            let fields = reply.envelope.body.fields();
            assert_eq!(
                fields.len(),
                1,
                "CHECKPOINT_ERROR_BODY_ARITY: expected one error tuple, got {}",
                fields.len()
            );
            let AbiValue::Tuple(inner) = &fields[0] else {
                panic!("CHECKPOINT_ERROR_BODY_SHAPE: {fields:?}");
            };
            let inner = inner.fields();
            assert_eq!(
                inner.len(),
                2,
                "CHECKPOINT_ERROR_BODY_FIELDS: expected [code, message]"
            );
            let AbiValue::Text(code) = &inner[0] else {
                panic!("CHECKPOINT_ERROR_CODE_NOT_TEXT: {inner:?}");
            };
            assert!(
                !code.is_empty()
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
                "CHECKPOINT_ERROR_CODE_UNTYPED: {code:?}"
            );
            let AbiValue::Text(message) = &inner[1] else {
                panic!("CHECKPOINT_ERROR_MESSAGE_NOT_TEXT: {inner:?}");
            };
            assert!(!message.is_empty(), "CHECKPOINT_ERROR_MESSAGE_EMPTY");
            // Error replies must stay canonical wire values too.
            let bytes = encode_envelope(&reply.envelope)
                .expect("CHECKPOINT_ERROR_REPLY_MUST_ENCODE");
            let arity = reply.envelope.body.fields().len();
            let re_decoded = decode_envelope(&bytes, arity)
                .expect("CHECKPOINT_ERROR_REPLY_BYTES_MUST_DECODE");
            assert_eq!(
                re_decoded, reply.envelope,
                "CHECKPOINT_ERROR_REPLY_NOT_CANONICAL"
            );
        }
        MessageKind::Request => {
            panic!("CHECKPOINT_REPLY_KIND_REQUEST: session echoed a request kind");
        }
    }
});
