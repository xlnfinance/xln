import { describe, expect, test } from 'bun:test';

import { BoundedLockBusyError, createBoundedLock } from '../../support/bounded-lock';

describe('bounded lock', () => {
  test('hands the lock over in FIFO order and ignores a repeated release', async () => {
    const lock = createBoundedLock({ name: 'fifo', maxWaiters: 4, acquireTimeoutMs: 1_000 });
    const order: string[] = [];
    const releaseFirst = await lock.acquire();
    const second = lock.acquire().then(release => {
      order.push('second');
      return release;
    });
    const third = lock.acquire().then(release => {
      order.push('third');
      return release;
    });
    releaseFirst();
    releaseFirst();
    const releaseSecond = await second;
    await Promise.resolve();
    expect(order).toEqual(['second']);
    releaseSecond();
    (await third)();
    expect(order).toEqual(['second', 'third']);
    (await lock.acquire())();
  });

  test('rejects a caller beyond the waiter bound instead of queueing it', async () => {
    const lock = createBoundedLock({ name: 'bounded', maxWaiters: 1, acquireTimeoutMs: 1_000 });
    const release = await lock.acquire();
    const queued = lock.acquire();
    const rejected = await lock.acquire().catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(BoundedLockBusyError);
    expect((rejected as BoundedLockBusyError).code).toBe('LOCK_QUEUE_FULL');
    release();
    (await queued)();
  });

  test('a timed-out waiter leaves the queue and never receives the lock', async () => {
    const lock = createBoundedLock({ name: 'deadline', maxWaiters: 1, acquireTimeoutMs: 10 });
    const release = await lock.acquire();
    const expired = await lock.acquire().catch((error: unknown) => error);
    expect((expired as BoundedLockBusyError).code).toBe('LOCK_ACQUIRE_TIMEOUT');
    const next = lock.acquire();
    release();
    (await next)();
  });
});
