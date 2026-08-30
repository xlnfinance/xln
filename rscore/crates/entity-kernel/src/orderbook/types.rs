use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::SwapOfferSnapshot;
use xln_rscore_protocol::CanonicalValue;

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
    pub cross_jurisdiction: Option<CanonicalValue>,
}

impl From<SwapOfferSnapshot> for SameJOffer {
    fn from(offer: SwapOfferSnapshot) -> Self {
        Self {
            offer_id: offer.offer_id,
            left_entity: offer.left_entity,
            right_entity: offer.right_entity,
            give_token_id: offer.give_token_id,
            give_token_decimals: offer.give_token_decimals,
            give_amount: offer.give_amount,
            want_token_id: offer.want_token_id,
            want_token_decimals: offer.want_token_decimals,
            want_amount: offer.want_amount,
            max_fee: offer.max_fee,
            min_net_receive: offer.min_net_receive,
            price_ticks: offer.price_ticks,
            time_in_force: offer.time_in_force,
            maker_is_left: offer.maker_is_left,
            created_height: offer.created_height,
            quantized_give: offer.quantized_give,
            quantized_want: offer.quantized_want,
            cross_jurisdiction: offer.cross_jurisdiction,
        }
    }
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
pub struct BookSideLevel {
    pub price_ticks: BigInt,
    pub qty_lots: BigInt,
    pub owner_ids: Vec<String>,
    pub order_ids: Vec<String>,
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

    /// Bounded top-of-book projection over the maintained price/time indexes.
    /// This never scans unrelated prices or rebuilds a book from `orders`.
    pub fn side_levels(
        &self,
        side: Side,
        depth: usize,
    ) -> Result<Vec<BookSideLevel>, EntityKernelError> {
        let ids: Box<dyn Iterator<Item = &String> + '_> = match side {
            Side::Bid => Box::new(self.bids.values()),
            Side::Ask => Box::new(self.asks.values()),
        };
        let mut levels = Vec::<BookSideLevel>::with_capacity(depth);
        let mut owners = BTreeSet::<String>::new();
        for order_id in ids {
            let order = self
                .orders
                .get(order_id)
                .filter(|order| order.side == side)
                .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_PRICE_INDEX_DIVERGED"))?;
            if levels
                .last()
                .is_none_or(|level| level.price_ticks != order.price_ticks)
            {
                if levels.len() >= depth {
                    break;
                }
                owners.clear();
                levels.push(BookSideLevel {
                    price_ticks: order.price_ticks.clone(),
                    qty_lots: BigInt::from(0),
                    owner_ids: Vec::new(),
                    order_ids: Vec::new(),
                });
            }
            let level = levels.last_mut().expect("level was just installed");
            level.qty_lots += &order.qty_lots;
            if owners.insert(order.owner_id.clone()) {
                level.owner_ids.push(order.owner_id.clone());
            }
            level.order_ids.push(order.order_id.clone());
        }
        Ok(levels)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn order(id: &str, owner: &str, side: Side, price: u32, qty: u32, seq: u64) -> BookOrder {
        BookOrder {
            order_id: id.into(),
            owner_id: owner.into(),
            side,
            price_ticks: price.into(),
            qty_lots: qty.into(),
            seq,
            page_sequence: 0,
            page_slot: 0,
        }
    }

    #[test]
    fn bounded_side_levels_preserve_price_time_and_unique_owner_order() {
        let mut book = BookState::empty(16, 10);
        for row in [
            order("b1", "alice", Side::Bid, 110, 2, 1),
            order("b2", "alice", Side::Bid, 110, 3, 2),
            order("b3", "bob", Side::Bid, 110, 5, 3),
            order("b4", "carol", Side::Bid, 100, 7, 4),
            order("b5", "dave", Side::Bid, 90, 11, 5),
        ] {
            book.bids.insert(
                (Reverse(row.price_ticks.clone()), row.seq),
                row.order_id.clone(),
            );
            book.orders.insert(row.order_id.clone(), row);
        }
        let levels = book.side_levels(Side::Bid, 2).expect("levels");
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0].price_ticks, BigInt::from(110));
        assert_eq!(levels[0].qty_lots, BigInt::from(10));
        assert_eq!(levels[0].owner_ids, ["alice", "bob"]);
        assert_eq!(levels[0].order_ids, ["b1", "b2", "b3"]);
        assert_eq!(levels[1].price_ticks, BigInt::from(100));
        assert_eq!(levels[1].order_ids, ["b4"]);
    }
}
