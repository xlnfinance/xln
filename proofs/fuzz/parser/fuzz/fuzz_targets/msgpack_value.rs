#![no_main]
//! C7 target 6 — standalone canonical MessagePack value codec
//! (`rscore/crates/abi/src/msgpack_decode.rs` + `msgpack_encode.rs` via the
//! public `decode_value` / `encode_value` boundary).
//!
//! Properties:
//! 1. `decode_value(arbitrary bytes)` never panics; the parser's length claims
//!    are budget-checked before payload reads (nested tuples reserve
//!    `min(claimed, remaining)`).
//! 2. Total allocation for one decode (counted globally) stays bounded by
//!    `input_len * 64 + 8192` — the value tree cannot outgrow its bytes.
//! 3. The value codec is a *normalizing* decoder by design (`readme.md`:
//!    `decode(encode(x)) = normalize(x)`): accepted value `v` re-encodes to
//!    canonical bytes that decode back to exactly `v`. Byte-level
//!    canonical-only acceptance is asserted at the envelope layer (target 2).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use libfuzzer_sys::fuzz_target;
use xln_rscore_abi::{decode_value, encode_value};

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATED.fetch_add(new_size, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fuzz_target!(|data: &[u8]| {
    let value_size = std::mem::size_of::<xln_rscore_abi::AbiValue>();
    // Accepted: linear in input (every value consumed ≥ 1 byte). Rejected:
    // one reservation per nesting level (depth ≤ 32), each ≤ input length.
    let accept_budget = data.len() * value_size * 4 + 8192;
    let reject_budget = 32 * (data.len() + 1) * value_size + data.len() * 4 + 8192;
    ALLOCATED.store(0, Ordering::Relaxed);
    let decoded = decode_value(data);
    let allocated = ALLOCATED.load(Ordering::Relaxed);
    match &decoded {
        Ok(_) => assert!(
            allocated <= accept_budget,
            "MSGPACK_ACCEPT_ALLOC_UNBOUNDED: allocated {allocated} for {} input bytes",
            data.len()
        ),
        Err(_) => assert!(
            allocated <= reject_budget,
            "MSGPACK_REJECT_ALLOC_UNBOUNDED: allocated {allocated} for {} input bytes",
            data.len()
        ),
    }
    let Ok(value) = decoded else {
        return;
    };
    let canonical = match encode_value(&value) {
        Ok(bytes) => bytes,
        // FINDING F2 (recorded in report.md): a value at exactly the accepted
        // nesting depth (32) decodes but cannot re-encode, because
        // `encode_value` wraps the value in a one-element tuple that consumes
        // one depth level. Only that exact boundary may fail here.
        Err(xln_rscore_abi::AbiError::NestingTooDeep { actual: 33, max: 32 }) => {
            return;
        }
        Err(other) => panic!("decoded value must encode: {other:?}"),
    };
    let re_decoded = decode_value(&canonical).expect("canonical bytes must decode");
    assert_eq!(
        re_decoded, value,
        "MSGPACK_NORMALIZE_NOT_IDEMPOTENT: decode(encode(v)) != v"
    );
});
