#[cfg(feature = "bench")]
mod benchmark;
mod book;
mod commitment;
mod matcher;
mod math;
mod page;
mod resolve;
mod types;

#[cfg(feature = "bench")]
pub use benchmark::{OrderbookBenchmarkResult, run_orderbook_benchmark};
pub use commitment::compute_book_commitment_hash;
pub use page::{BookPricePageEntrySnapshot, BookPricePageSnapshot};
pub use types::{
    BookOrder, BookState, BookStateSnapshot, OrderbookState, OrderbookStateSnapshot,
    PairDimensions, PairPolicy, SameJOffer, Side,
};

pub(crate) use matcher::{SameJOutputDelta, apply_orderbook_outputs};
