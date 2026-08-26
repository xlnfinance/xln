//! Shared structure-aware harness helpers for the C7 parser fuzz targets.
//!
//! Everything here is deterministic: a `Cursor` consumes fuzz bytes as a
//! grammar, so the same input always produces the same structured value.
//! No clocks, no randomness, no environment reads.

use xln_rscore_abi::{AbiValue, BodyTuple};

/// Deterministic byte cursor over the fuzz input.
pub struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    /// Next byte, `0` past the end (padding is stable, never panics).
    pub fn u8(&mut self) -> u8 {
        let byte = self.data.get(self.pos).copied().unwrap_or(0);
        if self.pos < self.data.len() {
            self.pos += 1;
        }
        byte
    }

    /// Up to `max` remaining bytes; short at end of input.
    pub fn take(&mut self, max: usize) -> &'a [u8] {
        let end = self.data.len().min(self.pos.saturating_add(max));
        let start = self.pos.min(self.data.len());
        let slice = &self.data[start..end];
        self.pos = end;
        slice
    }

    /// `n` bytes as a big-endian unsigned integer (n ≤ 8).
    pub fn be_u64(&mut self, n: usize) -> u64 {
        let mut value: u64 = 0;
        for _ in 0..n {
            value = (value << 8) | u64::from(self.u8());
        }
        value
    }

    /// `n` bytes as a big-endian signed 128-bit integer (n ≤ 16).
    pub fn be_i128(&mut self, n: usize) -> i128 {
        let mut value: i128 = 0;
        for _ in 0..n {
            value = (value << 8) | i128::from(self.u8());
        }
        // Sign-extend from the narrow read.
        let shift = 128 - 8 * n.min(16);
        if n <= 16 && shift > 0 {
            value = (value << shift) >> shift;
        }
        value
    }

    pub fn exhausted(&self) -> bool {
        self.pos >= self.data.len()
    }
}

/// `N` bytes, zero-padded past the end of input (never panics).
pub fn fixed_bytes<const N: usize>(cur: &mut Cursor) -> [u8; N] {
    let mut out = [0_u8; N];
    let taken = cur.take(N);
    out[..taken.len()].copy_from_slice(taken);
    out
}

/// Decimal ASCII string from fuzz bytes (for bigint-valued text fields).
pub fn decimal_string(cur: &mut Cursor, max: usize) -> String {
    let mut text = String::new();
    if cur.u8() & 1 == 1 {
        text.push('-');
    }
    let length = usize::from(cur.u8()) % max.max(1);
    if length == 0 {
        text.push('0');
        return text;
    }
    for _ in 0..length {
        let digit = cur.u8() % 10;
        text.push(char::from(b'0' + digit));
    }
    text
}

/// Generate a bounded `AbiValue` tree from fuzz bytes.
///
/// Bounds (tighter than `AbiLimits::default()` and far tighter than the
/// production envelope budget): depth ≤ 8, tuple fields ≤ 32, text ≤ 256
/// bytes, blobs ≤ 512 bytes. The mix is biased toward shapes the process
/// wire decoders accept: small non-negative integers (JS-safe), exact-length
/// binary blobs (8/16/20/32/65), decimal text, and nested tuples.
pub fn abi_value(cur: &mut Cursor, depth: u8) -> AbiValue {
    let tag = cur.u8();
    if depth == 0 {
        return match tag % 4 {
            0 => AbiValue::Nil,
            1 => AbiValue::Integer(i128::from(tag)),
            2 => {
                let length = usize::from(cur.u8()) % 128;
                AbiValue::Bytes(cur.take(length).to_vec())
            }
            _ => {
                let length = usize::from(tag) % 64;
                AbiValue::Text(String::from_utf8_lossy(cur.take(length)).into_owned())
            }
        };
    }
    match tag % 14 {
        0 => AbiValue::Nil,
        1 => AbiValue::Bool(tag & 1 == 1),
        2 => AbiValue::Integer(cur.be_i128(16)),
        3 => AbiValue::Integer(i128::from(cur.be_u64(8) % (1_u64 << 53))),
        4 => AbiValue::Integer(i128::from(tag)),
        5 => {
            let length = usize::from(cur.u8()) % 256;
            AbiValue::Text(String::from_utf8_lossy(cur.take(length)).into_owned())
        }
        6 => AbiValue::Text(decimal_string(cur, 48)),
        7 => {
            let length = usize::from(cur.u8()) % 512;
            AbiValue::Bytes(cur.take(length).to_vec())
        }
        // Exact-width blobs the fixed-bytes readers require.
        8 => AbiValue::Bytes(vec![cur.u8(); 32]),
        9 => AbiValue::Bytes(vec![cur.u8(); 20]),
        10 => AbiValue::Bytes(vec![cur.u8(); 65]),
        11 => AbiValue::Bytes(vec![cur.u8(); 8]),
        12 => {
            let length = usize::from(cur.u8()) % 32;
            AbiValue::Tuple(BodyTuple::from_vec((0..length).map(|_| abi_value(cur, depth - 1)).collect()))
        }
        _ => {
            let length = usize::from(cur.u8()) % 20;
            AbiValue::Tuple(BodyTuple::from_vec((0..length).map(|_| abi_value(cur, depth - 1)).collect()))
        }
    }
}

