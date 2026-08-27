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
//!    Wave-2 (audit A4): acceptance is now fuzz-earned, not seed-only — mode
//!    1 generates structurally valid pages and computes their true page-tree
//!    roots and book commitment with the production-calibrated mirrors in
//!    `xln_parser_fuzz_harness` (see the mirrors' doc comment), so the
//!    accept path executes on generated page layouts (holes, head ≠ 0,
//!    multi-page books) instead of only the two committed fixtures.

use std::collections::BTreeSet;

use libfuzzer_sys::fuzz_target;
use num_bigint::BigInt;
use xln_parser_fuzz_harness::Cursor;
use xln_parser_fuzz_harness::{
    book_commitment_mirror, book_snapshot_from_cursor, page_tree_root, valid_page_from_cursor,
};
use xln_rscore_entity_kernel::{BookState, BookStateSnapshot};

/// Valid-root grammar: structurally valid pages + true roots + true
/// commitment, with an optional single-field corruption so the near-accept
/// rejection paths (root mismatch, commitment mismatch, stale aggregates)
/// stay covered from a green prefix.
fn valid_book_from_cursor(cur: &mut Cursor) -> Option<BookStateSnapshot> {
    let mut seen_bid = BTreeSet::new();
    let mut seen_ask = BTreeSet::new();
    let mut bid_pages = Vec::new();
    for index in 0..usize::from(cur.u8() % 3) {
        if let Some(page) = valid_page_from_cursor(cur, index, &mut seen_bid) {
            bid_pages.push(page);
        }
    }
    let mut ask_pages = Vec::new();
    for index in 0..usize::from(cur.u8() % 2) {
        if let Some(page) = valid_page_from_cursor(cur, index + 64, &mut seen_ask) {
            ask_pages.push(page);
        }
    }

    let max_seq = bid_pages
        .iter()
        .chain(&ask_pages)
        .flat_map(|page| page.slots.iter().flatten())
        .map(|entry| entry.seq)
        .max()
        .unwrap_or(0);
    let next_seq = max_seq.saturating_add(1).max(1);
    let order_count: usize = bid_pages
        .iter()
        .chain(&ask_pages)
        .map(|page| page.live_count)
        .sum();

    // F5 (recorded in report.md): restore() sorts pages into radix-key
    // order and snapshot() emits that order, so the canonicality property
    // holds for key-sorted page arrays — the grammar emits the canonical
    // (sorted) form, mirroring the production writer.
    bid_pages.sort_by(|left, right| {
        xln_parser_fuzz_harness::page_key_mirror(&left.price_ticks, left.page_sequence)
            .cmp(&xln_parser_fuzz_harness::page_key_mirror(&right.price_ticks, right.page_sequence))
    });
    ask_pages.sort_by(|left, right| {
        xln_parser_fuzz_harness::page_key_mirror(&left.price_ticks, left.page_sequence)
            .cmp(&xln_parser_fuzz_harness::page_key_mirror(&right.price_ticks, right.page_sequence))
    });

    let bid_root = page_tree_root(&bid_pages)?;
    let ask_root = page_tree_root(&ask_pages)?;
    let bucket_width_ticks = BigInt::from(1 + u32::from(cur.u8()));
    let stp_policy = cur.u8() % 2;
    let max_orders = order_count + 1 + usize::from(cur.u8() % 4);
    let trade_qty_sum = big_decimal(cur);
    let last_trade_price_ticks = big_decimal(cur);
    let last_accepted_usd_ask_price_ticks = big_decimal(cur);
    let event_hash = big_decimal(cur);
    let commitment = book_commitment_mirror(
        &bucket_width_ticks,
        max_orders,
        stp_policy,
        &bid_root,
        &ask_root,
        next_seq,
        0,
        &trade_qty_sum,
        &last_trade_price_ticks,
        &last_accepted_usd_ask_price_ticks,
        &event_hash,
    );

    let mut snapshot = BookStateSnapshot {
        bucket_width_ticks,
        stp_policy,
        max_orders,
        next_seq,
        trade_count: 0,
        trade_qty_sum,
        last_trade_price_ticks,
        last_accepted_usd_ask_price_ticks,
        event_hash,
        expected_bid_pages_root: bid_root,
        expected_ask_pages_root: ask_root,
        expected_commitment_hash: commitment,
        bid_pages,
        ask_pages,
    };

    // Optional corruption after commitments were computed: flip one qty of
    // one live entry (stale roots/aggregate) or one root nibble. These keep
    // the rejection boundary one mutation away from a fully valid book.
    match cur.u8() % 4 {
        0 => {}
        1 => corrupt_first_qty(&mut snapshot),
        2 => snapshot.expected_bid_pages_root = corrupt_root(&snapshot.expected_bid_pages_root),
        _ => snapshot.expected_commitment_hash =
            corrupt_root(&snapshot.expected_commitment_hash),
    }
    Some(snapshot)
}

fn big_decimal(cur: &mut Cursor) -> BigInt {
    xln_parser_fuzz_harness::decimal_string(cur, 24)
        .parse()
        .unwrap_or_else(|_| BigInt::from(0_u8))
}

fn corrupt_first_qty(snapshot: &mut BookStateSnapshot) {
    for page in snapshot.bid_pages.iter_mut().chain(snapshot.ask_pages.iter_mut()) {
        for slot in page.slots.iter_mut().flatten() {
            slot.qty_lots += 1_u8;
            return;
        }
    }
}

fn corrupt_root(root: &str) -> String {
    // Flip one hex nibble, staying inside lowercase hex.
    let digits = root.strip_prefix("0x").unwrap_or(root).to_string();
    let mut bytes = digits.into_bytes();
    if !bytes.is_empty() {
        let index = usize::from(bytes[0] % bytes.len() as u8);
        let nibble = bytes[index];
        bytes[index] = match nibble {
            b'0' => b'1',
            b'9' => b'a',
            b'f' => b'0',
            byte if byte.is_ascii_digit() => byte + 1,
            byte => byte - 1,
        };
    }
    format!("0x{}", String::from_utf8(bytes).expect("hex root"))
}

fuzz_target!(|data: &[u8]| {
    let mut cursor = Cursor::new(data);
    let snapshot = if cursor.u8() % 2 == 0 {
        book_snapshot_from_cursor(&mut cursor)
    } else {
        match valid_book_from_cursor(&mut cursor) {
            Some(snapshot) => snapshot,
            None => return,
        }
    };
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
