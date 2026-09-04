/**
 * Production Account benchmark contract: economic swaps share a bounded frame.
 * Five transactions is the owner-selected realism ceiling for load evidence.
 * Human-audit importance: 85/100 — prevents inflated per-request TPS claims.
 */
import { describe, expect, test } from 'bun:test';

import {
  proveSwapRuntimeEconomics,
  runSwapRuntimeBenchmark,
} from '../../scripts/operations/benchmark/bench-swap-runtime-tps';

describe('swap Account-frame batching benchmark', () => {
  test('proves exact same-J settlement and cross-J fill progress', async () => {
    await expect(proveSwapRuntimeEconomics()).resolves.toBeUndefined();
  });

  test('counts exact same/cross Account frames at the five-transaction ceiling', async () => {
    const result = await runSwapRuntimeBenchmark({
      swaps: 10,
      warmup: 0,
      minTps: 1,
      txsPerFrame: 5,
    });
    expect(result.txsPerFrame).toBe(5);
    expect(result.accountFrames).toBe(4);
    expect(result.sameSwaps + result.crossSwaps).toBe(20);
  });

  test('rejects evidence that hides more than five transactions in a frame', async () => {
    await expect(runSwapRuntimeBenchmark({
      swaps: 6,
      warmup: 0,
      minTps: 1,
      txsPerFrame: 6,
    })).rejects.toThrow('SWAP_RUNTIME_BENCH_FRAME_TOO_LARGE:6:5');
  });
});
