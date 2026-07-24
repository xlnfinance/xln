import { describe, expect, test } from 'bun:test';

import {
  applyProcessBatchGasFloor,
  PROCESS_BATCH_GAS_FLOOR,
} from '../jadapter/rpc';

describe('processBatch transformer gas floor', () => {
  test('rejects the estimator cheap-success no-op path for dispute finalization', () => {
    expect(applyProcessBatchGasFloor(267_000n, true)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR - 1n, true)).toBe(PROCESS_BATCH_GAS_FLOOR);
  });

  test('preserves estimates already above the protocol floor', () => {
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR, true)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(12_000_000n, true)).toBe(12_000_000n);
  });

  test('does not over-reserve gas for ordinary batches', () => {
    expect(applyProcessBatchGasFloor(267_000n, false)).toBe(267_000n);
  });
});
