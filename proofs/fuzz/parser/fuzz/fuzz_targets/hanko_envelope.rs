#![no_main]
//! C7 target 1 — Hanko envelope decoder (`rscore/crates/hanko/src/codec.rs`).
//!
//! Property: `decode_hanko_envelope(arbitrary bytes)` never panics, and an
//! accepted input is canonical — re-encoding the decoded envelope reproduces
//! the input byte for byte. (The decoder itself re-encodes and compares; this
//! harness re-checks that internal check independently.)

use libfuzzer_sys::fuzz_target;
use xln_rscore_hanko::{decode_hanko_envelope, encode_hanko_envelope};

fuzz_target!(|data: &[u8]| {
    let Ok(envelope) = decode_hanko_envelope(data) else {
        return;
    };
    let re_encoded =
        encode_hanko_envelope(&envelope).expect("accepted envelope must re-encode");
    assert_eq!(
        re_encoded, data,
        "HANKO_NON_CANONICAL_ACCEPTED: decode accepted bytes its encoder would not produce"
    );
});
