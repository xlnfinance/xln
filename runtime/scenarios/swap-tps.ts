import type { Env } from '../types';
import { runSwapOrderbookBenchmark } from '../scripts/bench-swap-orderbook-tps';

export async function swapTps(_env: Env): Promise<void> {
  const result = runSwapOrderbookBenchmark({
    swaps: 100_000,
    warmup: 10_000,
    minTps: 10_000,
    levels: 32,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await swapTps({} as Env);
}
