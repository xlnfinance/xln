#![no_main]
//! C7 target 3 — process wire decoders
//! (`rscore/crates/process/src/wire/decode.rs`, wave/peer input decode).
//!
//! Two modes share one input:
//! - mode 0: raw wire bytes → `decode_wire_value` → `decode_account_tx`;
//!   acceptance is canonical: an Ok transaction re-encodes (`encode_account_tx`)
//!   to the exact same `AbiValue`, which re-serializes to the exact same bytes
//!   (`encode_wire_value`). This is the property `tx_wire_vectors.rs` holds for
//!   TypeScript vectors, generalized to arbitrary inputs.
//! - mode 1: generated `AbiValue` body → production `ProcessSession::handle`
//!   entry. A fresh (unbound) session decodes the full command — wave/peer
//!   inputs, frames, ACKs, jobs, txs — for every op tag before rejecting
//!   non-Hello commands. Property: no panic anywhere in decode or in the
//!   error-reply encoding.

use libfuzzer_sys::fuzz_target;
use xln_parser_fuzz_harness::{Cursor, fixed_bytes};
use xln_rscore_abi::{
    BodyTuple, EngineIdentity, Envelope, MessageKind, OpTag, ProtocolBinding,
};
use xln_rscore_process::{
    ProcessSession, decode_account_tx, decode_wire_value, encode_account_tx, encode_wire_value,
};

/// True when any text leaf parses as a BigInt but is not the minimal decimal
/// spelling `BigInt::to_string()` produces — the recorded finding F1 class.
/// A re-encode mismatch on input whose texts are all minimal would be an
/// unknown canonicality break and panics.
fn explains_nonminimal_bigint_text(value: &xln_rscore_abi::AbiValue) -> bool {
    use xln_rscore_abi::AbiValue;
    match value {
        AbiValue::Text(text) => match text.parse::<num_bigint::BigInt>() {
            Ok(parsed) => parsed.to_string() != *text,
            Err(_) => false,
        },
        AbiValue::Tuple(tuple) => tuple
            .fields()
            .iter()
            .any(explains_nonminimal_bigint_text),
        _ => false,
    }
}

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);
    match cursor.u8() % 2 {
        0 => {
            let bytes = data.get(1..).unwrap_or(&[]);
            let Ok(value) = decode_wire_value(bytes) else {
                return;
            };
            // The value codec is a documented normalizing decoder
            // (`decode(encode(x)) = normalize(x)`); byte-level canonicality is
            // the envelope decoder's contract (target abi_envelope). Here the
            // byte-level round trip is asserted only for inputs that were
            // already canonical msgpack.
            let canonical_input = encode_wire_value(&value)
                .is_ok_and(|re| re.as_slice() == bytes);
            let Ok(tx) = decode_account_tx(&value) else {
                return;
            };
            let re_encoded =
                encode_account_tx(&tx).expect("accepted tx must re-encode");
            if re_encoded != value {
                // FINDING F1 (recorded in report.md): the bigint text reader
                // accepts non-minimal decimal spellings ("0850000000000"),
                // the encoder emits the minimal one. Skip exactly that known
                // class; anything else is an unknown canonicality break.
                assert!(
                    explains_nonminimal_bigint_text(&value),
                    "TX_REENCODE_MISMATCH: decode(encode(tx)) != decoded value \
                     beyond the known non-minimal bigint text class (F1)"
                );
                return;
            }
            if canonical_input {
                let re_serialized = encode_wire_value(&re_encoded)
                    .expect("accepted tx value must re-serialize");
                assert_eq!(
                    re_serialized, bytes,
                    "TX_BYTES_NON_CANONICAL_ACCEPTED: canonical input re-serialized to different bytes"
                );
            }
        }
        _ => {
            let op_byte = cursor.u8();
            let op_tag = OpTag::try_from(u64::from(op_byte % 31)).unwrap_or(OpTag::Shutdown);
            let value = xln_parser_fuzz_harness::abi_value(&mut cursor, 8);
            let fingerprint = fixed_bytes::<32>(&mut cursor);
            let generation = fixed_bytes::<8>(&mut cursor);
            let runtime_id = fixed_bytes::<20>(&mut cursor);
            let session_id = fixed_bytes::<16>(&mut cursor);
            let request_id = fixed_bytes::<8>(&mut cursor);
            let envelope = Envelope {
                binding: ProtocolBinding {
                    protocol_version: u32::from(cursor.u8()) << 8 | u32::from(cursor.u8()),
                    storage_schema_version: 1,
                    protocol_fingerprint: fingerprint,
                },
                identity: EngineIdentity {
                    engine_generation: generation,
                    runtime_id,
                    session_id,
                    request_id,
                },
                op_tag,
                message_kind: MessageKind::Request,
                body: BodyTuple::from_vec(vec![value]),
            };
            let mut session =
                ProcessSession::try_new().expect("process session entropy");
            // Full command decode happens inside handle() before any session
            // state check for an unbound session. Must never panic.
            let _reply = session.handle(envelope);
        }
    }
});
