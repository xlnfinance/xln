import { describe, expect, test } from 'bun:test';

import { createSweepHealthTracker } from '../../../watchtower/sweep-health';

describe('watchtower sweep health', () => {
  test('fails health after consecutive sweep errors and recovers only on success', () => {
    const health = createSweepHealthTracker(3);
    health.failure('rpc-1');
    health.failure('rpc-2');
    expect(health.snapshot()).toEqual({
      healthy: true,
      consecutiveFailures: 2,
      lastError: 'rpc-2',
    });
    health.failure('rpc-3');
    expect(health.snapshot().healthy).toBe(false);
    health.success();
    expect(health.snapshot()).toEqual({ healthy: true, consecutiveFailures: 0 });
  });
});
