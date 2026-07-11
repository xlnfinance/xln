import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { RuntimeAdapterGraphFrame } from '@xln/runtime/xln-api';
import {
  clearRuntimeGraphFrameCache,
  refreshRuntimeGraphFrameCache,
  runtimeGraphLiveFrameCache,
  watchRuntimeGraphFrameCache,
} from '../../frontend/src/lib/network3d/runtimeGraphFrameCache';
import type { Runtime } from '../../frontend/src/lib/stores/runtimeStore';

const remoteRuntime = (id: string): Runtime => ({
  id,
  type: 'remote',
  label: id,
  env: null,
  wsUrl: `ws://${id}`,
  apiKey: 'test-token',
  permissions: 'read',
  status: 'connected',
});

const graphFrame = (height: number, runtimeId = 'remote-a'): RuntimeAdapterGraphFrame => ({
  head: { latestHeight: height } as RuntimeAdapterGraphFrame['head'],
  runtimeId,
  height,
  timestamp: height * 100,
  stateHash: `state-${height}`,
  entities: [],
});

const readCache = (): Map<string, RuntimeAdapterGraphFrame> => {
  let current = new Map<string, RuntimeAdapterGraphFrame>();
  const unsubscribe = runtimeGraphLiveFrameCache.subscribe((value) => {
    current = value;
  });
  unsubscribe();
  return current;
};

