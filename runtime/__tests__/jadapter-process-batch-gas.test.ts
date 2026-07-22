import { describe, expect, test } from 'bun:test';

import {
  applyProcessBatchGasFloor,
  PROCESS_BATCH_GAS_FLOOR,
} from '../jadapter/rpc';

describe('processBatch transformer gas floor', () => {
  test('rejects the estimator cheap-success no-op path', () => {
    expect(applyProcessBatchGasFloor(267_000n)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR - 1n)).toBe(PROCESS_BATCH_GAS_FLOOR);
  });

  test('preserves estimates already above the protocol floor', () => {
    expect(applyProcessBatchGasFloor(PROCESS_BATCH_GAS_FLOOR)).toBe(PROCESS_BATCH_GAS_FLOOR);
    expect(applyProcessBatchGasFloor(12_000_000n)).toBe(12_000_000n);
  });
});
