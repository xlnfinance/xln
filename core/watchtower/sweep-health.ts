import type { createStructuredLogger } from '../support/logger';

type SweepHealthSnapshot = {
  healthy: boolean;
  consecutiveFailures: number;
  lastError?: string;
  itemErrors?: number;
};

export type SweepHealthTracker = {
  failure(error: string): void;
  success(itemErrors?: number): void;
  snapshot(): SweepHealthSnapshot;
};

export const createSweepHealthTracker = (failureThreshold = 3): SweepHealthTracker => {
  const threshold = Math.max(1, Math.floor(failureThreshold));
  let consecutiveFailures = 0;
  let lastError = '';
  let itemErrors = 0;
  return {
    failure: error => {
      consecutiveFailures += 1;
      lastError = error;
      itemErrors = 0;
    },
    success: (failedItems = 0) => {
      consecutiveFailures = 0;
      lastError = '';
      itemErrors = failedItems;
    },
    snapshot: () => ({
      healthy: consecutiveFailures < threshold,
      consecutiveFailures,
      ...(lastError ? { lastError } : {}),
      ...(itemErrors > 0 ? { itemErrors } : {}),
    }),
  };
};

/** Runs one sweep at a time. The scheduler and the operator endpoint share one lock. */
export type SweepLock = <T>(run: () => Promise<T>) => Promise<T>;

export const createSweepLock = (): SweepLock => {
  let queue = Promise.resolve();
  return async run => {
    const predecessor = queue;
    let release = (): void => undefined;
    queue = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    try {
      return await run();
    } finally {
      release();
    }
  };
};

type SweepOutcome = {
  items: number;
  itemErrors: number;
  fields: Record<string, number>;
};

export type IntervalSweep = {
  enabled: boolean;
  intervalMs: number;
  health: () => SweepHealthSnapshot;
  close: () => void;
};

type IntervalSweepOptions = {
  intervalMs: number;
  lock: SweepLock;
  run: () => Promise<SweepOutcome>;
  prune: () => Promise<unknown>;
  log: ReturnType<typeof createStructuredLogger>;
  events: { complete: string; failed: string; errorsCode: string };
};

const SWEEP_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const disabledIntervalSweep = (intervalMs: number): IntervalSweep => ({
  enabled: false,
  intervalMs,
  health: createSweepHealthTracker().snapshot,
  close: () => {},
});

/** Timer chain: the next tick is scheduled only after this one finished. */
export const startIntervalSweep = (options: IntervalSweepOptions): IntervalSweep => {
  const { events, log } = options;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPruneAt = Date.now() + SWEEP_PRUNE_INTERVAL_MS;
  const health = createSweepHealthTracker();

  const sweepOnce = async (): Promise<void> => {
    const now = Date.now();
    if (now >= nextPruneAt) {
      nextPruneAt = now + SWEEP_PRUNE_INTERVAL_MS;
      await options.prune();
    }
    const outcome = await options.run();
    if (Object.values(outcome.fields).some(value => value > 0)) {
      if (outcome.itemErrors > 0) log.warn(events.complete, outcome.fields);
      else log.info(events.complete, outcome.fields);
    }
    // One appointment or target is the sender's input: its failure is a
    // receipt and a log line. The tower is unhealthy only when the sweep cannot
    // run at all or when every item it had failed.
    if (outcome.items > 0 && outcome.itemErrors >= outcome.items) {
      health.failure(`${events.errorsCode}:${outcome.itemErrors}`);
    } else {
      health.success(outcome.itemErrors);
    }
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      await options.lock(sweepOnce);
    } catch (error) {
      const message = formatError(error);
      health.failure(message);
      log.error(events.failed, { error: message });
    } finally {
      if (!closed) {
        timer = setTimeout(tick, options.intervalMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, options.intervalMs);
  timer.unref?.();
  return {
    enabled: true,
    intervalMs: options.intervalMs,
    health: health.snapshot,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
};
