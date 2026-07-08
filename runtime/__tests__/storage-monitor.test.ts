import { describe, expect, test } from 'bun:test';

import { assertDiskFreeAtLeast, getMinDiskFreeBytes } from '../orchestrator/storage-monitor';

describe('storage monitor disk guard', () => {
  test('accepts free space equal to the required floor', () => {
    expect(() => assertDiskFreeAtLeast(5, 5)).not.toThrow();
  });

  test('fails closed when free space is below the required floor', () => {
    expect(() => assertDiskFreeAtLeast(4, 5)).toThrow('INSUFFICIENT_DISK_FREE: free=4 required=5');
  });

  test('exposes the runtime disk guard threshold for gate evidence', () => {
    expect(getMinDiskFreeBytes()).toBeGreaterThanOrEqual(1024 ** 3);
  });
});
