import { get, writable } from 'svelte/store';
import type { RuntimeAdapterGraphFrame } from '@xln/runtime/xln-api';
import type { Runtime } from '$lib/stores/runtimeStore';
import {
  invalidateNetworkGraphSubscription,
  pruneNetworkGraphReaders,
  readRemoteRuntimeGraphFrame,
  subscribeNetworkRuntimeChanges,
  type NetworkRuntimeChangeSubscription,
} from './networkTimelineLoader';

export const runtimeGraphLiveFrameCache = writable<Map<string, RuntimeAdapterGraphFrame>>(new Map());

const DEFAULT_GRAPH_ATTACH_TIMEOUT_MS = 6_500;
const DEFAULT_GRAPH_READ_TIMEOUT_MS = 16_000;
let refreshSequence = 0;

type RuntimeGraphFrameReader = (runtime: Runtime) => Promise<RuntimeAdapterGraphFrame>;
type RuntimeGraphChangeSubscriber = (
  runtimeMap: Map<string, Runtime>,
  onChange: (runtimeId: string, height: number) => void,
  onError: (runtimeId: string, error: unknown) => void,
  onGeneration: (generation: number) => void,
  signal?: AbortSignal,
) => Promise<NetworkRuntimeChangeSubscription>;

type RuntimeGraphFrameWatchOptions = {
  readFrame?: RuntimeGraphFrameReader;
  subscribeChanges?: RuntimeGraphChangeSubscriber;
  invalidateSubscription?: () => void;
  retryDelayMs?: number;
  attachTimeoutMs?: number;
  readTimeoutMs?: number;
  onApplied?: () => void;
  onError: (error: unknown) => void;
};

type BoundedOperationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  timeoutError: () => Error;
  onTimeout?: () => void;
};

const sortedGraphFrames = (
  entries: Array<[string, RuntimeAdapterGraphFrame]>,
): Map<string, RuntimeAdapterGraphFrame> => new Map(entries.sort(([left], [right]) => left.localeCompare(right)));

const boundedOperation = <T>(promise: Promise<T>, options: BoundedOperationOptions): Promise<T> => {
  if (options.timeoutMs === undefined && !options.signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort = (): void => {};
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    abort = () => finish({ error: new Error('NETWORK_GRAPH_OPERATION_ABORTED') });
    timer = options.timeoutMs === undefined ? null : setTimeout(() => {
      options.onTimeout?.();
      finish({ error: options.timeoutError() });
    }, Math.max(1, Math.floor(options.timeoutMs)));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    void promise.then((value) => finish({ value }), (error) => finish({ error }));
  });
};

type RuntimeGraphRefreshOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const refreshRuntimeGraphFrameCache = async (
  runtimeMap: Map<string, Runtime>,
  readFrame: RuntimeGraphFrameReader = readRemoteRuntimeGraphFrame,
  options: RuntimeGraphRefreshOptions = {},
): Promise<'applied' | 'stale'> => {
  const sequence = ++refreshSequence;
  pruneNetworkGraphReaders(runtimeMap);
  const remoteRuntimes = Array.from(runtimeMap.values())
    .filter((runtime) => runtime.type === 'remote')
    .sort((left, right) => left.id.trim().toLowerCase().localeCompare(right.id.trim().toLowerCase()));
  const allowedRuntimeIds = new Set(remoteRuntimes.map((runtime) => runtime.id.trim().toLowerCase()));
  runtimeGraphLiveFrameCache.update((current) => sortedGraphFrames(
    Array.from(current).filter(([id]) => allowedRuntimeIds.has(id)),
  ));
  const results = await Promise.allSettled(remoteRuntimes.map(async (runtime) => {
    const id = runtime.id.trim().toLowerCase();
    const frame = await boundedOperation(readFrame(runtime), {
      ...options,
      timeoutError: () => new Error(`REMOTE_GRAPH_READ_TIMEOUT:${id}:${options.timeoutMs}`),
    });
    if (sequence === refreshSequence) {
      runtimeGraphLiveFrameCache.update((current) => {
        const entries = Array.from(current)
          .filter(([entryId]) => allowedRuntimeIds.has(entryId) && entryId !== id);
        entries.push([id, frame]);
        return sortedGraphFrames(entries);
      });
    }
    return frame;
  }));
  if (sequence !== refreshSequence) return 'stale';
  const failures: string[] = [];
  results.forEach((result, index) => {
    const id = remoteRuntimes[index]!.id.trim().toLowerCase();
    if (result.status === 'rejected') {
      failures.push(`${id}:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  if (failures.length > 0) throw new Error(`REMOTE_GRAPH_REFRESH_PARTIAL:${failures.join('|')}`);
  return 'applied';
};

export const watchRuntimeGraphFrameCache = (
  runtimeMap: Map<string, Runtime>,
  options: RuntimeGraphFrameWatchOptions,
): (() => void) => {
  const subscribeChanges = options.subscribeChanges ?? subscribeNetworkRuntimeChanges;
  const invalidateSubscription = options.invalidateSubscription ?? invalidateNetworkGraphSubscription;
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 1_000));
  const attachTimeoutMs = Math.max(1, Math.floor(options.attachTimeoutMs ?? DEFAULT_GRAPH_ATTACH_TIMEOUT_MS));
  const readTimeoutMs = Math.max(1, Math.floor(options.readTimeoutMs ?? DEFAULT_GRAPH_READ_TIMEOUT_MS));
  const watcherController = new AbortController();
  let stopped = false;
  let pending = false;
  let running = false;
  let attaching = false;
  let attachAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attachController: AbortController | null = null;
  let activeGeneration: number | undefined;
  let unsubscribe = (): void => {};

  const readFrame: RuntimeGraphFrameReader = options.readFrame ?? ((runtime) =>
    readRemoteRuntimeGraphFrame(runtime, undefined, activeGeneration));

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attach();
    }, retryDelayMs);
  };

  const drain = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try {
          const result = await refreshRuntimeGraphFrameCache(runtimeMap, readFrame, {
            timeoutMs: readTimeoutMs,
            signal: watcherController.signal,
          });
          if (result === 'applied') options.onApplied?.();
        } catch (error) {
          if (!stopped) {
            options.onError(error);
            scheduleRetry();
          }
        }
      }
    } finally {
      running = false;
      if (pending && !stopped) void drain();
    }
  };
  const requestRefresh = (): void => {
    if (stopped) return;
    pending = true;
    void drain();
  };

  const attach = async (): Promise<void> => {
    if (stopped) return;
    if (attaching) {
      attachAgain = true;
      return;
    }
    attaching = true;
    const currentAttachController = new AbortController();
    attachController = currentAttachController;
    try {
      const subscriptionPromise = subscribeChanges(
        runtimeMap,
        requestRefresh,
        (_runtimeId, error) => {
          if (stopped) return;
          options.onError(error);
          scheduleRetry();
        },
        (generation) => {
          if (stopped) return;
          activeGeneration = generation;
          refreshSequence += 1;
        },
        currentAttachController.signal,
      );
      void subscriptionPromise.then((subscription) => {
        if (stopped || currentAttachController.signal.aborted) subscription.unsubscribe();
      }, () => {});
      const subscription = await boundedOperation(subscriptionPromise, {
        timeoutMs: attachTimeoutMs,
        signal: watcherController.signal,
        timeoutError: () => new Error(`NETWORK_GRAPH_SUBSCRIPTION_TIMEOUT:${attachTimeoutMs}`),
        onTimeout: () => currentAttachController.abort(),
      });
      if (stopped) {
        subscription.unsubscribe();
        return;
      }
      unsubscribe();
      unsubscribe = subscription.unsubscribe;
      activeGeneration = subscription.generation;
      refreshSequence += 1;
      requestRefresh();
      if (subscription.failedRuntimeIds.length > 0) scheduleRetry();
    } catch (error) {
      if (!stopped) {
        options.onError(error);
        scheduleRetry();
      }
    } finally {
      if (attachController === currentAttachController) attachController = null;
      attaching = false;
      if (attachAgain && !stopped) {
        attachAgain = false;
        void attach();
      }
    }
  };

  void attach();
  queueMicrotask(() => {
    if (!stopped && !pending && !running) requestRefresh();
  });
  return () => {
    if (stopped) return;
    stopped = true;
    pending = false;
    refreshSequence += 1;
    watcherController.abort();
    attachController?.abort();
    invalidateSubscription();
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
  };
};

export const clearRuntimeGraphFrameCache = (runtimeId?: string): void => {
  refreshSequence += 1;
  const normalized = String(runtimeId || '').trim().toLowerCase();
  if (!normalized) {
    runtimeGraphLiveFrameCache.set(new Map());
    return;
  }
  const current = get(runtimeGraphLiveFrameCache);
  if (!current.has(normalized)) return;
  const next = new Map(current);
  next.delete(normalized);
  runtimeGraphLiveFrameCache.set(next);
};
