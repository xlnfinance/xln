#![no_main]
//! C7 target 7 — protocol canonical value layer
//! (`rscore/crates/protocol/src/value.rs`, `consensus_msgpack.rs`, `flat.rs`).
//!
//! `consensus_msgpack.rs` and `flat.rs` are encoders/readers by design: the
//! module header of `consensus_msgpack.rs` states it is "intentionally an
//! encoder only" — no byte-level reader is exposed anywhere in the crate
//! (verified: `lib.rs` exports only `encode_canonical_consensus_bytes`,
//! `compute_flat_integrity_root`, `RlpWriter` and value constructors). So the
//! decodable surface here is the string boundary `CanonicalNumber::parse_js_canonical`
//! plus the encoders' no-panic/limits properties on generated values:
//!
//! 1. `parse_js_canonical(arbitrary utf8)` never panics; acceptance is
//!    canonical-only: `Ok` ⇒ `as_str() == input` (ryu_js equality).
//! 2. `encode_canonical_consensus_bytes` / `encode_account_state_value` /
//!    `compute_flat_integrity_root` never panic on generated values
//!    (duplicate keys, record-shape exhaustion, huge integers included) and
//!    produce output bounded by `input_len * 4 + 4096`.

use libfuzzer_sys::fuzz_target;
use num_bigint::BigInt;
use xln_parser_fuzz_harness::{Cursor, decimal_string, hex_string};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, compute_flat_integrity_root,
    encode_account_state_value, encode_canonical_consensus_bytes,
};

fn canonical_value(cur: &mut Cursor, depth: u8) -> CanonicalValue {
    let tag = cur.u8();
    if depth == 0 {
        return match tag % 3 {
            0 => CanonicalValue::Null,
            1 => CanonicalValue::Bool(tag & 1 == 1),
            _ => CanonicalValue::String(decimal_string(cur, 32)),
        };
    }
    match tag % 10 {
        0 => CanonicalValue::Null,
        1 => CanonicalValue::Bool(tag & 1 == 1),
        2 => CanonicalValue::Number(
            CanonicalNumber::try_from_u64(cur.be_u64(8) % (1_u64 << 53))
                .expect("safe integer"),
        ),
        // Ryu-rendered decimals: canonical Number text, sometimes corrupted.
        3 => {
            let length = usize::from(cur.u8()) % 32;
            let text = String::from_utf8_lossy(cur.take(length)).into_owned();
            match CanonicalNumber::parse_js_canonical(&text) {
                Ok(number) => CanonicalValue::Number(number),
                Err(_) => CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(cur.u8()))),
            }
        }
        4 => CanonicalValue::BigInt(BigInt::parse_bytes(
            decimal_string(cur, 48).as_bytes(),
            10,
        )
        .unwrap_or_else(|| BigInt::from(0_u8))),
        5 => CanonicalValue::BigInt(BigInt::from(cur.be_i128(16))),
        6 => {
            let length = usize::from(cur.u8()) % 256;
            CanonicalValue::String(String::from_utf8_lossy(cur.take(length)).into_owned())
        }
        7 => CanonicalValue::Array(
            (0..usize::from(cur.u8()) % 16)
                .map(|_| canonical_value(cur, depth - 1))
                .collect(),
        ),
        8 => CanonicalValue::Map(
            (0..usize::from(cur.u8()) % 8)
                .map(|index| {
                    let key = if index % 2 == 0 {
                        CanonicalValue::String(decimal_string(cur, 16))
                    } else {
                        CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(cur.u8())))
                    };
                    (key, canonical_value(cur, depth - 1))
                })
                .collect(),
        ),
        _ => CanonicalValue::Object(
            (0..usize::from(cur.u8()) % 8)
                .map(|index| {
                    // Repeated keys on purpose: duplicate-key rejection must be
                    // a typed error, never a panic.
                    let key = if index % 3 == 0 {
                        "k".to_string()
                    } else {
                        let length = usize::from(cur.u8()) % 16;
                        String::from_utf8_lossy(cur.take(length)).into_owned()
                    };
                    (key, canonical_value(cur, depth - 1))
                })
                .collect(),
        ),
    }
}

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);

    // Property 1 — canonical-only acceptance at the number text boundary.
    let text_length = usize::from(cursor.u8()).min(64);
    let text = String::from_utf8_lossy(cursor.take(text_length)).into_owned();
    if let Ok(number) = CanonicalNumber::parse_js_canonical(&text) {
        assert_eq!(
            number.as_str(),
            text,
            "CANONICAL_NUMBER_NON_CANONICAL_ACCEPTED"
        );
    }

    // Property 2 — encoders: no panic, bounded output.
    let value = canonical_value(&mut cursor, 6);
    if let Ok(bytes) = encode_canonical_consensus_bytes(&value) {
        assert!(
            bytes.len() <= data.len() * 4 + 4096,
            "CONSENSUS_ENCODE_BLOWUP: {} output bytes for {} input bytes",
            bytes.len(),
            data.len()
        );
    }
    if let Ok(bytes) = encode_account_state_value(&value) {
        assert!(
            bytes.len() <= data.len() * 8 + 8192,
            "STATE_ENCODE_BLOWUP: {} output bytes for {} input bytes",
            bytes.len(),
            data.len()
        );
    }
    let namespace = String::from_utf8_lossy(cursor.take(16)).into_owned();
    let path = String::from_utf8_lossy(cursor.take(32)).into_owned();
    let _ = compute_flat_integrity_root(
        &namespace,
        &[(path, value), (hex_string(&cursor.take(32)), CanonicalValue::Null)],
    );
});
