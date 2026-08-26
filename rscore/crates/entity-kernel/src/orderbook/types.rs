use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;

use crate::EntityKernelError;

use super::commitment::compute_book_commitment_hash;
use super::page::{BookPricePageSnapshot, BookPricePageTree};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SameJOffer {
    pub offer_id: String,
    pub left_entity: String,
    pub right_entity: String,
    pub give_token_id: u32,
    pub give_token_decimals: u32,
    pub give_amount: BigInt,
    pub want_token_id: u32,
    pub want_token_decimals: u32,
    pub want_amount: BigInt,
    pub max_fee: BigInt,
    pub min_net_receive: BigInt,
    pub price_ticks: BigInt,
    pub time_in_force: Option<u8>,
    pub maker_is_left: bool,
    pub created_height: u64,
    pub quantized_give: BigInt,
    pub quantized_want: BigInt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Side {
    Bid,
    Ask,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairPolicy {
    pub price_step_ticks: u32,
    pub book_bucket_width_ticks: u32,
    pub mid_price_ticks: BigInt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairDimensions {
    pub base_token_decimals: u32,
    pub quote_token_decimals: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookOrder {
    pub order_id: String,
    pub owner_id: String,
    pub side: Side,
    pub price_ticks: BigInt,
    pub qty_lots: BigInt,
    pub seq: u64,
    pub page_sequence: u16,
    pub page_slot: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookState {
    pub bucket_width_ticks: BigInt,
    pub stp_policy: u8,
    pub max_orders: usize,
    pub orders: BTreeMap<String, BookOrder>,
    pub next_seq: u64,
    pub trade_count: u64,
    pub trade_qty_sum: BigInt,
    pub last_trade_price_ticks: BigInt,
    pub last_accepted_usd_ask_price_ticks: BigInt,
    pub event_hash: BigInt,
    pub(crate) bid_pages: BookPricePageTree,
    pub(crate) ask_pages: BookPricePageTree,
    pub(crate) bids: BTreeMap<(Reverse<BigInt>, u64), String>,
    pub(crate) asks: BTreeMap<(BigInt, u64), String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookStateSnapshot {
    pub bucket_width_ticks: BigInt,
    pub stp_policy: u8,
    pub max_orders: usize,
    pub next_seq: u64,
    pub trade_count: u64,
    pub trade_qty_sum: BigInt,
    pub last_trade_price_ticks: BigInt,
    pub last_accepted_usd_ask_price_ticks: BigInt,
    pub event_hash: BigInt,
    pub bid_pages: Vec<BookPricePageSnapshot>,
    pub ask_pages: Vec<BookPricePageSnapshot>,
    pub expected_bid_pages_root: String,
    pub expected_ask_pages_root: String,
    pub expected_commitment_hash: String,
}

impl BookState {
    pub fn empty(max_orders: usize, bucket_width_ticks: u32) -> Self {
        Self {
            bucket_width_ticks: BigInt::from(bucket_width_ticks.max(1)),
            stp_policy: 1,
            max_orders,
            orders: BTreeMap::new(),
            next_seq: 1,
            trade_count: 0,
            trade_qty_sum: BigInt::from(0),
            last_trade_price_ticks: BigInt::from(0),
            last_accepted_usd_ask_price_ticks: BigInt::from(0),
            event_hash: BigInt::from(0),
            bid_pages: BookPricePageTree::empty(),
            ask_pages: BookPricePageTree::empty(),
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
        }
    }

    pub fn best_bid(&self) -> Option<&BigInt> {
        let order_id = self.bids.first_key_value()?.1;
        self.orders.get(order_id).map(|order| &order.price_ticks)
    }

    pub fn best_ask(&self) -> Option<&BigInt> {
        let order_id = self.asks.first_key_value()?.1;
        self.orders.get(order_id).map(|order| &order.price_ticks)
    }

    pub fn bid_pages_root(&self) -> String {
        self.bid_pages.root_hash()
    }

    pub fn ask_pages_root(&self) -> String {
        self.ask_pages.root_hash()
    }

    /// Restore the exact committed page layout. Re-inserting a flat order list
    /// is forbidden here: canceled slots are part of the TypeScript page root.
    pub fn restore(snapshot: BookStateSnapshot) -> Result<Self, EntityKernelError> {
        if snapshot.bucket_width_ticks <= BigInt::from(0) {
            return Err(EntityKernelError::orderbook("BOOK_BUCKET_WIDTH_INVALID"));
        }
        if snapshot.stp_policy > 1 {
            return Err(EntityKernelError::orderbook("BOOK_STP_POLICY_INVALID"));
        }
        let (bid_pages, mut restored_orders) =
            BookPricePageTree::restore(Side::Bid, &snapshot.bid_pages)?;
        let (ask_pages, ask_orders) = BookPricePageTree::restore(Side::Ask, &snapshot.ask_pages)?;
        restored_orders.extend(ask_orders);
        if restored_orders.len() > snapshot.max_orders {
            return Err(EntityKernelError::orderbook("ORDERBOOK_CAPACITY"));
        }
        let mut orders = BTreeMap::new();
        let mut bids = BTreeMap::new();
        let mut asks = BTreeMap::new();
        let mut sequences = BTreeSet::new();
        for order in restored_orders {
            if order.seq >= snapshot.next_seq {
                return Err(EntityKernelError::orderbook("BOOK_ORDER_SEQUENCE_INVALID"));
            }
            if !sequences.insert(order.seq)
                || orders
                    .insert(order.order_id.clone(), order.clone())
                    .is_some()
            {
                return Err(EntityKernelError::orderbook("BOOK_ORDER_INDEX_DUPLICATE"));
            }
            match order.side {
                Side::Bid => {
                    bids.insert(
                        (Reverse(order.price_ticks.clone()), order.seq),
                        order.order_id,
                    );
                }
                Side::Ask => {
                    asks.insert((order.price_ticks.clone(), order.seq), order.order_id);
                }
            }
        }
        let state = Self {
            bucket_width_ticks: snapshot.bucket_width_ticks,
            stp_policy: snapshot.stp_policy,
            max_orders: snapshot.max_orders,
            orders,
            next_seq: snapshot.next_seq,
            trade_count: snapshot.trade_count,
            trade_qty_sum: snapshot.trade_qty_sum,
            last_trade_price_ticks: snapshot.last_trade_price_ticks,
            last_accepted_usd_ask_price_ticks: snapshot.last_accepted_usd_ask_price_ticks,
            event_hash: snapshot.event_hash,
            bid_pages,
            ask_pages,
            bids,
            asks,
        };
        if state.bid_pages_root() != snapshot.expected_bid_pages_root {
            return Err(EntityKernelError::orderbook("BOOK_BID_PAGES_ROOT_MISMATCH"));
        }
        if state.ask_pages_root() != snapshot.expected_ask_pages_root {
            return Err(EntityKernelError::orderbook("BOOK_ASK_PAGES_ROOT_MISMATCH"));
        }
        if compute_book_commitment_hash(&state)? != snapshot.expected_commitment_hash {
            return Err(EntityKernelError::orderbook("BOOK_COMMITMENT_MISMATCH"));
        }
        Ok(state)
    }

    pub fn snapshot(&self) -> Result<BookStateSnapshot, EntityKernelError> {
        Ok(BookStateSnapshot {
            bucket_width_ticks: self.bucket_width_ticks.clone(),
            stp_policy: self.stp_policy,
            max_orders: self.max_orders,
            next_seq: self.next_seq,
            trade_count: self.trade_count,
            trade_qty_sum: self.trade_qty_sum.clone(),
            last_trade_price_ticks: self.last_trade_price_ticks.clone(),
            last_accepted_usd_ask_price_ticks: self.last_accepted_usd_ask_price_ticks.clone(),
            event_hash: self.event_hash.clone(),
            bid_pages: self.bid_pages.snapshot()?,
            ask_pages: self.ask_pages.snapshot()?,
            expected_bid_pages_root: self.bid_pages_root(),
            expected_ask_pages_root: self.ask_pages_root(),
            expected_commitment_hash: compute_book_commitment_hash(self)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderbookState {
    pub books: BTreeMap<String, BookState>,
    pub pair_dimensions: BTreeMap<String, PairDimensions>,
    pub offers: BTreeMap<(String, String), SameJOffer>,
    pub resolving_offers: BTreeSet<(String, String)>,
    pub pair_by_order: BTreeMap<String, String>,
    pub max_orders_per_pair: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderbookStateSnapshot {
    pub books: BTreeMap<String, BookStateSnapshot>,
    pub pair_dimensions: BTreeMap<String, PairDimensions>,
    pub offers: BTreeMap<(String, String), SameJOffer>,
    pub resolving_offers: BTreeSet<(String, String)>,
    pub pair_by_order: BTreeMap<String, String>,
    pub max_orders_per_pair: usize,
}

impl OrderbookState {
    pub fn empty(max_orders_per_pair: usize) -> Self {
        Self {
            books: BTreeMap::new(),
            pair_dimensions: BTreeMap::new(),
            offers: BTreeMap::new(),
            resolving_offers: BTreeSet::new(),
            pair_by_order: BTreeMap::new(),
            max_orders_per_pair,
        }
    }

    pub fn restore(snapshot: OrderbookStateSnapshot) -> Result<Self, EntityKernelError> {
        if snapshot.max_orders_per_pair == 0 {
            return Err(EntityKernelError::orderbook("ORDERBOOK_MAX_ORDERS_INVALID"));
        }
        let mut books = BTreeMap::new();
        for (pair_id, book) in snapshot.books {
            if pair_id.is_empty() || book.max_orders > snapshot.max_orders_per_pair {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_BOOK_POLICY_INVALID",
                ));
            }
            if books.insert(pair_id, BookState::restore(book)?).is_some() {
                return Err(EntityKernelError::orderbook("ORDERBOOK_BOOK_DUPLICATE"));
            }
        }
        for (pair_id, dimensions) in &snapshot.pair_dimensions {
            if pair_id.is_empty()
                || dimensions.base_token_decimals > 255
                || dimensions.quote_token_decimals > 255
            {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_PAIR_DIMENSIONS_INVALID",
                ));
            }
        }
        if books
            .keys()
            .any(|pair_id| !snapshot.pair_dimensions.contains_key(pair_id))
        {
            return Err(EntityKernelError::orderbook(
                "ORDERBOOK_PAIR_DIMENSIONS_MISSING",
            ));
        }
        for ((account_id, offer_id), offer) in &snapshot.offers {
            if account_id.is_empty()
                || offer_id.is_empty()
                || offer.offer_id != *offer_id
                || (offer.left_entity != *account_id && offer.right_entity != *account_id)
            {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_OFFER_INDEX_INVALID",
                ));
            }
        }
        if snapshot
            .resolving_offers
            .iter()
            .any(|key| !snapshot.offers.contains_key(key))
        {
            return Err(EntityKernelError::orderbook(
                "ORDERBOOK_RESOLVING_OFFER_MISSING",
            ));
        }
        for (order_id, pair_id) in &snapshot.pair_by_order {
            let Some(book) = books.get(pair_id) else {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_ORDER_PAIR_BOOK_MISSING",
                ));
            };
            if !book.orders.contains_key(order_id) {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_ORDER_PAIR_INDEX_INVALID",
                ));
            }
        }
        if books.iter().any(|(pair_id, book)| {
            book.orders.iter().any(|(order_id, _)| {
                snapshot.pair_by_order.get(order_id).map(String::as_str) != Some(pair_id.as_str())
            })
        }) {
            return Err(EntityKernelError::orderbook(
                "ORDERBOOK_ORDER_PAIR_INDEX_INCOMPLETE",
            ));
        }
        let state = Self {
            books,
            pair_dimensions: snapshot.pair_dimensions,
            offers: snapshot.offers,
            resolving_offers: snapshot.resolving_offers,
            pair_by_order: snapshot.pair_by_order,
            max_orders_per_pair: snapshot.max_orders_per_pair,
        };
        super::matcher::validate_restored_state(&state)?;
        Ok(state)
    }

    pub fn snapshot(&self) -> Result<OrderbookStateSnapshot, EntityKernelError> {
        let books = self
            .books
            .iter()
            .map(|(pair_id, book)| Ok((pair_id.clone(), book.snapshot()?)))
            .collect::<Result<_, EntityKernelError>>()?;
        Ok(OrderbookStateSnapshot {
            books,
            pair_dimensions: self.pair_dimensions.clone(),
            offers: self.offers.clone(),
            resolving_offers: self.resolving_offers.clone(),
            pair_by_order: self.pair_by_order.clone(),
            max_orders_per_pair: self.max_orders_per_pair,
        })
    }
}
