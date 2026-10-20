import { describe, expect, test } from 'bun:test';

import { createAsyncLimiter } from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';

describe('isolated e2e reset concurrency', () => {
  test('one cold reset owns preparation and a rejected reset releases the next slot', async () => {
    const limiter = createAsyncLimiter(1);
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = limiter.run(async () => {
      started.push('first');
      await firstGate;
      throw new Error('reset failed');
    });
    const rejected = first.then(
      () => null,
      (error: unknown) => error,
    );
    const second = limiter.run(async () => {
      started.push('second');
      return 'ready';
    });
    const third = limiter.run(async () => {
      started.push('third');
      return 'ready';
    });
    await Promise.resolve();
    expect(started).toEqual(['first']);
    releaseFirst();
    expect(await rejected).toEqual(new Error('reset failed'));
    expect(await second).toBe('ready');
    expect(await third).toBe('ready');
    expect(started).toEqual(['first', 'second', 'third']);
  });

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
