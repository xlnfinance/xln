import { describe, expect, test } from 'bun:test';

import {
  applyProcessBatchGasFloor,
  PROCESS_BATCH_GAS_FLOOR,
} from '../jurisdiction/adapter/rpc-public';

describe('processBatch transformer gas floor', () => {
  test('rejects the estimator cheap-success no-op path for dispute finalization', () => {
    expect(applyProcessBatchGasFloor(267_000n, 1)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR - 1n, 1)).toBe(PROCESS_BATCH_GAS_FLOOR);
  });

  test('preserves estimates already above the protocol floor', () => {
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR, 1)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(24_000_000n, 1)).toBe(24_000_000n);
  });

  test('does not over-reserve gas when no finalization executes transformers', () => {
    expect(applyProcessBatchGasFloor(267_000n, 0)).toBe(267_000n);
  });

  test('rejects multiple transformer finalizations that cannot fit the tx gas cap', () => {
    expect(() => applyProcessBatchGasFloor(1n, 2)).toThrow(
      'J_TRANSFORMER_FINALIZATION_BATCH_LIMIT',
    );
    expect(() => applyProcessBatchGasFloor(1n, -1)).toThrow(
      'J_DISPUTE_FINALIZATION_COUNT_INVALID',
    );
  });

  test('one production finalization remains below the 60M block limit', () => {
    expect(applyProcessBatchGasFloor(1n, 1)).toBeLessThanOrEqual(60_000_000n);
  });
});
