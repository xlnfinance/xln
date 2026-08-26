use xln_rscore_entity_kernel::run_orderbook_benchmark;

fn value(args: &[String], name: &str, default: usize) -> Result<usize, String> {
    let Some(index) = args.iter().position(|arg| arg == name) else {
        return Ok(default);
    };
    args.get(index + 1)
        .ok_or_else(|| format!("MISSING_ARG_VALUE:{name}"))?
        .parse::<usize>()
        .map_err(|_| format!("INVALID_ARG:{name}"))
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let swaps = value(&args, "--swaps", 100_000)?;
    let warmup = value(&args, "--warmup", 10_000)?;
    let levels = value(&args, "--levels", 32)?;
    let result =
        run_orderbook_benchmark(swaps, warmup, levels).map_err(|error| error.to_string())?;
    println!(
        concat!(
            "{{\"benchmark\":\"rscore-orderbook-core\",",
            "\"swaps\":{},\"trades\":{},\"elapsedMs\":{:.3},\"tps\":{:.2},",
            "\"activeOrders\":{},\"tradeQtySum\":\"{}\",\"root\":\"{}\"}}"
        ),
        result.swaps,
        result.trades,
        result.elapsed_ms,
        result.tps,
        result.active_orders,
        result.trade_qty_sum,
        result.root,
    );
    Ok(())
}
