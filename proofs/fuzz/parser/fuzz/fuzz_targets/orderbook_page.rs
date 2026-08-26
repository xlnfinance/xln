#![no_main]
//! C7 target 5 — orderbook price-page keys
//! (`rscore/crates/entity-kernel/src/orderbook/page.rs`:
//! `page_key` / `page_price` / `page_sequence` / `restore_page`).
//!
//! The page-key functions are crate-private; the public surface that executes
//! them is `BookState::restore` (encode direction: `page_key(price, seq)` per
//! snapshot page) and `BookState::snapshot` (decode direction: `page_price`
//! + `page_sequence` per radix-map key).
//!
//! Properties:
//! 1. `BookState::restore(arbitrary snapshot)` never panics — fuzzed price
//!    magnitudes (0, negative, 1..=255-byte), sequences, counters, slots.
//! 2. Canonical acceptance: an accepted snapshot re-snapshots to the identical
//!    snapshot (`restore ∘ snapshot = id`), i.e. every accepted page key
//!    re-encodes (`page_key(page_price(key), page_sequence(key)) == key`).
//!    Acceptance is reachable through the committed parity fixture and the
//!    empty-book seed; a fuzzer cannot guess page-root hashes.

use libfuzzer_sys::fuzz_target;
use xln_parser_fuzz_harness::Cursor;
use xln_parser_fuzz_harness::book_snapshot_from_cursor;
use xln_rscore_entity_kernel::BookState;

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);
    let snapshot = book_snapshot_from_cursor(&mut cursor);
    let Ok(book) = BookState::restore(snapshot.clone()) else {
        return;
    };
    let resnapshotted = book
        .snapshot()
        .expect("an accepted book must re-snapshot");
    assert_eq!(
        resnapshotted, snapshot,
        "BOOK_PAGE_KEY_NON_CANONICAL: restore(snapshot()) != snapshot for an accepted restore"
    );
});