/// Serialize an `AbiValue` back into the exact cursor bytes `abi_value` parses.
/// Round-trip property of the seed format: `abi_value(bytes_of(v)) == v` for
/// generator-produced values (used only to build seed corpora).
pub fn abi_value_seed(value: &AbiValue, out: &mut Vec<u8>) {
    match value {
        AbiValue::Nil => out.push(0),
        AbiValue::Bool(true) => out.extend_from_slice(&[1, 1]),
        AbiValue::Bool(false) => out.extend_from_slice(&[1, 0]),
        AbiValue::Integer(v) => {
            let magnitude = v.unsigned_abs();
            if (0..=255).contains(v) {
                out.push(4);
                out.push(u8::try_from(*v).expect("seed tag byte"));
            } else if magnitude <= u128::from(u32::MAX) {
                out.push(3);
                out.extend_from_slice(&(magnitude as u64 % (1_u64 << 53)).to_be_bytes());
            } else {
                out.push(2);
                out.extend_from_slice(&v.to_be_bytes());
            }
        }
        AbiValue::Text(text) => {
            let bytes = text.as_bytes();
            if !bytes.is_empty() && bytes.iter().all(|b| b.is_ascii_digit() || *b == b'-') {
                out.push(6);
                out.push(if text.starts_with('-') { 1 } else { 0 });
                out.push(u8::try_from(bytes.len().min(47)).expect("seed text length"));
                out.extend_from_slice(&bytes[..bytes.len().min(47)]);
            } else {
                out.push(5);
                out.push(u8::try_from(bytes.len().min(255)).expect("seed text length"));
                out.extend_from_slice(&bytes[..bytes.len().min(255)]);
            }
        }
        AbiValue::Bytes(bytes) => match bytes.len() {
            32 => {
                out.push(8);
                out.extend_from_slice(bytes);
            }
            20 => {
                out.push(9);
                out.extend_from_slice(bytes);
            }
            65 => {
                out.push(10);
                out.extend_from_slice(bytes);
            }
            8 => {
                out.push(11);
                out.extend_from_slice(bytes);
            }
            length => {
                out.push(7);
                out.push(u8::try_from(length).expect("seed blob length"));
                out.extend_from_slice(bytes);
            }
        },
        AbiValue::Tuple(tuple) => {
            out.push(12);
            out.push(u8::try_from(tuple.fields().len().min(31)).expect("seed tuple length"));
            for field in tuple.fields() {
                abi_value_seed(field, out);
            }
        }
    }
}

/// One big-endian usize from `n` bytes (n ≤ 5 keeps every value ≤ 2^40).
pub fn bounded_usize(cur: &mut Cursor, n: u32, modulo: usize) -> usize {
    (cur.be_u64(n as usize) as usize) % modulo.max(1)
}

