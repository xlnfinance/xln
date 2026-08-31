//! Exact path-keyed restore of live orderbook headers and Patricia page trees.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::{BigInt, Sign};
use serde_json::{Map, Number, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    BookPricePageEntrySnapshot, BookPricePageSnapshot, BookStateSnapshot,
    OrderbookConsensusMetadata, OrderbookStateSnapshot,
};
use xln_rscore_protocol::{PersistentNodeRecord, PersistentRadixMap, pack_path16};

use crate::{StorageMessagePackError, decode_storage_payload};

use super::orderbook_accounts::RestoredOrderbookAccounts;
use super::orderbook_metadata::{OrderbookMetadataRestoreError, hydrate_orderbook_metadata};

const HEADER_TAG: u8 = 0x23;
const BRANCH_TAG: u8 = 0x2d;
const LEAF_TAG: u8 = 0x2e;
const BOOK_PAGE_CAPACITY: usize = 16;
const MAX_ORDERS_PER_PAIR: usize = 10_000;

#[derive(Debug, Error)]
pub enum OrderbookGraphRestoreError {
    #[error("RRS_RESTORE_ORDERBOOK_GRAPH:{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
    #[error(transparent)]
    Metadata(#[from] OrderbookMetadataRestoreError),
    #[error("RRS_RESTORE_ORDERBOOK_RADIX:{0}")]
    Radix(String),
}

fn invalid(detail: impl Into<String>) -> OrderbookGraphRestoreError {
    OrderbookGraphRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, OrderbookGraphRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), OrderbookGraphRestoreError> {
    let mut actual = value.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn safe_usize(value: &Value, path: &str) -> Result<usize, OrderbookGraphRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, OrderbookGraphRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn bigint(value: &Value, path: &str) -> Result<BigInt, OrderbookGraphRestoreError> {
    let value = object(value, path)?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(invalid(format!("BIGINT:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("BIGINT:{path}")))?
        .parse()
        .map_err(|_| invalid(format!("BIGINT:{path}")))
}

fn digest_text(
    value: &Value,
    bytes: usize,
    path: &str,
) -> Result<String, OrderbookGraphRestoreError> {
    let value = value
        .as_str()
        .filter(|value| value.len() == bytes.saturating_mul(2).saturating_add(2))
        .filter(|value| value.starts_with("0x"))
        .filter(|value| {
            value[2..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| invalid(format!("DIGEST:{path}")))?;
    Ok(value.to_owned())
}

fn parse_digest(value: &str) -> Result<[u8; 32], OrderbookGraphRestoreError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid("ROOT"))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid("ROOT"))?;
    }
    Ok(output)
}

fn read_pair(key: &[u8], offset: usize) -> Result<(String, usize), OrderbookGraphRestoreError> {
    let length = key
        .get(offset..offset.saturating_add(2))
        .and_then(|value| <[u8; 2]>::try_from(value).ok())
        .map(u16::from_be_bytes)
        .map(usize::from)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid("PAIR_KEY"))?;
    let start = offset.saturating_add(2);
    let end = start.saturating_add(length);
    let pair = key
        .get(start..end)
        .and_then(|value| std::str::from_utf8(value).ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("PAIR_KEY"))?;
    Ok((pair.to_owned(), end))
}

fn owner_prefix(
    tag: u8,
    owner: &[u8; 32],
    pair: &str,
    side: u8,
) -> Result<Vec<u8>, OrderbookGraphRestoreError> {
    let pair = pair.as_bytes();
    let length = u16::try_from(pair.len()).map_err(|_| invalid("PAIR_LENGTH"))?;
    if pair.is_empty() {
        return Err(invalid("PAIR_LENGTH"));
    }
    let mut output = Vec::with_capacity(36 + pair.len());
    output.push(tag);
    output.extend_from_slice(owner);
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(pair);
    output.push(side);
    Ok(output)
}

fn page_key(payload: &[u8]) -> Result<(BigInt, u16), OrderbookGraphRestoreError> {
    let length = payload
        .first()
        .copied()
        .map(usize::from)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid("PAGE_KEY"))?;
    if payload.len() != length.saturating_add(3) || payload[1] == 0 {
        return Err(invalid("PAGE_KEY"));
    }
    let sequence = payload
        .get(payload.len().saturating_sub(2)..)
        .and_then(|value| <[u8; 2]>::try_from(value).ok())
        .map(u16::from_be_bytes)
        .ok_or_else(|| invalid("PAGE_KEY"))?;
    Ok((
        BigInt::from_bytes_be(Sign::Plus, &payload[1..1 + length]),
        sequence,
    ))
}

fn page_entry(
    value: &Value,
    slot: usize,
) -> Result<Option<BookPricePageEntrySnapshot>, OrderbookGraphRestoreError> {
    if value.is_null() {
        return Ok(None);
    }
    let value = object(value, "page.entry")?;
    exact_fields(
        value,
        &["orderId", "ownerId", "qtyLots", "seq"],
        "page.entry",
    )?;
    let order_id = value["orderId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("PAGE_ORDER:{slot}")))?
        .to_owned();
    let owner_id = value["ownerId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("PAGE_OWNER:{slot}")))?
        .to_owned();
    Ok(Some(BookPricePageEntrySnapshot {
        order_id,
        owner_id,
        qty_lots: bigint(&value["qtyLots"], "page.qtyLots")?,
        seq: safe_u64(&value["seq"], "page.seq")?,
    }))
}

fn page_snapshot(
    value: &Value,
    key: &[u8],
) -> Result<BookPricePageSnapshot, OrderbookGraphRestoreError> {
    let (price_ticks, page_sequence) = page_key(key)?;
    let value = object(value, "page")?;
    exact_fields(
        value,
        &["headSlot", "nextSlot", "liveCount", "totalQtyLots", "slots"],
        "page",
    )?;
    let slots = value["slots"]
        .as_array()
        .filter(|value| value.len() == BOOK_PAGE_CAPACITY)
        .ok_or_else(|| invalid("PAGE_SLOTS"))?
        .iter()
        .enumerate()
        .map(|(slot, value)| page_entry(value, slot))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BookPricePageSnapshot {
        price_ticks,
        page_sequence,
        head_slot: safe_usize(&value["headSlot"], "page.headSlot")?,
        next_slot: safe_usize(&value["nextSlot"], "page.nextSlot")?,
        live_count: safe_usize(&value["liveCount"], "page.liveCount")?,
        total_qty_lots: bigint(&value["totalQtyLots"], "page.totalQtyLots")?,
        slots,
    })
}

fn unsigned_bytes(value: &BigInt) -> Result<Vec<u8>, OrderbookGraphRestoreError> {
    let (sign, mut bytes) = value.to_bytes_be();
    if sign == Sign::Minus {
        return Err(invalid("PAGE_NEGATIVE"));
    }
    if bytes.is_empty() {
        bytes.push(0);
    }
    Ok(bytes)
}

fn framed(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), OrderbookGraphRestoreError> {
    let length = u16::try_from(bytes.len()).map_err(|_| invalid("PAGE_FIELD_LENGTH"))?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(())
}

fn page_digest(page: &BookPricePageSnapshot) -> Result<[u8; 32], OrderbookGraphRestoreError> {
    let mut encoded = Vec::new();
    for value in [page.head_slot, page.next_slot, page.live_count] {
        encoded.extend_from_slice(
            &u16::try_from(value)
                .map_err(|_| invalid("PAGE_COUNTER"))?
                .to_be_bytes(),
        );
    }
    framed(&mut encoded, &unsigned_bytes(&page.total_qty_lots)?)?;
    for entry in &page.slots {
        let Some(entry) = entry else {
            encoded.push(0);
            continue;
        };
        encoded.push(1);
        framed(&mut encoded, entry.order_id.as_bytes())?;
        framed(&mut encoded, entry.owner_id.as_bytes())?;
        framed(&mut encoded, &unsigned_bytes(&entry.qty_lots)?)?;
        framed(&mut encoded, &unsigned_bytes(&BigInt::from(entry.seq))?)?;
    }
    Ok(Sha256::digest(encoded).into())
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2).saturating_add(2));
    output.push_str("0x");
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn branch_value<V: Clone>(record: &PersistentNodeRecord<V>) -> Option<Value> {
    let PersistentNodeRecord::Branch { children, .. } = record else {
        return None;
    };
    Some(Value::Object(Map::from_iter([(
        "children".into(),
        Value::Array(
            children
                .iter()
                .map(|child| {
                    Value::Object(Map::from_iter([
                        ("slot".into(), Value::Number(Number::from(child.slot))),
                        ("kind".into(), Value::String(child.kind.into())),
                        (
                            "path".into(),
                            Value::Array(
                                child
                                    .path
                                    .iter()
                                    .map(|slot| Value::Number(Number::from(*slot)))
                                    .collect(),
                            ),
                        ),
                        ("edgeHash".into(), Value::String(hex(&child.edge_hash))),
                    ]))
                })
                .collect(),
        ),
    )])))
}

fn restore_page_tree(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
    pair: &str,
    side: u8,
    expected_root: &str,
    expected_count: usize,
    used: &mut BTreeSet<Vec<u8>>,
) -> Result<Vec<BookPricePageSnapshot>, OrderbookGraphRestoreError> {
    let leaf_prefix = owner_prefix(LEAF_TAG, owner, pair, side)?;
    let mut leaves = Vec::new();
    let mut tree = PersistentRadixMap::empty();
    for (storage_key, bytes) in rows
        .range(leaf_prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&leaf_prefix))
    {
        let key = storage_key
            .get(leaf_prefix.len()..)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("LEAF_KEY"))?;
        let value = decode_storage_payload(bytes)?;
        let page = page_snapshot(&value, key)?;
        tree = tree
            .updated(key.to_vec(), value, page_digest(&page)?)
            .map_err(|error| OrderbookGraphRestoreError::Radix(error.to_string()))?;
        leaves.push(page);
        used.insert(storage_key.clone());
    }
    let expected_root_bytes = parse_digest(expected_root)?;
    if tree.len() != expected_count || tree.root_hash() != expected_root_bytes {
        return Err(invalid(format!("TREE_ROOT:{pair}:{side}")));
    }
    let branch_prefix = owner_prefix(BRANCH_TAG, owner, pair, side)?;
    let mut expected_keys = BTreeSet::new();
    for record in tree.node_records() {
        let PersistentNodeRecord::Branch { path, .. } = &record else {
            continue;
        };
        let mut key = branch_prefix.clone();
        key.extend(
            pack_path16(path)
                .map_err(|error| OrderbookGraphRestoreError::Radix(error.to_string()))?,
        );
        let stored = rows.get(&key).ok_or_else(|| invalid("BRANCH_MISSING"))?;
        if branch_value(&record).as_ref() != Some(&decode_storage_payload(stored)?) {
            return Err(invalid(format!("BRANCH_VALUE:{}", hex(&key))));
        }
        expected_keys.insert(key.clone());
        used.insert(key);
    }
    let actual_keys = rows
        .range(branch_prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&branch_prefix))
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    if actual_keys != expected_keys {
        return Err(invalid(format!("BRANCH_SET:{pair}:{side}")));
    }
    Ok(leaves)
}

