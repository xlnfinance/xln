#[cfg(feature = "bench")]
mod benchmark;
mod book;
mod commitment;
mod matcher;
mod math;
mod page;
mod policy;
mod resolve;
mod types;

#[cfg(feature = "bench")]
pub use benchmark::{OrderbookBenchmarkResult, run_orderbook_benchmark};
pub use commitment::compute_book_commitment_hash;
pub use math::PRICE_SCALE as ORDERBOOK_PRICE_SCALE;
pub use page::{BookPricePageEntrySnapshot, BookPricePageSnapshot};
pub use policy::{
    canonical_pair_orientation, canonical_pair_policy, canonical_token_decimals,
    is_canonical_liquid_token,
};
pub use types::{
    BookOrder, BookSideLevel, BookState, BookStateSnapshot, OrderbookState, OrderbookStateSnapshot,
    PairDimensions, PairPolicy, SameJOffer, Side,
};

pub(crate) use matcher::{
    OrderbookPairJob, OrderbookPairResult, PreparedOrderbookStage, SameJOutputDelta,
    install_orderbook_outputs, prepare_orderbook_outputs, validate_orderbook_outputs,
};
pub(crate) use math::lot_scale;
