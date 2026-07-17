import { describe, expect, test } from 'bun:test';

import { createAsyncLimiter } from '../scripts/run-e2e-parallel-isolated';

describe('isolated e2e reset concurrency', () => {
  test('a healthy shard never waits for unrelated resets to drain', async () => {
    const limiter = createAsyncLimiter(2);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve;
    });

    const slow = limiter.run(async () => {
      await slowGate;
      return 'slow';
    });
    const fast = limiter.run(async () => 'fast');

    expect('drain' in limiter).toBe(false);
    expect(await fast).toBe('fast');
    releaseSlow();
    expect(await slow).toBe('slow');
  });
});