/// Lowercase hex of a byte slice (no external deps in the harness lib).
pub fn hex_string(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Seed an `Envelope` body around one generated value: decode_command expects
/// `body = [tuple(...)]`, so the generated value is wrapped once.
pub fn command_body(value: AbiValue) -> BodyTuple {
    BodyTuple::from_vec(vec![value])
}

// ---------------------------------------------------------------------------
// Orderbook page snapshot grammar (shared by the orderbook_page target and
// the seed generator). The seed writer below is the exact inverse of the
// reader, so a committed fixture can be replayed byte-perfectly.
// ---------------------------------------------------------------------------

use num_bigint::{BigInt, Sign};
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookStateSnapshot,
};

fn big_decimal(cur: &mut Cursor) -> BigInt {
    decimal_string(cur, 48)
        .parse()
        .unwrap_or_else(|_| BigInt::from(0_u8))
}

/// Read one `BookPricePageSnapshot` from fuzz bytes (arbitrary price
/// magnitude/sign, sequence, counters, slot contents).
pub fn page_snapshot_from_cursor(cur: &mut Cursor) -> BookPricePageSnapshot {
    let sign = if cur.u8() & 1 == 1 {
        Sign::Minus
    } else {
        Sign::Plus
    };
    let length = usize::from(cur.u8()) % 256;
    let magnitude = cur.take(length).to_vec();
    let price = if magnitude.is_empty() {
        BigInt::from(0_u8)
    } else {
        BigInt::from_bytes_be(sign, &magnitude)
    };
    let sequence = cur.be_u64(2) as u16;
    let head_slot = usize::from(cur.u8()) % 17;
    let next_slot = usize::from(cur.u8()) % 17;
    let live_count = usize::from(cur.u8()) % 17;
    let total_qty_lots = big_decimal(cur);
    let slots = (0..16)
        .map(|_| {
            if cur.u8() & 1 == 0 {
                return None;
            }
            let order_length = usize::from(cur.u8()) % 68;
            let order_id = String::from_utf8_lossy(cur.take(order_length)).into_owned();
            let owner_length = usize::from(cur.u8()) % 68;
            let owner_id = String::from_utf8_lossy(cur.take(owner_length)).into_owned();
            Some(BookPricePageEntrySnapshot {
                order_id,
                owner_id,
                qty_lots: big_decimal(cur),
                seq: cur.be_u64(8),
            })
        })
        .collect();
    BookPricePageSnapshot {
        price_ticks: price,
        page_sequence: sequence,
        head_slot,
        next_slot,
        live_count,
        total_qty_lots,
        slots,
    }
}

/// Read a full `BookStateSnapshot` from fuzz bytes.
pub fn book_snapshot_from_cursor(cur: &mut Cursor) -> BookStateSnapshot {
    let bid_pages = (0..usize::from(cur.u8()) % 3)
        .map(|_| page_snapshot_from_cursor(cur))
        .collect::<Vec<_>>();
    let ask_pages = (0..usize::from(cur.u8()) % 2)
        .map(|_| page_snapshot_from_cursor(cur))
        .collect::<Vec<_>>();
    BookStateSnapshot {
        bucket_width_ticks: BigInt::from(u32::from(cur.u8()).max(1)),
        stp_policy: cur.u8() % 2,
        max_orders: cur.be_u64(2) as usize % 4096 + 1,
        next_seq: cur.be_u64(8),
        trade_count: cur.be_u64(8),
        trade_qty_sum: big_decimal(cur),
        last_trade_price_ticks: big_decimal(cur),
        last_accepted_usd_ask_price_ticks: big_decimal(cur),
        event_hash: big_decimal(cur),
        expected_bid_pages_root: hex_string(cur.take(32)),
        expected_ask_pages_root: hex_string(cur.take(32)),
        // compute_book_commitment_hash is a 16-byte checksum ("0x" + 32 hex).
        expected_commitment_hash: hex_string(cur.take(16)),
        bid_pages,
        ask_pages,
    }
}

fn decimal_seed(value: &BigInt, out: &mut Vec<u8>) {
    // The reader maps each byte through `% 10`, so digits are written as
    // numeric values (0..=9), not ASCII characters.
    let text = value.to_string();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, text.as_str()),
    };
    out.push(u8::from(negative));
    out.push(u8::try_from(digits.len().min(47)).expect("seed decimal length"));
    for character in digits.chars().take(47) {
        out.push(
            u8::try_from(character.to_digit(10).expect("decimal digit"))
                .expect("digit byte"),
        );
    }
}

