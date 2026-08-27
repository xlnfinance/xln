#![no_main]
//! C7 wave-2 target 9 — exact Runtime WAL decode path
//! (`rscore/crates/runtime/src/restore/wal_input.rs`, listed by the audit as
//! `process/src/runtime_replay/wal_input.rs::decode_wal_runtime_input` — the
//! crate has since moved it into `runtime::restore`).
//!
//! Public surface reached:
//! - `decode_concrete_runtime_wal_frame(ConcreteWalSource, context_policy, …)`
//!   → `verify_wal_source` → `storage::native::validate_runtime_frame`
//!   (msgpack decode + typed field validation + frame-hash recompute +
//!   exact-canonical-bytes check) and the WAL header/context-set gates.
//! - `RuntimeEntityInput::decode` — the exact per-row decoder wal_input.rs
//!   invokes on every `frame.runtimeInput.entityInputs[i]` entry (entity
//!   transport validation, `project_entity_tx`, signed-command decode,
//!   account-input JSON rows, canonical wire sizing).
//!
//! Scoped gap (documented in report.md): the post-framing JSON field lanes of
//! wal_input.rs itself (runtimeTxs/jInputs validation) execute only after the
//! frame-hash recompute succeeds, and no public API or committed fixture can
//! produce canonical frame bytes from outside the crate
//! (`build_runtime_frame_commit` returns `EncodedRuntimeFrame` with
//! `pub(crate)` fields; `RuntimeDurableEnvelope::fixture_for_runtime` is
//! `pub(crate)`). Those lanes stay behind a valid-frame seed the owner can
//! provide later; everything up to and including the hash gate is fuzzed.
//!
//! Properties:
//! 1. No panic anywhere in either decoder.
//! 2. Typed error surface: every `decode_concrete_runtime_wal_frame`
//!    rejection carries the `RRS_RESTORE_WAL_DECODE:` prefix (single typed
//!    enum); every `RuntimeEntityInput::decode` rejection is a typed
//!    `RuntimeMachineError` (asserted by enum formatting, not a panic).
//! 3. Consistency: an accepted WAL frame must agree with an independent
//!    `validate_runtime_frame` run on the same bytes (height, frame hash,
//!    previous frame hash).

use std::collections::BTreeMap;

use libfuzzer_sys::fuzz_target;
use xln_parser_fuzz_harness::Cursor;
use xln_rscore_runtime::restore::{
    ConcreteWalSource, VerifiedEntityContext, decode_concrete_runtime_wal_frame,
};
use xln_rscore_runtime::storage::native::validate_runtime_frame;
use xln_rscore_runtime::RuntimeEntityInput;

fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Deterministic per-execution WAL source from raw fuzz bytes: frame bytes
/// verbatim, plus header/context knobs that drive the WAL_HEADER and
/// CONTEXT_SET gates once framing itself passes.
fn wal_source_from_cursor(cursor: &mut Cursor) -> ConcreteWalSource {
    let height = cursor.be_u64(4);
    let outputs_count = usize::from(cursor.u8() % 8);
    let outputs: Vec<Vec<u8>> = (0..outputs_count)
        .map(|index| {
            let mut row = cursor.take(24).to_vec();
            row.resize(24, u8::try_from(index).unwrap_or(0));
            row
        })
        .collect();
    let contexts_count = usize::from(cursor.u8() % 3);
    let mut entity_contexts = BTreeMap::new();
    for _ in 0..contexts_count {
        // Replica ids must look like `entity32hex:signer20hex[:cohort]` for
        // context_refs to compare them (mismatched digests exercise the
        // CONTEXT_SET typed error, malformed ids its parsing errors).
        let entity_len = (usize::from(cursor.u8()) % 64 + 1).min(32);
        let entity = lower_hex(&{
            let mut bytes = cursor.take(entity_len).to_vec();
            bytes.resize(32, 0x11);
            bytes
        });
        let signer_len = (usize::from(cursor.u8()) % 40 + 1).min(20);
        let signer = lower_hex(&{
            let mut bytes = cursor.take(signer_len).to_vec();
            bytes.resize(20, 0x22);
            bytes
        });
        let value_len = (cursor.be_u64(2) as usize).min(1024);
        let value = serde_json::from_slice(cursor.take(value_len)).unwrap_or(serde_json::Value::Null);
        entity_contexts.insert(
            format!("{entity}:{signer}"),
            VerifiedEntityContext {
                commitment: xln_parser_fuzz_harness::fixed_bytes::<32>(cursor),
                value,
            },
        );
    }
    let frame_len = (cursor.be_u64(3) as usize).min(65536);
    let frame_bytes = cursor.take(frame_len).to_vec();
    ConcreteWalSource {
        height,
        frame_bytes,
        entity_contexts,
        outputs,
    }
}

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);
    let mode = cursor.u8() % 3;

    // Deterministic context policy: [be_u64(2) length][bytes] so a real JSON
    // policy can coexist with the per-mode fields that follow.
    let policy_len = (cursor.be_u64(2) as usize).min(512);
    let context_policy =
        serde_json::from_slice::<serde_json::Value>(cursor.take(policy_len)).unwrap_or_default();
    let finalized_j_height = cursor.be_u64(4);
    let hub_rebalance_has_pending_work = cursor.u8() & 1 == 1;

    match mode {
        // Modes 0/1: the WAL framing gate over raw bytes. Mode 1 additionally
        // truncates the frame (length-prefix / EOF boundary probing).
        0 | 1 => {
            let mut source = wal_source_from_cursor(&mut cursor);
            if mode == 1 && !source.frame_bytes.is_empty() {
                let cut = usize::from(cursor.u8() % 16).min(source.frame_bytes.len());
                let keep = source.frame_bytes.len() - cut;
                source.frame_bytes.truncate(keep);
            }
            match decode_concrete_runtime_wal_frame(
                &source,
                &context_policy,
                finalized_j_height,
                hub_rebalance_has_pending_work,
            ) {
                Ok(frame) => {
                    let validated = validate_runtime_frame(&source.frame_bytes)
                        .expect("WAL_DECODE_ACCEPTED_UNVALIDATED: decoder accepted bytes the framing validator rejects");
                    assert_eq!(
                        frame.height, validated.height,
                        "WAL_DECODE_HEIGHT_DIVERGENCE"
                    );
                    assert_eq!(
                        frame.expected_frame_hash, validated.frame_hash,
                        "WAL_DECODE_FRAME_HASH_DIVERGENCE"
                    );
                    assert_eq!(
                        frame.expected_previous_frame_hash, validated.prev_frame_hash,
                        "WAL_DECODE_PREV_HASH_DIVERGENCE"
                    );
                }
                Err(error) => {
                    assert!(
                        error.to_string().starts_with("RRS_RESTORE_WAL_DECODE:"),
                        "WAL_DECODE_UNTYPED_ERROR: {error:?}"
                    );
                }
            }
        }
        // Mode 2: the per-row entity-input decoder wal_input.rs drives on
        // every entityInputs entry — [be_u64(2) length][JSON bytes] in, typed
        // error out.
        _ => {
            let json_len = (cursor.be_u64(2) as usize).min(65536);
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(cursor.take(json_len))
            else {
                return;
            };
            match RuntimeEntityInput::decode(value) {
                Ok(input) => {
                    assert!(
                        input.canonical_wire_bytes() > 0,
                        "WAL_ENTITY_INPUT_EMPTY_WIRE"
                    );
                    let expected = lower_hex(input.entity_id());
                    assert_eq!(
                        input
                            .canonical()
                            .get("entityId")
                            .and_then(serde_json::Value::as_str),
                        Some(expected.as_str()),
                        "WAL_ENTITY_INPUT_ID_DIVERGENCE"
                    );
                }
                Err(error) => {
                    // Typed rejection: the error is a RuntimeMachineError
                    // variant with a rendered diagnostic, never a panic.
                    let text = error.to_string();
                    assert!(!text.is_empty(), "WAL_ENTITY_INPUT_SILENT_ERROR");
                }
            }
        }
    }
});