fn header(
    value: &Value,
) -> Result<(BookStateSnapshot, String, usize, String, usize), OrderbookGraphRestoreError> {
    let value = object(value, "header")?;
    exact_fields(
        value,
        &[
            "params",
            "bidRootHash",
            "bidLeafCount",
            "askRootHash",
            "askLeafCount",
            "nextSeq",
            "tradeCount",
            "tradeQtySum",
            "lastTradePriceTicks",
            "lastAcceptedUsdAskPriceTicks",
            "eventHash",
            "commitmentHash",
        ],
        "header",
    )?;
    let params = object(&value["params"], "header.params")?;
    exact_fields(
        params,
        &["bucketWidthTicks", "maxOrders", "stpPolicy"],
        "header.params",
    )?;
    let stp_policy = safe_u64(&params["stpPolicy"], "header.stpPolicy")?;
    if stp_policy > 1 {
        return Err(invalid("HEADER_STP_POLICY"));
    }
    let bid_root = digest_text(&value["bidRootHash"], 32, "header.bidRootHash")?;
    let ask_root = digest_text(&value["askRootHash"], 32, "header.askRootHash")?;
    let bid_count = safe_usize(&value["bidLeafCount"], "header.bidLeafCount")?;
    let ask_count = safe_usize(&value["askLeafCount"], "header.askLeafCount")?;
    Ok((
        BookStateSnapshot {
            bucket_width_ticks: bigint(&params["bucketWidthTicks"], "header.bucketWidthTicks")?,
            stp_policy: u8::try_from(stp_policy).map_err(|_| invalid("HEADER_STP_POLICY"))?,
            max_orders: safe_usize(&params["maxOrders"], "header.maxOrders")?,
            next_seq: safe_u64(&value["nextSeq"], "header.nextSeq")?,
            trade_count: safe_u64(&value["tradeCount"], "header.tradeCount")?,
            trade_qty_sum: bigint(&value["tradeQtySum"], "header.tradeQtySum")?,
            last_trade_price_ticks: bigint(
                &value["lastTradePriceTicks"],
                "header.lastTradePriceTicks",
            )?,
            last_accepted_usd_ask_price_ticks: bigint(
                &value["lastAcceptedUsdAskPriceTicks"],
                "header.lastAcceptedUsdAskPriceTicks",
            )?,
            event_hash: bigint(&value["eventHash"], "header.eventHash")?,
            bid_pages: Vec::new(),
            ask_pages: Vec::new(),
            expected_bid_pages_root: bid_root.clone(),
            expected_ask_pages_root: ask_root.clone(),
            expected_commitment_hash: digest_text(
                &value["commitmentHash"],
                16,
                "header.commitmentHash",
            )?,
        },
        bid_root,
        bid_count,
        ask_root,
        ask_count,
    ))
}