fn hex32(value: &str) -> [u8; 32] {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    let mut out = [0_u8; 32];
    for (index, pair) in digits.as_bytes().chunks(2).enumerate().take(32) {
        let high = (pair[0] as char).to_digit(16).expect("seed root hex") as u8;
        let low = pair
            .get(1)
            .map(|byte| (*byte as char).to_digit(16).expect("seed root hex") as u8)
            .unwrap_or(0);
        out[index] = (high << 4) | low;
    }
    out
}

fn page_snapshot_seed(page: &BookPricePageSnapshot, out: &mut Vec<u8>) {
    // Canonical seed: non-negative minimal magnitude bytes.
    let (sign, magnitude) = page.price_ticks.to_bytes_be();
    out.push(u8::from(sign == Sign::Minus));
    out.push(u8::try_from(magnitude.len().min(255)).expect("seed price length"));
    out.extend_from_slice(&magnitude[..magnitude.len().min(255)]);
    out.extend_from_slice(&page.page_sequence.to_be_bytes());
    out.push(u8::try_from(page.head_slot.min(16)).expect("seed head"));
    out.push(u8::try_from(page.next_slot.min(16)).expect("seed next"));
    out.push(u8::try_from(page.live_count.min(16)).expect("seed live"));
    decimal_seed(&page.total_qty_lots, out);
    for slot in &page.slots {
        match slot {
            None => out.push(0),
            Some(entry) => {
                out.push(1);
                let order = entry.order_id.as_bytes();
                out.push(u8::try_from(order.len().min(67)).expect("seed order id"));
                out.extend_from_slice(&order[..order.len().min(67)]);
                let owner = entry.owner_id.as_bytes();
                out.push(u8::try_from(owner.len().min(67)).expect("seed owner id"));
                out.extend_from_slice(&owner[..owner.len().min(67)]);
                decimal_seed(&entry.qty_lots, out);
                out.extend_from_slice(&entry.seq.to_be_bytes());
            }
        }
    }
}

/// Serialize a `BookStateSnapshot` into the exact bytes
/// `book_snapshot_from_cursor` parses back (seed-corpus writer).
pub fn book_snapshot_seed(snapshot: &BookStateSnapshot) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(u8::try_from(snapshot.bid_pages.len().min(2)).expect("seed bid count"));
    for page in snapshot.bid_pages.iter().take(2) {
        page_snapshot_seed(page, &mut out);
    }
    out.push(u8::try_from(snapshot.ask_pages.len().min(1)).expect("seed ask count"));
    for page in snapshot.ask_pages.iter().take(1) {
        page_snapshot_seed(page, &mut out);
    }
    out.push(u8::try_from(snapshot.bucket_width_ticks.to_string().parse::<u32>().unwrap_or(1)).expect("seed bucket"));
    out.push(snapshot.stp_policy % 2);
    // max_orders is read as be_u64(2) % 4096 + 1.
    let stored_max_orders = ((snapshot.max_orders.max(1) - 1) % 4096) as u16;
    out.extend_from_slice(&stored_max_orders.to_be_bytes());
    out.extend_from_slice(&(snapshot.next_seq.to_be_bytes()));
    out.extend_from_slice(&(snapshot.trade_count.to_be_bytes()));
    decimal_seed(&snapshot.trade_qty_sum, &mut out);
    decimal_seed(&snapshot.last_trade_price_ticks, &mut out);
    decimal_seed(&snapshot.last_accepted_usd_ask_price_ticks, &mut out);
    decimal_seed(&snapshot.event_hash, &mut out);
    out.extend_from_slice(&hex32(&snapshot.expected_bid_pages_root));
    out.extend_from_slice(&hex32(&snapshot.expected_ask_pages_root));
    // The commitment is a 16-byte checksum: write exactly its bytes.
    out.extend_from_slice(&hex32(&snapshot.expected_commitment_hash)[..16]);
    out
}
