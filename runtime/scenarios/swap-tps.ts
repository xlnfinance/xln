import type { Env } from '../types';
import { runSwapOrderbookBenchmark } from '../scripts/bench-swap-orderbook-tps';
import { runSwapRuntimeBenchmark } from '../scripts/bench-swap-runtime-tps';

export async function swapTps(_env: Env): Promise<void> {
  const orderbook = runSwapOrderbookBenchmark({
    swaps: 100_000,
    warmup: 10_000,
    minTps: 10_000,
    levels: 32,
  });
  const runtime = await runSwapRuntimeBenchmark({
    swaps: 25_000,
    warmup: 2_500,
    minTps: 10_000,
  });
  console.log(JSON.stringify({ orderbook, runtime }, null, 2));
}

if (import.meta.main) {
  await swapTps({} as Env);
}
