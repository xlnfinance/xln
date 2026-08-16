import { expect, test } from 'bun:test';

import { runSwapOrderbookBenchmark } from '../../../scripts/operations/benchmark/bench-swap-orderbook-tps';

test('orderbook TPS benchmark labels matcher overlay batching without claiming Account settlement', () => {
  const result = runSwapOrderbookBenchmark({
    swaps: 20,
    warmup: 0,
    minTps: 1,
    levels: 4,
    bookCommandsPerOverlay: 10,
  });
  expect(result.trades).toBe(20);
  expect(result.bookCommandsPerOverlay).toBe(10);
  expect('accountsPerEntityFrame' in result).toBe(false);
  expect('commandsPerEntityFrame' in result).toBe(false);
});
