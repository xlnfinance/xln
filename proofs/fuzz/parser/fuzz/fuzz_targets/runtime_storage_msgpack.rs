#![no_main]
//! C7 wave-2 target 8 — runtime storage msgpack decoder
//! (`rscore/crates/runtime/src/codec/storage_msgpack.rs::decode_storage_payload`,
//! reached from LevelDB-persisted frames/WAL/checkpoints and the runtime
//! transport socket). Audit findings A1 (crate uncovered) and A2 (the
//! unbounded `with_capacity` reservation that `require_fits_input` now
//! guards — the guard is committed production code, this target proves it).
//!
//! Properties, asserted on EVERY execution:
//! 1. `decode_storage_payload(arbitrary bytes)` never panics (libFuzzer+ASan).
//! 2. A2 regression: nested `array32`/`map32` markers each claiming
//!    2,000,000 entries (the audit's 41-byte input, previously 8 × 64 MiB of
//!    reservations before the first failure) must reject fast with the typed
//!    `Truncated`/`Container` error while allocating a near-zero number of
//!    bytes; a claim above `MAX_CONTAINER_ENTRIES` rejects with `Container`.
//! 3. A2 accept-side: the guard must not over-reject — small fixarray/
//!    array16/array32/map16 containers whose claims DO fit in the remaining
//!    input still decode.
//! 4. Allocation budgets (counting global allocator): accepted decode stays
//!    linear in the input; rejected decode stays within the designed
//!    `MAX_DEPTH × remaining × size_of::<Value>()` envelope (at most 256
//!    in-flight reservations, each capped at the unread byte count by the
//!    guard under test).
//! 5. Normalizing round-trip: `decode → canonical_value_from_tagged_json →
//!    encode_storage_payload → decode` is idempotent (the storage codec is a
//!    documented normalizing decoder; byte-canonicality is enforced one layer
//!    up by `validate_runtime_frame::validate_exact_bytes`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use libfuzzer_sys::fuzz_target;
use xln_rscore_runtime::{
    StorageMessagePackError, canonical_value_from_tagged_json, decode_storage_payload,
    encode_storage_payload,
};

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static FREED: AtomicUsize = AtomicUsize::new(0);

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // The old block is gone: credit its size to FREED so the live-bytes
        // difference stays exact across capacity growth.
        FREED.fetch_add(layout.size(), Ordering::Relaxed);
        ALLOCATED.fetch_add(new_size, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        FREED.fetch_add(layout.size(), Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// `runtime/src/codec/storage_msgpack.rs:14` — private in production; the
/// reject budget mirrors the designed in-flight reservation envelope.
const MAX_DEPTH: usize = 256;

fn decode_counted(bytes: &[u8]) -> (Result<serde_json::Value, StorageMessagePackError>, usize) {
    // Snapshot deltas instead of resetting the counters, so the global
    // live-bytes difference (ALLOCATED - FREED) stays meaningful.
    let start = ALLOCATED.load(Ordering::Relaxed);
    let outcome = decode_storage_payload(bytes);
    let allocated = ALLOCATED.load(Ordering::Relaxed) - start;
    (outcome, allocated)
}

/// A2 regression + accept-side, asserted on every execution so any regression
/// of the `require_fits_input` guard fails the very first input, not only the
/// committed corpus members.
fn assert_a2_guard() {
    // (1) The audit's 41-byte nested-array32 construction: `0x03` magic, then
    // eight levels of `dd 00 1e 84 80` (array32 claiming 2,000,000 entries).
    let mut nested_array = vec![0x03_u8];
    for _ in 0..8 {
        nested_array.extend_from_slice(&[0xdd, 0x00, 0x1e, 0x84, 0x80]);
    }
    let (outcome, allocated) = decode_counted(&nested_array);
    assert!(
        matches!(
            outcome,
            Err(StorageMessagePackError::Truncated { .. })
                | Err(StorageMessagePackError::Container(_))
        ),
        "A2_REGRESSION_HUGE_ARITY_ACCEPTED: {outcome:?}"
    );
    assert!(
        allocated <= 8192,
        "A2_REGRESSION_RESERVATION_BEFORE_REJECT: {allocated} bytes for a 41-byte input"
    );

    // (2) Same construction with map32 markers (each claiming 2M pairs).
    let mut nested_map = vec![0x03_u8];
    for _ in 0..8 {
        nested_map.extend_from_slice(&[0xdf, 0x00, 0x1e, 0x84, 0x80]);
    }
    let (outcome, allocated) = decode_counted(&nested_map);
    assert!(
        matches!(
            outcome,
            Err(StorageMessagePackError::Truncated { .. })
                | Err(StorageMessagePackError::Container(_))
        ),
        "A2_REGRESSION_HUGE_MAP_ARITY_ACCEPTED: {outcome:?}"
    );
    assert!(
        allocated <= 8192,
        "A2_REGRESSION_MAP_RESERVATION_BEFORE_REJECT: {allocated} bytes for a 41-byte input"
    );

    // (3) A single claim above MAX_CONTAINER_ENTRIES (2,000,000) is a typed
    // Container error straight from the length reader.
    let (outcome, _) = decode_counted(&[0x03, 0xdd, 0xff, 0xff, 0xff, 0xff]);
    assert!(
        matches!(outcome, Err(StorageMessagePackError::Container(_))),
        "A2_CONTAINER_LIMIT_NOT_ENFORCED: {outcome:?}"
    );

    // (4) Accept-side: claims that fit in the remaining input still decode.
    let accepted: &[(&str, &[u8])] = &[
        ("fixarray", &[0x03, 0x91, 0x01]),
        ("array16", &[0x03, 0xdc, 0x00, 0x03, 0x01, 0x02, 0x03]),
        ("array32", &[0x03, 0xdd, 0x00, 0x00, 0x00, 0x02, 0xc2, 0xc3]),
        ("fixmap", &[0x03, 0x81, 0x01, 0xa1, b'a']),
        ("map16", &[0x03, 0xde, 0x00, 0x01, 0x01, 0x02]),
        (
            "nested",
            &[0x03, 0x92, 0x91, 0x01, 0xdc, 0x00, 0x01, 0x05],
        ),
    ];
    for (name, bytes) in accepted {
        let (outcome, _) = decode_counted(bytes);
        assert!(
            outcome.is_ok(),
            "A2_GUARD_OVER_REJECTS_{name}: {outcome:?}"
        );
    }
}

fn live_bytes() -> usize {
    ALLOCATED.load(Ordering::Relaxed) - FREED.load(Ordering::Relaxed)
}

/// One execution of the decoder body. Kept as a function so every decoded
/// artifact is dropped on return — the leak gate in the fuzz entry then sees
/// a clean live-bytes baseline.
fn run_body(data: &[u8]) {
    assert_a2_guard();
    let value_size = std::mem::size_of::<serde_json::Value>();
    // Accepted: every value consumes ≥ 1 marker byte, but each tagged-Map /
    // record wrapper materializes a serde_json BTreeMap node (~616 B for the
    // first entries) plus row Vecs, so the constant per input byte is large
    // (observed peak: 114,828 B for a 176-byte nested-fixmap input ≈ 652 B
    // per byte) while staying LINEAR. The budget asserts linearity with a
    // ~1 KB/byte envelope — any superlinear growth (the A2/O1 class)
    // exceeds it quickly at libFuzzer input sizes.
    let accept_budget = data.len() * 1024 + 65536;
    // Rejected: at most MAX_DEPTH in-flight reservations, each bounded by the
    // unread byte count by the `require_fits_input` guard under test, plus
    // the same linear wrapper constants for the accepted prefix.
    let reject_budget = MAX_DEPTH * (data.len() + 1) * value_size + data.len() * 1024 + 65536;

    let (decoded, allocated) = decode_counted(data);
    match &decoded {
        Ok(_) => assert!(
            allocated <= accept_budget,
            "RUNTIME_STORAGE_ACCEPT_ALLOC_UNBOUNDED: allocated {allocated} for {} input bytes",
            data.len()
        ),
        Err(_) => assert!(
            allocated <= reject_budget,
            "RUNTIME_STORAGE_REJECT_ALLOC_UNBOUNDED: allocated {allocated} for {} input bytes",
            data.len()
        ),
    }

    let Ok(value) = decoded else {
        return;
    };
    // Normalizing round-trip through the canonical value layer. FINDING F4
    // (recorded in report.md): the tagged-Map lane SORTS entries on
    // re-encode, so decode(encode(decode(b))) can differ from decode(b) by
    // row order — the value layer is a documented normalizing codec (same
    // class as F3), with byte-canonicality enforced one layer up by
    // `validate_runtime_frame::validate_exact_bytes` and
    // `EntityContextPayloadRows::validate_canonical_row`. The asserted
    // property is therefore that one canonical round trip reaches a fixed
    // point: bytes are stable and re-decode stable across a second pass.
    let Ok(canonical) = canonical_value_from_tagged_json(&value) else {
        return;
    };
    let Ok(bytes) = encode_storage_payload(&canonical) else {
        return;
    };
    let re_decoded = decode_storage_payload(&bytes)
        .expect("RUNTIME_STORAGE_REENCODE_UNDECODABLE: encode_storage_payload emitted bytes its own decoder rejects");
    let canonical_two = match canonical_value_from_tagged_json(&re_decoded) {
        Ok(canonical) => canonical,
        Err(_) => return,
    };
    let Ok(bytes_two) = encode_storage_payload(&canonical_two) else {
        return;
    };
    assert_eq!(
        bytes_two, bytes,
        "RUNTIME_STORAGE_NORMALIZE_NOT_IDEMPOTENT: a second canonical pass changed the bytes"
    );
    let re_decoded_two = decode_storage_payload(&bytes_two)
        .expect("RUNTIME_STORAGE_REENCODE_UNDECODABLE (second pass)");
    assert_eq!(
        re_decoded_two, re_decoded,
        "RUNTIME_STORAGE_NORMALIZE_NOT_IDEMPOTENT: decode(encode(·)) has no fixed point"
    );
}

fuzz_target!(|data: &[u8]| {
    let live_before = live_bytes();
    run_body(data);
    // Leak gate: every value built during the execution is dropped on
    // return; a per-execution retention (the rss-growth class) would show up
    // as a positive live-bytes delta. Slack covers libFuzzer/coverage
    // bookkeeping.
    let live_after = live_bytes();
    assert!(
        live_after <= live_before.saturating_add(65536),
        "RUNTIME_STORAGE_LIVE_BYTES_GROW: live {live_after} after {live_before} — decoder retains memory across an execution"
    );
});
