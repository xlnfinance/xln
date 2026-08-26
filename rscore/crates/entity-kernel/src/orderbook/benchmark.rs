use std::time::Instant;

use num_bigint::BigInt;

use crate::EntityKernelError;

use super::book::{AddOrder, BookEvent, MakerDisposition, apply_gtc};
use super::{BookState, PairDimensions, Side, compute_book_commitment_hash};

const BASE_PRICE_TICKS: u64 = 25_000_000;
const OWNER_CARDINALITY: usize = 4_096;

#[derive(Clone, Debug, PartialEq)]
pub struct OrderbookBenchmarkResult {
    pub swaps: usize,
    pub trades: u64,
    pub elapsed_ms: f64,
    pub tps: f64,
    pub active_orders: usize,
    pub trade_qty_sum: String,
    pub root: String,
}

fn order(
    prefix: &str,
    index: usize,
    side: Side,
    price_ticks: u64,
) -> Result<AddOrder, EntityKernelError> {
    let owner_index = index % OWNER_CARDINALITY;
    Ok(AddOrder {
        order_id: format!("{prefix}-{index}"),
        owner_id: format!("{prefix}-{owner_index}"),
        side,
        price_ticks: BigInt::from(price_ticks),
        qty_lots: BigInt::from(1_u8),
    })
}

fn run_sweep(swaps: usize, levels: usize) -> Result<OrderbookBenchmarkResult, EntityKernelError> {
    let max_orders = swaps
        .checked_add(16)
        .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_BENCH_CAPACITY_OVERFLOW"))?;
    let level_count = u64::try_from(levels)
        .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_BENCH_LEVELS_ENCODING"))?;
    let dimensions = PairDimensions {
        base_token_decimals: 6,
        quote_token_decimals: 18,
    };
    let mut book = BookState::empty(max_orders, 100);
    for index in 0..swaps {
        let level = u64::try_from(index % levels)
            .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_BENCH_LEVEL_ENCODING"))?;
        let events = apply_gtc(
            &mut book,
            order("ask", index, Side::Ask, BASE_PRICE_TICKS + level)?,
            dimensions,
            |_| Ok(MakerDisposition::Eligible),
        )?;
        if events
            .iter()
            .any(|event| matches!(event, BookEvent::Reject { .. }))
        {
            return Err(EntityKernelError::orderbook("ORDERBOOK_BENCH_SEED_REJECT"));
        }
    }

    let started = Instant::now();
    let mut trades = 0_u64;
    for index in 0..swaps {
        let events = apply_gtc(
            &mut book,
            order("buy", index, Side::Bid, BASE_PRICE_TICKS + level_count)?,
            dimensions,
            |_| Ok(MakerDisposition::Eligible),
        )?;
        let event_trades = events
            .iter()
            .filter(|event| matches!(event, BookEvent::Trade { .. }))
            .count();
        trades = trades
            .checked_add(u64::try_from(event_trades).map_err(|_| {
                EntityKernelError::orderbook("ORDERBOOK_BENCH_TRADE_COUNT_ENCODING")
            })?)
            .ok_or_else(|| EntityKernelError::orderbook("ORDERBOOK_BENCH_TRADE_COUNT_OVERFLOW"))?;
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let expected_trades = u64::try_from(swaps)
        .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_BENCH_SWAPS_ENCODING"))?;
    if trades != expected_trades || book.trade_count != expected_trades {
        return Err(EntityKernelError::orderbook(format!(
            "ORDERBOOK_BENCH_TRADE_MISMATCH:{trades}/{expected_trades}/{}",
            book.trade_count
        )));
    }
    if !book.orders.is_empty() || book.best_bid().is_some() || book.best_ask().is_some() {
        return Err(EntityKernelError::orderbook(format!(
            "ORDERBOOK_BENCH_NOT_DRAINED:{}",
            book.orders.len()
        )));
    }
    let elapsed_seconds = (elapsed_ms / 1_000.0).max(0.000_001);
    Ok(OrderbookBenchmarkResult {
        swaps,
        trades,
        elapsed_ms,
        tps: trades as f64 / elapsed_seconds,
        active_orders: book.orders.len(),
        trade_qty_sum: book.trade_qty_sum.to_string(),
        root: compute_book_commitment_hash(&book)?,
    })
}

pub fn run_orderbook_benchmark(
    swaps: usize,
    warmup: usize,
    levels: usize,
) -> Result<OrderbookBenchmarkResult, EntityKernelError> {
    if swaps == 0 || levels == 0 {
        return Err(EntityKernelError::orderbook(
            "ORDERBOOK_BENCH_ARGUMENT_INVALID",
        ));
    }
    if warmup > 0 {
        let warm = run_sweep(warmup, levels)?;
        let expected = u64::try_from(warmup)
            .map_err(|_| EntityKernelError::orderbook("ORDERBOOK_BENCH_WARMUP_ENCODING"))?;
        if warm.trades != expected {
            return Err(EntityKernelError::orderbook(
                "ORDERBOOK_BENCH_WARMUP_MISMATCH",
            ));
        }
    }
    run_sweep(swaps, levels)
}

#[cfg(test)]
mod tests {
    use super::run_sweep;

    #[test]
    fn exact_typescript_sweep_root_is_stable() {
        let result = run_sweep(1_000, 32).expect("orderbook sweep");
        assert_eq!(result.trades, 1_000);
        assert_eq!(result.active_orders, 0);
        assert_eq!(result.trade_qty_sum, "1000");
        assert_eq!(result.root, "0x1369151b7e178045ea4c6b6a1a150354");
    }
}