pub struct HydratedOrderbook {
    pub snapshot: OrderbookStateSnapshot,
    pub metadata: OrderbookConsensusMetadata,
}

pub fn hydrate_orderbook_graph(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
    core: &Map<String, Value>,
    accounts: RestoredOrderbookAccounts,
) -> Result<Option<HydratedOrderbook>, OrderbookGraphRestoreError> {
    let metadata = hydrate_orderbook_metadata(core)?;
    let header_prefix = [vec![HEADER_TAG], owner.to_vec()].concat();
    let headers = rows
        .range(header_prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&header_prefix))
        .collect::<Vec<_>>();
    if headers.is_empty() && metadata.is_none() {
        let has_graph_rows = rows.keys().any(|key| {
            key.first()
                .is_some_and(|tag| matches!(*tag, BRANCH_TAG | LEAF_TAG))
                && key.get(1..33) == Some(owner.as_slice())
        });
        if has_graph_rows {
            return Err(invalid("ORPHAN_TREE_ROWS"));
        }
        return Ok(None);
    }
    let metadata = metadata.ok_or_else(|| invalid("METADATA_MISSING"))?;
    let mut books = BTreeMap::new();
    let mut pair_by_order = BTreeMap::new();
    let mut used = BTreeSet::new();
    for (key, bytes) in headers {
        let (pair, end) = read_pair(key, header_prefix.len())?;
        if end != key.len() {
            return Err(invalid("HEADER_KEY_TRAILING"));
        }
        let (mut snapshot, bid_root, bid_count, ask_root, ask_count) =
            header(&decode_storage_payload(bytes)?)?;
        if snapshot.max_orders != MAX_ORDERS_PER_PAIR {
            return Err(invalid(format!(
                "MAX_ORDERS:{pair}:{}",
                snapshot.max_orders
            )));
        }
        snapshot.bid_pages =
            restore_page_tree(rows, owner, &pair, 0, &bid_root, bid_count, &mut used)?;
        snapshot.ask_pages =
            restore_page_tree(rows, owner, &pair, 1, &ask_root, ask_count, &mut used)?;
        for page in snapshot.bid_pages.iter().chain(&snapshot.ask_pages) {
            for entry in page.slots.iter().flatten() {
                if pair_by_order
                    .insert(entry.order_id.clone(), pair.clone())
                    .is_some()
                {
                    return Err(invalid(format!("ORDER_PAIR_DUPLICATE:{}", entry.order_id)));
                }
            }
        }
        if books.insert(pair.clone(), snapshot).is_some() {
            return Err(invalid(format!("HEADER_DUPLICATE:{pair}")));
        }
        used.insert(key.clone());
    }
    let actual = rows
        .keys()
        .filter(|key| {
            key.first()
                .is_some_and(|tag| [HEADER_TAG, BRANCH_TAG, LEAF_TAG].contains(tag))
                && key.get(1..33) == Some(owner.as_slice())
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual != used {
        return Err(invalid("UNREACHABLE_ROWS"));
    }
    Ok(Some(HydratedOrderbook {
        snapshot: OrderbookStateSnapshot {
            books,
            pair_dimensions: metadata.pair_dimensions,
            offers: accounts.offers,
            resolving_offers: accounts.resolving_offers,
            pair_by_order,
            max_orders_per_pair: MAX_ORDERS_PER_PAIR,
        },
        metadata: metadata.metadata,
    }))
}

#[cfg(test)]
mod tests {
    use xln_rscore_entity_kernel::BookState;
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

    use super::*;

    fn text(value: impl Into<String>) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn number(value: u64) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture"))
    }

    fn object(fields: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn decoded(value: CanonicalValue) -> Value {
        crate::decode_storage_payload(
            &crate::encode_storage_payload(&value).expect("encode fixture"),
        )
        .expect("decode fixture")
    }

    fn metadata(owner: &[u8; 32]) -> Map<String, Value> {
        let owner = hex(owner);
        let profile = object(vec![
            ("entityId", text(&owner)),
            ("name", text("hub")),
            (
                "spreadDistribution",
                object(vec![
                    ("makerBps", number(0)),
                    ("takerBps", number(0)),
                    ("hubBps", number(10_000)),
                    ("makerReferrerBps", number(0)),
                    ("takerReferrerBps", number(0)),
                ]),
            ),
            ("referenceTokenId", number(1)),
            ("usdQuoteAuthorityEntityId", text(&owner)),
            ("minTradeSize", CanonicalValue::BigInt(BigInt::from(0))),
            ("supportedPairs", CanonicalValue::Array(vec![text("1/2")])),
        ]);
        Map::from_iter([
            ("orderbookHubProfile".into(), decoded(profile)),
            (
                "orderbookReferrals".into(),
                decoded(CanonicalValue::Map(Vec::new())),
            ),
            (
                "orderbookPairDimensions".into(),
                decoded(CanonicalValue::Map(vec![(
                    text("1/2"),
                    object(vec![
                        ("baseTokenDecimals", number(18)),
                        ("quoteTokenDecimals", number(6)),
                    ]),
                )])),
            ),
        ])
    }

    #[test]
    fn empty_live_book_header_restores_exact_commitment() {
        let owner = [0x11; 32];
        let book = BookState::empty(MAX_ORDERS_PER_PAIR, 1);
        let snapshot = book.snapshot().expect("snapshot empty book");
        let header = object(vec![
            (
                "params",
                object(vec![
                    ("bucketWidthTicks", CanonicalValue::BigInt(BigInt::from(1))),
                    ("maxOrders", number(MAX_ORDERS_PER_PAIR as u64)),
                    ("stpPolicy", number(1)),
                ]),
            ),
            ("bidRootHash", text(snapshot.expected_bid_pages_root)),
            ("bidLeafCount", number(0)),
            ("askRootHash", text(snapshot.expected_ask_pages_root)),
            ("askLeafCount", number(0)),
            ("nextSeq", number(snapshot.next_seq)),
            ("tradeCount", number(snapshot.trade_count)),
            (
                "tradeQtySum",
                CanonicalValue::BigInt(snapshot.trade_qty_sum),
            ),
            (
                "lastTradePriceTicks",
                CanonicalValue::BigInt(snapshot.last_trade_price_ticks),
            ),
            (
                "lastAcceptedUsdAskPriceTicks",
                CanonicalValue::BigInt(snapshot.last_accepted_usd_ask_price_ticks),
            ),
            ("eventHash", CanonicalValue::BigInt(snapshot.event_hash)),
            ("commitmentHash", text(snapshot.expected_commitment_hash)),
        ]);
        let pair = "1/2";
        let mut key = vec![HEADER_TAG];
        key.extend_from_slice(&owner);
        key.extend_from_slice(&(pair.len() as u16).to_be_bytes());
        key.extend_from_slice(pair.as_bytes());
        let rows = BTreeMap::from([(
            key,
            crate::encode_storage_payload(&header).expect("encode header"),
        )]);
        let restored = hydrate_orderbook_graph(
            &rows,
            &owner,
            &metadata(&owner),
            RestoredOrderbookAccounts {
                offers: BTreeMap::new(),
                resolving_offers: BTreeSet::new(),
            },
        )
        .expect("restore exact empty book")
        .expect("orderbook present");
        assert_eq!(restored.snapshot.books.len(), 1);
        assert_eq!(restored.snapshot.pair_dimensions.len(), 1);
    }

    #[test]
    fn orphan_page_tree_without_metadata_is_rejected() {
        let owner = [0x11; 32];
        let mut key = vec![LEAF_TAG];
        key.extend_from_slice(&owner);
        key.extend_from_slice(&[0, 1, b'x', 0, 1, 1]);
        let rows = BTreeMap::from([(key, vec![0x03, 0x80])]);
        let error = match hydrate_orderbook_graph(
            &rows,
            &owner,
            &Map::new(),
            RestoredOrderbookAccounts {
                offers: BTreeMap::new(),
                resolving_offers: BTreeSet::new(),
            },
        ) {
            Ok(_) => panic!("orphan tree must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("ORPHAN_TREE_ROWS"));
    }
}