describe('RuntimeGraphFrameCache', () => {
  test('timeline disposal cannot disconnect the graph live-reader pool', () => {
    const source = readFileSync(
      new URL('../../frontend/src/lib/network3d/networkTimelineLoader.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const timelineRemoteReaders = new RemoteRuntimeReaderPool();');
    expect(source).toContain('const graphRemoteReaders = new RemoteRuntimeReaderPool();');
    expect(source).toContain('disconnectNetworkTimelineReaders = (): void => timelineRemoteReaders.disconnectAll()');
    expect(source).not.toContain('disconnectNetworkTimelineReaders = (): void => graphRemoteReaders.disconnectAll()');
    expect(source).toContain('readRemoteRuntimeGraphFrameWithPool(runtime, timelineRemoteReaders, targetHeight)');
  });

  test('a stale failed refresh cannot overwrite or clear the latest applied frame', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([['remote-a', remoteRuntime('remote-a')]]);
    let rejectFirst: (error: Error) => void = () => {};
    const first = refreshRuntimeGraphFrameCache(runtimeMap, () => new Promise((_, reject) => {
      rejectFirst = reject;
    }));
    const second = refreshRuntimeGraphFrameCache(runtimeMap, async () => graphFrame(2));

    expect(await second).toBe('applied');
    rejectFirst(new Error('stale transport failure'));
    expect(await first).toBe('stale');
    expect(readCache().get('remote-a')?.height).toBe(2);
  });

  test('clearing the cache invalidates an in-flight refresh', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([['remote-a', remoteRuntime('remote-a')]]);
    let resolveRead: (frame: RuntimeAdapterGraphFrame) => void = () => {};
    const refresh = refreshRuntimeGraphFrameCache(runtimeMap, () => new Promise((resolve) => {
      resolveRead = resolve;
    }));

    clearRuntimeGraphFrameCache();
    resolveRead(graphFrame(3));
    expect(await refresh).toBe('stale');
    expect(readCache().size).toBe(0);
  });

  test('an inactive remote tick refreshes every merged frame while the active remote stays idle', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([
      ['remote-a', remoteRuntime('remote-a')],
      ['remote-b', remoteRuntime('remote-b')],
    ]);
    const heights = new Map([['remote-a', 1], ['remote-b', 1]]);
    let emitChange: (runtimeId: string, height: number) => void = () => {};
    let unsubscribed = false;
    let appliedCount = 0;
    let resolveInitial: () => void = () => {};
    let resolveTick: () => void = () => {};
    const initialApplied = new Promise<void>((resolve) => { resolveInitial = resolve; });
    const tickApplied = new Promise<void>((resolve) => { resolveTick = resolve; });
    const stop = watchRuntimeGraphFrameCache(runtimeMap, {
      readFrame: async (runtime) => graphFrame(heights.get(runtime.id) ?? 0, runtime.id),
      subscribeChanges: async (_runtimes, onChange) => {
        emitChange = onChange;
        return {
          generation: 1,
          failedRuntimeIds: [],
          unsubscribe: () => { unsubscribed = true; },
        };
      },
      invalidateSubscription: () => {},
      onApplied: () => {
        appliedCount += 1;
        if (appliedCount === 1) resolveInitial();
        if (appliedCount === 2) resolveTick();
      },
      onError: (error) => { throw error; },
    });
    await initialApplied;
    expect(readCache().get('remote-a')?.height).toBe(1);
    expect(readCache().get('remote-b')?.height).toBe(1);

    heights.set('remote-b', 2);
    emitChange('remote-b', 2);
    await tickApplied;
    expect(readCache().get('remote-a')?.height).toBe(1);
    expect(readCache().get('remote-b')?.height).toBe(2);

    stop();
    expect(unsubscribed).toBe(true);
  });

  test('stopping a watcher before subscription resolves prevents its removed runtime from reappearing', async () => {
    clearRuntimeGraphFrameCache();
    const oldMap = new Map([
      ['remote-a', remoteRuntime('remote-a')],
      ['remote-b', remoteRuntime('remote-b')],
    ]);
    const newMap = new Map([['remote-a', remoteRuntime('remote-a')]]);
    let resolveOldSubscription: (value: {
      generation: number;
      failedRuntimeIds: string[];
      unsubscribe: () => void;
    }) => void = () => {};
    let oldReadCount = 0;
    let oldUnsubscribed = false;
    const stopOld = watchRuntimeGraphFrameCache(oldMap, {
      readFrame: async (runtime) => {
        oldReadCount += 1;
        return graphFrame(9, runtime.id);
      },
      subscribeChanges: async () => new Promise((resolve) => { resolveOldSubscription = resolve; }),
      invalidateSubscription: () => {},
      onError: (error) => { throw error; },
    });
    stopOld();

    let resolveNewApplied: () => void = () => {};
    const newApplied = new Promise<void>((resolve) => { resolveNewApplied = resolve; });
    const stopNew = watchRuntimeGraphFrameCache(newMap, {
      readFrame: async (runtime) => graphFrame(2, runtime.id),
      subscribeChanges: async () => ({ generation: 2, failedRuntimeIds: [], unsubscribe: () => {} }),
      invalidateSubscription: () => {},
      onApplied: resolveNewApplied,
      onError: (error) => { throw error; },
    });
    await newApplied;
    resolveOldSubscription({
      generation: 1,
      failedRuntimeIds: [],
      unsubscribe: () => { oldUnsubscribed = true; },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(oldReadCount).toBe(0);
    expect(oldUnsubscribed).toBe(true);
    expect(readCache().get('remote-a')?.height).toBe(2);
    expect(readCache().has('remote-b')).toBe(false);
    stopNew();
  });

  test('a failed remote recovers without a runtimes-map mutation while healthy frames stay visible', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([
      ['remote-a', remoteRuntime('remote-a')],
      ['remote-b', remoteRuntime('remote-b')],
    ]);
    let subscriptionAttempt = 0;
    let bOnline = false;
    let resolvePartial: () => void = () => {};
    let resolveRecovered: () => void = () => {};
    const partialApplied = new Promise<void>((resolve) => { resolvePartial = resolve; });
    const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
    const stop = watchRuntimeGraphFrameCache(runtimeMap, {
      readFrame: async (runtime) => {
        if (runtime.id === 'remote-b' && !bOnline) throw new Error('remote-b offline');
        return graphFrame(runtime.id === 'remote-b' ? 2 : 1, runtime.id);
      },
      subscribeChanges: async () => {
        subscriptionAttempt += 1;
        return {
          generation: subscriptionAttempt,
          failedRuntimeIds: subscriptionAttempt === 1 ? ['remote-b'] : [],
          unsubscribe: () => {},
        };
      },
      invalidateSubscription: () => {},
      retryDelayMs: 2,
      onApplied: resolveRecovered,
      onError: () => resolvePartial(),
    });
    await partialApplied;
    expect(readCache().get('remote-a')?.height).toBe(1);
    expect(readCache().has('remote-b')).toBe(false);

    bOnline = true;
    await recovered;
    expect(subscriptionAttempt).toBeGreaterThanOrEqual(2);
    expect(readCache().get('remote-a')?.height).toBe(1);
    expect(readCache().get('remote-b')?.height).toBe(2);
    stop();
  });

  test('healthy remote ticks keep advancing while another subscription attempt is still offline', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([
      ['remote-a', remoteRuntime('remote-a')],
      ['remote-b', remoteRuntime('remote-b')],
    ]);
    let aHeight = 1;
    let emitChange: (runtimeId: string, height: number) => void = () => {};
    let resolveSubscription: (value: {
      generation: number;
      failedRuntimeIds: string[];
      unsubscribe: () => void;
    }) => void = () => {};
    let errorCount = 0;
    let resolveFirstError: () => void = () => {};
    let resolveSecondError: () => void = () => {};
    const firstError = new Promise<void>((resolve) => { resolveFirstError = resolve; });
    const secondError = new Promise<void>((resolve) => { resolveSecondError = resolve; });
    const stop = watchRuntimeGraphFrameCache(runtimeMap, {
      readFrame: async (runtime) => {
        if (runtime.id === 'remote-b') throw new Error('remote-b offline');
        return graphFrame(aHeight, runtime.id);
      },
      subscribeChanges: async (_runtimes, onChange, _onError, onGeneration) => {
        emitChange = onChange;
        onGeneration(7);
        return new Promise((resolve) => { resolveSubscription = resolve; });
      },
      invalidateSubscription: () => {},
      retryDelayMs: 10_000,
      onError: () => {
        errorCount += 1;
        if (errorCount === 1) resolveFirstError();
        if (errorCount === 2) resolveSecondError();
      },
    });

    emitChange('remote-a', 1);
    await firstError;
    expect(readCache().get('remote-a')?.height).toBe(1);
    aHeight = 2;
    emitChange('remote-a', 2);
    await secondError;
    expect(readCache().get('remote-a')?.height).toBe(2);
    expect(readCache().has('remote-b')).toBe(false);

    stop();
    resolveSubscription({ generation: 7, failedRuntimeIds: ['remote-b'], unsubscribe: () => {} });
  });

  test('a never-resolving remote attach cannot block the healthy initial cache and stop cancels it', async () => {
    clearRuntimeGraphFrameCache();
    const runtimeMap = new Map([
      ['remote-a', remoteRuntime('remote-a')],
      ['remote-b', remoteRuntime('remote-b')],
    ]);
    let invalidated = false;
    let attachSignal: AbortSignal | undefined;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let resolveHealthy: () => void = () => {};
    const healthyVisible = new Promise<void>((resolve) => { resolveHealthy = resolve; });
    const stop = watchRuntimeGraphFrameCache(runtimeMap, {
      readFrame: async (runtime) => {
        if (runtime.id === 'remote-b') return new Promise(() => {});
        return graphFrame(4, runtime.id);
      },
      subscribeChanges: async (_runtimes, _onChange, _onError, _onGeneration, signal) => {
        attachSignal = signal;
        return new Promise(() => {});
      },
      invalidateSubscription: () => { invalidated = true; },
      attachTimeoutMs: 1_000,
      readTimeoutMs: 10,
      onApplied: resolveHealthy,
      onError: () => {
        if (readCache().get('remote-a')?.height === 4) resolveHealthy();
      },
    });

    try {
      await Promise.race([
        healthyVisible,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('healthy cache was blocked by stale attach')), 100);
        }),
      ]);
      expect(readCache().get('remote-a')?.height).toBe(4);
      expect(attachSignal?.aborted).toBe(false);
    } finally {
      if (deadline) clearTimeout(deadline);
      stop();
    }
    expect(invalidated).toBe(true);
    expect(attachSignal?.aborted).toBe(true);
  });
});
