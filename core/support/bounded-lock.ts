/**
 * FIFO mutex with a bounded waiter queue and an acquire deadline.
 *
 * HTTP routes that hold a lock across chain waits (faucets) must not let
 * callers pile up: an unbounded queue grew one pending request per caller and
 * each waited behind every earlier holder. A full queue or an expired wait is
 * a typed rejection the route answers as retryable 429/503.
 */
export type BoundedLockRejection = 'LOCK_QUEUE_FULL' | 'LOCK_ACQUIRE_TIMEOUT';

export class BoundedLockBusyError extends Error {
  readonly code: BoundedLockRejection;

  constructor(lockName: string, code: BoundedLockRejection) {
    super(`${code}:${lockName}`);
    this.name = 'BoundedLockBusyError';
    this.code = code;
  }
}

export type BoundedLock = Readonly<{
  /** Resolves with this holder's release; rejects with BoundedLockBusyError. */
  acquire: () => Promise<() => void>;
}>;

type Waiter = { grant: () => void; timer: ReturnType<typeof setTimeout> | null };

export const createBoundedLock = (options: Readonly<{
  name: string;
  maxWaiters: number;
  acquireTimeoutMs: number;
}>): BoundedLock => {
  let held = false;
  const waiters: Waiter[] = [];

  const handOver = (): void => {
    const next = waiters.shift();
    if (!next) {
      held = false;
      return;
    }
    if (next.timer) clearTimeout(next.timer);
    next.grant();
  };

  const releaseOnce = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      handOver();
    };
  };

  const acquire = (): Promise<() => void> => {
    if (!held) {
      held = true;
      return Promise.resolve(releaseOnce());
    }
    if (waiters.length >= options.maxWaiters) {
      return Promise.reject(new BoundedLockBusyError(options.name, 'LOCK_QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { grant: () => resolve(releaseOnce()), timer: null };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new BoundedLockBusyError(options.name, 'LOCK_ACQUIRE_TIMEOUT'));
      }, options.acquireTimeoutMs);
      waiters.push(waiter);
    });
  };

  return { acquire };
};
