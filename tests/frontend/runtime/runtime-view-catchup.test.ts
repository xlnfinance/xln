import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RuntimeViewCatchupCoordinator,
  runtimeViewCatchupRetryDelayMs,
  type RuntimeViewCatchupState,
} from '../../../frontend/packages/runtime-client/src/runtime-view-catchup';

type ScheduledRetry = {
  listener: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
};

type HarnessOptions = Readonly<{
  retryLimit?: number;
  refresh?: (
    call: number,
    updateState: (next: Partial<RuntimeViewCatchupState>) => void,
  ) => Promise<void>;
}>;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const createHarness = (options: HarnessOptions = {}) => {
  let state: RuntimeViewCatchupState = {
    atHeight: null,
    frameHeight: 1,
    hasFrame: true,
    status: 'connected',
  };
  let refreshCalls = 0;
  const timeouts: string[] = [];
  const refreshErrors: unknown[] = [];
  const retries: ScheduledRetry[] = [];
  const updateState = (next: Partial<RuntimeViewCatchupState>): void => {
    state = { ...state, ...next };
  };
  const coordinator = new RuntimeViewCatchupCoordinator<ScheduledRetry>({
    readState: () => state,
    refresh: async () => {
      refreshCalls += 1;
      await options.refresh?.(refreshCalls, updateState);
    },
    publishTimeout: (message) => { timeouts.push(message); },
    reportRefreshError: (error) => { refreshErrors.push(error); },
    scheduleRetry: (listener, delayMs) => {
      const retry = { listener, delayMs, cancelled: false, fired: false };
      retries.push(retry);
      return retry;
    },
    cancelRetry: (retry) => { retry.cancelled = true; },
    retryLimit: options.retryLimit,
  });
  const activeRetries = (): ScheduledRetry[] =>
    retries.filter(({ cancelled, fired }) => !cancelled && !fired);
  const runNextRetry = async (): Promise<void> => {
    const retry = activeRetries()[0];
    if (!retry) throw new Error('NO_RUNTIME_VIEW_RETRY_SCHEDULED');
    retry.fired = true;
    retry.listener();
    await settle();
  };
  return {
    coordinator,
    updateState,
    refreshCalls: () => refreshCalls,
    timeouts,
    refreshErrors,
    retries,
    activeRetries,
    runNextRetry,
  };
};

describe('runtime-client RuntimeView catch-up coordinator', () => {
  test('uses bounded exponential retry delays', () => {
    expect([0, 1, 2, 3, 20].map(runtimeViewCatchupRetryDelayMs))
      .toEqual([50, 100, 200, 250, 250]);
  });

  test('ignores historical, disconnected, zero, and already-published heights', async () => {
    const harness = createHarness();
    harness.updateState({ atHeight: 4 });
    harness.coordinator.observeHeight(5);
    harness.updateState({ atHeight: null, status: 'connecting' });
    harness.coordinator.observeHeight(5);
    harness.updateState({ status: 'connected' });
    harness.coordinator.observeHeight(0);
    harness.coordinator.observeHeight(1);
    await settle();

    expect(harness.refreshCalls()).toBe(0);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('remembers a committed height until the initial frame is published', async () => {
    const harness = createHarness({
      refresh: async (_call, updateState) => { updateState({ frameHeight: 5 }); },
    });
    harness.updateState({ frameHeight: 0, hasFrame: false });
    harness.coordinator.observeHeight(5);
    await settle();
    expect(harness.refreshCalls()).toBe(0);

    harness.updateState({ frameHeight: 2, hasFrame: true });
    await harness.coordinator.continue();
    expect(harness.refreshCalls()).toBe(1);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('coalesces newer heights while one catch-up refresh is in flight', async () => {
    const firstRefresh = deferred();
    const harness = createHarness({
      refresh: async (call, updateState) => {
        if (call === 1) {
          await firstRefresh.promise;
          updateState({ frameHeight: 3 });
          return;
        }
        updateState({ frameHeight: 5 });
      },
    });

    harness.coordinator.observeHeight(3);
    await settle();
    harness.coordinator.observeHeight(5);
    await settle();
    expect(harness.refreshCalls()).toBe(1);

    firstRefresh.resolve();
    await settle();
    expect(harness.activeRetries().map(({ delayMs }) => delayMs)).toEqual([50]);
    await harness.runNextRetry();
    expect(harness.refreshCalls()).toBe(2);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('a newer committed height cancels stale retry timing and refreshes immediately', async () => {
    const harness = createHarness();
    harness.coordinator.observeHeight(3);
    await settle();
    const staleRetry = harness.activeRetries()[0];
    expect(staleRetry?.delayMs).toBe(50);

    harness.coordinator.observeHeight(5);
    await settle();
    expect(staleRetry?.cancelled).toBe(true);
    expect(harness.refreshCalls()).toBe(2);
    expect(harness.activeRetries().map(({ delayMs }) => delayMs)).toEqual([50]);
  });

  test('publishes a loud timeout after the bounded retry budget', async () => {
    const harness = createHarness({ retryLimit: 2 });
    harness.coordinator.observeHeight(5);
    await settle();
    await harness.runNextRetry();
    await harness.runNextRetry();

    expect(harness.refreshCalls()).toBe(3);
    expect(harness.retries.map(({ delayMs }) => delayMs)).toEqual([50, 100]);
    expect(harness.timeouts).toEqual([
      'RUNTIME_VIEW_CATCHUP_TIMEOUT: target=h5 frame=h1',
    ]);
  });

  test('reports refresh failures and keeps retrying the pending height', async () => {
    const harness = createHarness({
      refresh: async (call, updateState) => {
        if (call === 1) throw new Error('RUNTIME_VIEW_READ_FAILED');
        updateState({ frameHeight: 5 });
      },
    });
    harness.coordinator.observeHeight(5);
    await settle();

    expect(harness.refreshErrors).toHaveLength(1);
    expect(harness.activeRetries()).toHaveLength(1);
    await harness.runNextRetry();
    expect(harness.refreshCalls()).toBe(2);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('reset clears pending work and cancels a scheduled retry', async () => {
    const harness = createHarness();
    harness.coordinator.observeHeight(5);
    await settle();
    const retry = harness.activeRetries()[0];

    harness.coordinator.reset();
    await harness.coordinator.continue();
    expect(retry?.cancelled).toBe(true);
    expect(harness.refreshCalls()).toBe(1);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('destroy cancels retries and suppresses in-flight continuation', async () => {
    const pending = deferred();
    const harness = createHarness({ refresh: async () => { await pending.promise; } });
    harness.coordinator.observeHeight(5);
    await settle();

    harness.coordinator.destroy();
    pending.resolve();
    await settle();
    harness.coordinator.observeHeight(8);
    await harness.coordinator.continue();
    expect(harness.refreshCalls()).toBe(1);
    expect(harness.activeRetries()).toHaveLength(0);
  });

  test('keeps Svelte stores and timers outside the coordinator boundary', () => {
    const boundary = readFileSync(
      'frontend/packages/runtime-client/src/runtime-view-catchup.ts',
      'utf8',
    );
    const store = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/core');
    expect(boundary).not.toContain('runtimeAdapterHeight');
    expect(boundary).not.toContain('setTimeout');
    expect(store).toContain('new RuntimeViewCatchupCoordinator({');
    expect(store).toContain('runtimeViewCatchup.observeHeight(nextHeight);');
    expect(store).toContain('runtimeViewCatchup.reset();');
    expect(store).not.toContain('let pendingHeightRefresh');
    expect(store).not.toContain('let heightRefreshRetryTimer');
  });
});
