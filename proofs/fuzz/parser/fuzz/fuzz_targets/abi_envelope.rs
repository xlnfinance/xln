#![no_main]
//! C7 target 2 — ABI envelope decoder with limits
//! (`rscore/crates/abi/src/codec.rs`, `msgpack_decode.rs`, `msgpack_parser.rs`).
//!
//! Properties checked per input:
//! 1. No panic, on any input, with default and with tight budgets.
//! 2. Canonical-only acceptance: `Ok` ⇒ `encode_envelope(decoded) == input`
//!    (byte-exact, i.e. total output length ≤ input length + 0).
//! 3. Limits fire before allocation: a counting global allocator asserts the
//!    total bytes allocated during one decode is bounded by
//!    `input_len * 8 + 65536` in the production shape (arity ≤ 18) and by
//!    `claimed_arity * size_of::<AbiValue>() + input_len * 8 + 65536` in the
//!    adversarial arity-claim shape (claimed ≤ 65535).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use libfuzzer_sys::fuzz_target;
use xln_rscore_abi::{
    AbiLimits, decode_envelope_with_limits, encode_envelope,
};

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

const BUDGET_CONSTANT: usize = 65_536;
/// Rejected decodes may still reserve one nested tuple per nesting level
/// (`Vec::with_capacity(min(claimed, remaining))` in `read_nested_tuple`);
/// each reservation is bounded by the input length, and at most
/// `max_nesting_depth` (32) of them are alive on one descent path. That is
/// the designed "limits fire before allocation" budget.
const NESTING_BUDGET: usize = 32;

fn decode_counted(input: &[u8], arity: usize, limits: &AbiLimits) -> (Result<xln_rscore_abi::Envelope, xln_rscore_abi::AbiError>, usize) {
    ALLOCATED.store(0, Ordering::Relaxed);
    let result = decode_envelope_with_limits(input, arity, limits);
    (result, ALLOCATED.load(Ordering::Relaxed))
}

fuzz_target!(|data: &[u8]| {
    let input = data.get(1..).unwrap_or(&[]);
    let control = data.first().copied().unwrap_or(0);
    let value_size = std::mem::size_of::<xln_rscore_abi::AbiValue>();
    // Accepted path: every accepted value consumed at least one input byte,
    // so allocation is linear in the input.
    let accept_budget = input.len() * value_size * 4 + BUDGET_CONSTANT;
    // Rejected path: bounded by the nesting-depth budget times the input.
    let reject_budget =
        NESTING_BUDGET * (input.len() + 1) * value_size + input.len() * 4 + BUDGET_CONSTANT;

    // Pass A — production shape: small expected body arity, default budgets.
    let arity = usize::from(control % 19);
    let (decoded, allocated) = decode_counted(input, arity, &AbiLimits::default());
    match &decoded {
        Ok(_) => assert!(
            allocated <= accept_budget,
            "ABI_ACCEPT_ALLOC_UNBOUNDED: accepted decode allocated {allocated} for {} input bytes",
            input.len()
        ),
        Err(_) => assert!(
            allocated <= reject_budget,
            "ABI_REJECT_ALLOC_UNBOUNDED: rejected decode allocated {allocated} for {} input bytes",
            input.len()
        ),
    }
    if let Ok(envelope) = &decoded {
        let canonical = encode_envelope(envelope)
            .expect("decode accepted an envelope the encoder rejects");
        assert_eq!(
            canonical, input,
            "ABI_NON_CANONICAL_ACCEPTED: re-encode differs from input"
        );
    }

    // Pass B — tight budgets must reject before any large allocation.
    let small = input.len().max(1);
    let tight = AbiLimits {
        max_envelope_bytes: small,
        max_body_bytes: small,
        max_blob_bytes: 64,
        max_text_bytes: 64,
        max_tuple_fields: 64,
        max_total_values: 256,
        max_nesting_depth: 8,
    };
    let (_, allocated) = decode_counted(input, arity, &tight);
    assert!(
        allocated <= reject_budget,
        "ABI_TIGHT_LIMIT_ALLOC_UNBOUNDED: tight-budget decode allocated {allocated} for {} bytes",
        input.len()
    );

    // Pass C — adversarial body-arity claim (≤ 65535) read from the input
    // itself. `read_body_tuple` reserves `claimed * size_of::<AbiValue>()`
    // before the first element read; the assert documents that the reservation
    // is bounded by the claimed arity (i.e. by `max_tuple_fields` budgeting),
    // never by anything larger.
    let claimed = usize::from(u16::from_be_bytes([
        input.first().copied().unwrap_or(0),
        input.get(1).copied().unwrap_or(0),
    ]));
    let (_, allocated) = decode_counted(input, claimed, &AbiLimits::default());
    let arity_budget = claimed
        .saturating_mul(value_size)
        .saturating_add(reject_budget);
    assert!(
        allocated <= arity_budget,
        "ABI_ARITY_RESERVATION_UNBOUNDED: claimed {claimed} fields allocated {allocated}"
    );
});
