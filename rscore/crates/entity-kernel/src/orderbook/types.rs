use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;

use super::page::BookPricePageTree;
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
}
