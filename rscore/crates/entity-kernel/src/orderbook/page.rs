use std::collections::BTreeSet;
use std::fmt;

use num_bigint::{BigInt, Sign};
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::PersistentRadixMap;

use crate::EntityKernelError;

use super::{BookOrder, Side};

pub(crate) const BOOK_PRICE_PAGE_CAPACITY: usize = 16;
const MAX_BOOK_PRICE_KEY_BYTES: usize = 255;
const MAX_BOOK_PAGE_ORDER_ID_BYTES: usize = 323;
const MAX_BOOK_PAGE_OWNER_ID_BYTES: usize = 66;
const MAX_BOOK_PAGE_QTY_LOTS_POWER: u32 = 24;

/// Exact persisted slot. A flat order list is insufficient because removals
/// leave committed holes and moving a live order changes the page root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookPricePageEntrySnapshot {
    pub order_id: String,
    pub owner_id: String,
    pub qty_lots: BigInt,
    pub seq: u64,
}

/// Exact cold boundary for one committed TypeScript price page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookPricePageSnapshot {
    pub price_ticks: BigInt,
    pub page_sequence: u16,
    pub head_slot: usize,
    pub next_slot: usize,
    pub live_count: usize,
    pub total_qty_lots: BigInt,
    pub slots: Vec<Option<BookPricePageEntrySnapshot>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BookPricePageEntry {
    pub order_id: String,
    pub owner_id: String,
    pub qty_lots: BigInt,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BookPricePage {
    head_slot: usize,
    next_slot: usize,
    live_count: usize,
    total_qty_lots: BigInt,
    slots: [Option<BookPricePageEntry>; BOOK_PRICE_PAGE_CAPACITY],
}

impl BookPricePage {
    fn empty() -> Self {
        Self {
            head_slot: 0,
            next_slot: 0,
            live_count: 0,
            total_qty_lots: BigInt::from(0),
            slots: std::array::from_fn(|_| None),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BookPricePageLocation {
    pub sequence: u16,
    pub slot: usize,
}

#[derive(Clone)]
pub(crate) struct BookPricePageTree {
    map: PersistentRadixMap<BookPricePage>,
}

impl fmt::Debug for BookPricePageTree {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BookPricePageTree")
            .field("len", &self.map.len())
            .field("root", &hex_digest(&self.map.root_hash()))
            .finish()
    }
}

impl PartialEq for BookPricePageTree {
    fn eq(&self, other: &Self) -> bool {
        self.map.root_hash() == other.map.root_hash()
            && self.map.len() == other.map.len()
            && self.map.iter().eq(other.map.iter())
    }
}

impl Eq for BookPricePageTree {}

fn page_error(code: impl Into<String>) -> EntityKernelError {
    EntityKernelError::orderbook(code)
}

fn hex_digest(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn unsigned_bytes(value: &BigInt) -> Result<Vec<u8>, EntityKernelError> {
    let (sign, mut bytes) = value.to_bytes_be();
    if sign == Sign::Minus {
        return Err(page_error("BOOK_PAGE_UNSIGNED_VALUE_NEGATIVE"));
    }
    if bytes.is_empty() {
        bytes.push(0);
    }
    Ok(bytes)
}

fn framed(bytes: &[u8], output: &mut Vec<u8>) -> Result<(), EntityKernelError> {
    let length = u16::try_from(bytes.len())
        .map_err(|_| page_error(format!("BOOK_PAGE_FIELD_TOO_LARGE:{}", bytes.len())))?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(())
}

fn page_digest(page: &BookPricePage) -> Result<[u8; 32], EntityKernelError> {
    let mut encoded = Vec::new();
    for value in [page.head_slot, page.next_slot, page.live_count] {
        let value = u16::try_from(value)
            .map_err(|_| page_error(format!("BOOK_PAGE_COUNTER_INVALID:{value}")))?;
        encoded.extend_from_slice(&value.to_be_bytes());
    }
    framed(&unsigned_bytes(&page.total_qty_lots)?, &mut encoded)?;
    for entry in &page.slots {
        let Some(entry) = entry else {
            encoded.push(0);
            continue;
        };
        encoded.push(1);
        framed(entry.order_id.as_bytes(), &mut encoded)?;
        framed(entry.owner_id.as_bytes(), &mut encoded)?;
        framed(&unsigned_bytes(&entry.qty_lots)?, &mut encoded)?;
        framed(&unsigned_bytes(&BigInt::from(entry.seq))?, &mut encoded)?;
    }
    Ok(Sha256::digest(encoded).into())
}

fn price_prefix(price_ticks: &BigInt) -> Result<Vec<u8>, EntityKernelError> {
    if price_ticks <= &BigInt::from(0) {
        return Err(page_error(format!("BOOK_PAGE_PRICE_INVALID:{price_ticks}")));
    }
    let (_, bytes) = price_ticks.to_bytes_be();
    if bytes.is_empty() || bytes.len() > MAX_BOOK_PRICE_KEY_BYTES {
        return Err(page_error(format!(
            "BOOK_PAGE_PRICE_BYTES_EXCEEDED:{}",
            bytes.len()
        )));
    }
    let length = u8::try_from(bytes.len())
        .map_err(|_| page_error(format!("BOOK_PAGE_PRICE_BYTES_EXCEEDED:{}", bytes.len())))?;
    let mut prefix = Vec::with_capacity(1 + bytes.len());
    prefix.push(length);
    prefix.extend(bytes);
    Ok(prefix)
}

fn page_key(price_ticks: &BigInt, sequence: u16) -> Result<Vec<u8>, EntityKernelError> {
    let mut key = price_prefix(price_ticks)?;
    key.extend_from_slice(&sequence.to_be_bytes());
    Ok(key)
}

fn page_sequence(key: &[u8]) -> Result<u16, EntityKernelError> {
    let suffix = key
        .get(key.len().saturating_sub(2)..)
        .ok_or_else(|| page_error("BOOK_PAGE_KEY_LENGTH_INVALID"))?;
    let bytes: [u8; 2] = suffix
        .try_into()
        .map_err(|_| page_error("BOOK_PAGE_KEY_LENGTH_INVALID"))?;
    Ok(u16::from_be_bytes(bytes))
}

fn page_price(key: &[u8]) -> Result<BigInt, EntityKernelError> {
    let Some(length) = key.first().copied().map(usize::from) else {
        return Err(page_error("BOOK_PAGE_KEY_LENGTH_INVALID"));
    };
    if length == 0 || key.len() != 1 + length + 2 || key[1] == 0 {
        return Err(page_error("BOOK_PAGE_KEY_NON_CANONICAL"));
    }
    Ok(BigInt::from_bytes_be(Sign::Plus, &key[1..1 + length]))
}

fn require_bounded_text(value: &str, maximum: usize, code: &str) -> Result<(), EntityKernelError> {
    let length = value.len();
    if length == 0 || length > maximum {
        return Err(page_error(format!("{code}:{length}")));
    }
    Ok(())
}

fn restore_page(
    snapshot: &BookPricePageSnapshot,
) -> Result<(BookPricePage, Vec<(usize, BookPricePageEntry)>), EntityKernelError> {
    if snapshot.slots.len() != BOOK_PRICE_PAGE_CAPACITY {
        return Err(page_error(format!(
            "BOOK_PAGE_SLOTS_INVALID:{}",
            snapshot.slots.len()
        )));
    }
    if snapshot.head_slot > BOOK_PRICE_PAGE_CAPACITY
        || snapshot.next_slot > BOOK_PRICE_PAGE_CAPACITY
        || snapshot.live_count > BOOK_PRICE_PAGE_CAPACITY
    {
        return Err(page_error("BOOK_PAGE_COUNTER_INVALID"));
    }
    let maximum_qty = BigInt::from(10_u8).pow(MAX_BOOK_PAGE_QTY_LOTS_POWER);
    let mut slots = std::array::from_fn(|_| None);
    let mut live = Vec::with_capacity(snapshot.live_count);
    let mut total = BigInt::from(0);
    let mut first = None;
    let mut page_order_ids = BTreeSet::new();
    for (slot, snapshot_entry) in snapshot.slots.iter().enumerate() {
        let Some(snapshot_entry) = snapshot_entry else {
            continue;
        };
        require_bounded_text(
            &snapshot_entry.order_id,
            MAX_BOOK_PAGE_ORDER_ID_BYTES,
            "BOOK_PAGE_ORDER_ID_BYTES_INVALID",
        )?;
        require_bounded_text(
            &snapshot_entry.owner_id,
            MAX_BOOK_PAGE_OWNER_ID_BYTES,
            "BOOK_PAGE_OWNER_ID_BYTES_INVALID",
        )?;
        if snapshot_entry.qty_lots <= BigInt::from(0) || snapshot_entry.qty_lots > maximum_qty {
            return Err(page_error("BOOK_PAGE_ORDER_QTY_INVALID"));
        }
        if !page_order_ids.insert(snapshot_entry.order_id.clone()) {
            return Err(page_error("BOOK_PAGE_DUPLICATE_ORDER_ID"));
        }
        first.get_or_insert(slot);
        total += &snapshot_entry.qty_lots;
        let entry = BookPricePageEntry {
            order_id: snapshot_entry.order_id.clone(),
            owner_id: snapshot_entry.owner_id.clone(),
            qty_lots: snapshot_entry.qty_lots.clone(),
            seq: snapshot_entry.seq,
        };
        slots[slot] = Some(entry.clone());
        live.push((slot, entry));
    }
    if live.is_empty()
        || live.len() != snapshot.live_count
        || total != snapshot.total_qty_lots
        || first != Some(snapshot.head_slot)
        || snapshot.next_slot <= snapshot.head_slot
        || slots[snapshot.next_slot..].iter().any(Option::is_some)
    {
        return Err(page_error("BOOK_PAGE_AGGREGATE_INVALID"));
    }
    Ok((
        BookPricePage {
            head_slot: snapshot.head_slot,
            next_slot: snapshot.next_slot,
            live_count: snapshot.live_count,
            total_qty_lots: snapshot.total_qty_lots.clone(),
            slots,
        },
        live,
    ))
}

impl BookPricePageTree {
    pub(crate) fn empty() -> Self {
        Self {
            map: PersistentRadixMap::empty(),
        }
    }

    pub(crate) fn root_hash(&self) -> String {
        hex_digest(&self.map.root_hash())
    }

    pub(crate) fn restore(
        side: Side,
        snapshots: &[BookPricePageSnapshot],
    ) -> Result<(Self, Vec<BookOrder>), EntityKernelError> {
        let mut ordered = snapshots
            .iter()
            .map(|snapshot| {
                Ok((
                    page_key(&snapshot.price_ticks, snapshot.page_sequence)?,
                    snapshot,
                ))
            })
            .collect::<Result<Vec<_>, EntityKernelError>>()?;
        ordered.sort_by(|(left, _), (right, _)| left.cmp(right));
        if ordered.windows(2).any(|rows| rows[0].0 == rows[1].0) {
            return Err(page_error("BOOK_PAGE_KEY_DUPLICATE"));
        }
        let mut map = PersistentRadixMap::empty();
        let mut orders = Vec::new();
        let mut order_ids = BTreeSet::new();
        for (key, snapshot) in ordered {
            let (page, live) = restore_page(snapshot)?;
            for (slot, entry) in live {
                if !order_ids.insert(entry.order_id.clone()) {
                    return Err(page_error("BOOK_PAGE_DUPLICATE_ORDER_ID"));
                }
                orders.push(BookOrder {
                    order_id: entry.order_id,
                    owner_id: entry.owner_id,
                    side,
                    price_ticks: snapshot.price_ticks.clone(),
                    qty_lots: entry.qty_lots,
                    seq: entry.seq,
                    page_sequence: snapshot.page_sequence,
                    page_slot: slot,
                });
            }
            let digest = page_digest(&page)?;
            map = map
                .updated(key, page, digest)
                .map_err(|error| page_error(error.to_string()))?;
        }
        Ok((Self { map }, orders))
    }

    pub(crate) fn snapshot(&self) -> Result<Vec<BookPricePageSnapshot>, EntityKernelError> {
        self.map
            .iter()
            .map(|(key, page)| {
                Ok(BookPricePageSnapshot {
                    price_ticks: page_price(key)?,
                    page_sequence: page_sequence(key)?,
                    head_slot: page.head_slot,
                    next_slot: page.next_slot,
                    live_count: page.live_count,
                    total_qty_lots: page.total_qty_lots.clone(),
                    slots: page
                        .slots
                        .iter()
                        .map(|entry| {
                            entry.as_ref().map(|entry| BookPricePageEntrySnapshot {
                                order_id: entry.order_id.clone(),
                                owner_id: entry.owner_id.clone(),
                                qty_lots: entry.qty_lots.clone(),
                                seq: entry.seq,
                            })
                        })
                        .collect(),
                })
            })
            .collect()
    }

    fn tail(
        &self,
        price_ticks: &BigInt,
    ) -> Result<Option<(u16, BookPricePage)>, EntityKernelError> {
        let prefix = price_prefix(price_ticks)?;
        self.map
            .last_with_prefix(&prefix)
            .map(|(key, page)| Ok((page_sequence(key)?, page.clone())))
            .transpose()
    }

    pub(crate) fn append(
        &mut self,
        price_ticks: &BigInt,
        entry: BookPricePageEntry,
    ) -> Result<BookPricePageLocation, EntityKernelError> {
        let tail = self.tail(price_ticks)?;
        let sequence = match &tail {
            Some((sequence, page)) if page.next_slot < BOOK_PRICE_PAGE_CAPACITY => *sequence,
            Some((sequence, _)) => sequence
                .checked_add(1)
                .ok_or_else(|| page_error("BOOK_PAGE_SEQUENCE_EXHAUSTED"))?,
            None => 0,
        };
        let mut page = match tail {
            Some((tail_sequence, page)) if tail_sequence == sequence => page,
            _ => BookPricePage::empty(),
        };
        if page.next_slot >= BOOK_PRICE_PAGE_CAPACITY {
            return Err(page_error("BOOK_PAGE_FULL"));
        }
        let slot = page.next_slot;
        if page.live_count == 0 {
            page.head_slot = slot;
        }
        page.next_slot += 1;
        page.live_count += 1;
        page.total_qty_lots += &entry.qty_lots;
        page.slots[slot] = Some(entry);
        let key = page_key(price_ticks, sequence)?;
        let digest = page_digest(&page)?;
        self.map = self
            .map
            .updated(key, page, digest)
            .map_err(|error| page_error(error.to_string()))?;
        Ok(BookPricePageLocation { sequence, slot })
    }

    pub(crate) fn remove(
        &mut self,
        price_ticks: &BigInt,
        location: BookPricePageLocation,
        order_id: &str,
    ) -> Result<(), EntityKernelError> {
        let key = page_key(price_ticks, location.sequence)?;
        let mut page = self
            .map
            .get(&key)
            .cloned()
            .ok_or_else(|| page_error("BOOK_PAGE_LOCATION_MISMATCH"))?;
        let entry = page
            .slots
            .get(location.slot)
            .and_then(Option::as_ref)
            .filter(|entry| entry.order_id == order_id)
            .cloned()
            .ok_or_else(|| page_error("BOOK_PAGE_LOCATION_MISMATCH"))?;
        page.slots[location.slot] = None;
        page.live_count = page
            .live_count
            .checked_sub(1)
            .ok_or_else(|| page_error("BOOK_PAGE_LIVE_UNDERFLOW"))?;
        page.total_qty_lots -= entry.qty_lots;
        if page.live_count == 0 {
            self.map = self
                .map
                .removed(&key)
                .map_err(|error| page_error(error.to_string()))?;
            return Ok(());
        }
        if location.slot == page.head_slot {
            page.head_slot = page
                .slots
                .iter()
                .position(Option::is_some)
                .ok_or_else(|| page_error("BOOK_PAGE_AGGREGATE_INVALID"))?;
        }
        let digest = page_digest(&page)?;
        self.map = self
            .map
            .updated(key, page, digest)
            .map_err(|error| page_error(error.to_string()))?;
        Ok(())
    }

    pub(crate) fn reduce(
        &mut self,
        price_ticks: &BigInt,
        location: BookPricePageLocation,
        order_id: &str,
        next_qty_lots: &BigInt,
    ) -> Result<(), EntityKernelError> {
        if next_qty_lots <= &BigInt::from(0) {
            return Err(page_error("BOOK_PAGE_REDUCE_QTY_INVALID"));
        }
        let key = page_key(price_ticks, location.sequence)?;
        let mut page = self
            .map
            .get(&key)
            .cloned()
            .ok_or_else(|| page_error("BOOK_PAGE_LOCATION_MISMATCH"))?;
        let entry = page
            .slots
            .get_mut(location.slot)
            .and_then(Option::as_mut)
            .filter(|entry| entry.order_id == order_id)
            .ok_or_else(|| page_error("BOOK_PAGE_LOCATION_MISMATCH"))?;
        page.total_qty_lots += next_qty_lots - &entry.qty_lots;
        entry.qty_lots = next_qty_lots.clone();
        let digest = page_digest(&page)?;
        self.map = self
            .map
            .updated(key, page, digest)
            .map_err(|error| page_error(error.to_string()))?;
        Ok(())
    }
}

pub(crate) fn page_tree_mut<'a>(
    bid_pages: &'a mut BookPricePageTree,
    ask_pages: &'a mut BookPricePageTree,
    side: Side,
) -> &'a mut BookPricePageTree {
    match side {
        Side::Bid => bid_pages,
        Side::Ask => ask_pages,
    }
}
