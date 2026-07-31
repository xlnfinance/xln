import type {
  RuntimeAdapter,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterTimelineIndexPage,
  RuntimeActivityEvent,
} from '@xln/runtime/xln-api';
import { RemoteRuntimeAdapter } from '../../../../runtime/radapter/remote';
import type { Runtime } from '$lib/stores/runtimeStore';
import { getRuntimeControllerAdapter } from '$lib/stores/runtimeControllerStore';
import {
  adapterNetworkTimelineSource,
  type NetworkTimelineSource,
} from './networkTimelineSource';
import {
  normalizeRuntimeTimelineIndex,
  type RuntimeTimelineIndex,
} from './runtimeGraphTimeline';

const PAGE_SIZE = 250;
const PAGE_SCAN_LIMIT = 2_000;
const REMOTE_CONNECT_TIMEOUT_MS = 6_000;

const runtimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

/**
 * Reader for one runtime, local or remote.
 *
 * A local runtime is NOT a special case: its embedded adapter serves the same read paths
 * (timeline-index / graph-frame / activity) from persisted storage. Reading `env.history`
 * instead — as this module used to — always yielded zero frames, because the runtime keeps
 * no in-memory history by design (RECENT_RUNTIME_HISTORY_LIMIT = 0).
 *
 * Returns null when no reader exists for a local runtime (it is not the connected one).
 * That is a genuine "we have no source" state, not a swallowed failure: read errors from an
 * adapter we do have still propagate.
 */
export const networkTimelineSourceFor = async (runtime: Runtime): Promise<NetworkTimelineSource | null> => {
  const id = runtimeId(runtime.id);
  if (!id) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  if (runtime.type !== 'local') {
    return adapterNetworkTimelineSource(id, await timelineRemoteReaders.adapterFor(runtime));
  }
  const adapter = getRuntimeControllerAdapter();
  if (!adapter || runtimeId(adapter.runtimeId) !== id) return null;
  return adapterNetworkTimelineSource(id, adapter);
};

export const readTimelineIndexPages = async (
  adapter: Pick<RuntimeAdapter, 'read'>,
  expectedRuntimeId: string,
): Promise<RuntimeTimelineIndex> => {
  const expected = runtimeId(expectedRuntimeId);
  const entries: RuntimeAdapterTimelineIndexPage['entries'] = [];
  let beforeHeight: number | undefined;
  while (true) {
    const page = await adapter.read<RuntimeAdapterTimelineIndexPage>('timeline-index', {
      limit: PAGE_SIZE,
      scanLimit: PAGE_SCAN_LIMIT,
      ...(beforeHeight === undefined ? {} : { beforeHeight }),
    });
    const actual = runtimeId(page.runtimeId);
    if (actual !== expected) throw new Error(`NETWORK_TIMELINE_RUNTIME_ID_MISMATCH:${expected}:${actual}`);
    entries.push(...page.entries);
    if (page.nextBeforeHeight === null) break;
    const next = Math.floor(Number(page.nextBeforeHeight));
    if (!Number.isFinite(next) || next < 2 || (beforeHeight !== undefined && next >= beforeHeight)) {
      throw new Error(`NETWORK_TIMELINE_CURSOR_INVALID:${expected}:${page.nextBeforeHeight}`);
    }
    beforeHeight = next;
  }
  return normalizeRuntimeTimelineIndex({ runtimeId: expected, frames: entries });
};

type PoolEntry = {
  signature: string;
  adapter: RemoteRuntimeAdapter;
};

type PendingPoolEntry = PoolEntry & {
  promise: Promise<RemoteRuntimeAdapter>;
  cancel: (error: Error) => void;
};

class RemoteRuntimeReaderPool {
  private entries = new Map<string, PoolEntry>();
  private pending = new Map<string, PendingPoolEntry>();
  private subscriptionGeneration = 0;

  async adapterFor(runtime: Runtime, expectedSubscription?: number): Promise<RuntimeAdapter> {
    if (runtime.type !== 'remote' || !runtime.wsUrl || !runtime.apiKey) {
      throw new Error(`NETWORK_TIMELINE_REMOTE_CONFIG_INCOMPLETE:${runtime.id}`);
    }
    const id = runtimeId(runtime.id);
    if (expectedSubscription !== undefined && expectedSubscription !== this.subscriptionGeneration) {
      throw new Error('NETWORK_GRAPH_SUBSCRIPTION_SUPERSEDED');
    }
    const signature = `${runtime.wsUrl}|${runtime.apiKey}`;
    const cached = this.entries.get(id);
    if (cached?.signature === signature && cached.adapter.status === 'connected') return cached.adapter;
    cached?.adapter.disconnect();
    const inFlight = this.pending.get(id);
    if (inFlight && inFlight.signature !== signature) {
      inFlight.cancel(new Error(`NETWORK_TIMELINE_REMOTE_CONFIG_CHANGED:${id}`));
    }
    const adapter = await (
      this.pending.get(id) ?? this.connect(id, signature, runtime.wsUrl, runtime.apiKey)
    ).promise;
    if (expectedSubscription !== undefined && expectedSubscription !== this.subscriptionGeneration) {
      throw new Error('NETWORK_GRAPH_SUBSCRIPTION_SUPERSEDED');
    }
    return adapter;
  }

  private connect(id: string, signature: string, wsUrl: string, apiKey: string): PendingPoolEntry {
    const adapter = new RemoteRuntimeAdapter();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let resolveConnection: (value: RemoteRuntimeAdapter) => void = () => {};
    let rejectConnection: (error: Error) => void = () => {};
    const promise = new Promise<RemoteRuntimeAdapter>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const finish = (error?: Error): void => {
      if (settled) {
        if (!error) adapter.disconnect();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (this.pending.get(id)?.adapter === adapter) this.pending.delete(id);
      if (error || adapter.status !== 'connected') {
        adapter.disconnect();
        rejectConnection(error ?? new Error(`NETWORK_TIMELINE_REMOTE_CONNECT_FAILED:${id}`));
        return;
      }
      this.entries.set(id, { signature, adapter });
      resolveConnection(adapter);
    };
    const entry: PendingPoolEntry = { signature, adapter, promise, cancel: finish };
    this.pending.set(id, entry);
    timer = setTimeout(
      () => finish(new Error(`NETWORK_TIMELINE_REMOTE_CONNECT_TIMEOUT:${id}:${REMOTE_CONNECT_TIMEOUT_MS}`)),
      REMOTE_CONNECT_TIMEOUT_MS,
    );
    void adapter.connect({
      mode: 'remote', runtimeId: id, wsUrl, authKey: apiKey, requestTimeoutMs: 15_000,
    }).then(() => finish(), (error) => finish(error instanceof Error ? error : new Error(String(error))));
    return entry;
  }

  private cancelPending(error: Error, allowedRuntimeIds?: Set<string>): void {
    for (const [id, entry] of this.pending) {
      if (allowedRuntimeIds?.has(id)) continue;
      entry.cancel(error);
    }
  }

  beginSubscription(allowedRuntimeIds: Set<string>): number {
    this.subscriptionGeneration += 1;
    this.cancelPending(new Error('NETWORK_GRAPH_SUBSCRIPTION_SUPERSEDED'));
    this.prune(allowedRuntimeIds);
    return this.subscriptionGeneration;
  }

  invalidateSubscription(): void {
    this.subscriptionGeneration += 1;
    this.cancelPending(new Error('NETWORK_GRAPH_SUBSCRIPTION_SUPERSEDED'));
  }

  cancelSubscription(generation: number): void {
    if (generation === this.subscriptionGeneration) this.invalidateSubscription();
  }

  isSubscriptionCurrent(generation: number): boolean {
    return generation === this.subscriptionGeneration;
  }

  prune(allowedRuntimeIds: Set<string>): void {
    this.cancelPending(new Error('NETWORK_TIMELINE_REMOTE_PRUNED'), allowedRuntimeIds);
    for (const [id, entry] of this.entries) {
      if (allowedRuntimeIds.has(id)) continue;
      entry.adapter.disconnect();
      this.entries.delete(id);
    }
  }

  disconnectAll(): void {
    this.cancelPending(new Error('NETWORK_TIMELINE_READERS_DISCONNECTED'));
    for (const entry of this.entries.values()) entry.adapter.disconnect();
    this.entries.clear();
  }
}

const timelineRemoteReaders = new RemoteRuntimeReaderPool();
const graphRemoteReaders = new RemoteRuntimeReaderPool();

export const pruneNetworkTimelineReaders = (runtimeMap: Map<string, Runtime>): void => {
  timelineRemoteReaders.prune(new Set(
    Array.from(runtimeMap.values())
      .filter((runtime) => runtime.type === 'remote')
      .map((runtime) => runtimeId(runtime.id)),
  ));
};

export const pruneNetworkGraphReaders = (runtimeMap: Map<string, Runtime>): void => {
  graphRemoteReaders.prune(new Set(
    Array.from(runtimeMap.values())
      .filter((runtime) => runtime.type === 'remote')
      .map((runtime) => runtimeId(runtime.id)),
  ));
};

export const invalidateNetworkGraphSubscription = (): void => {
  graphRemoteReaders.invalidateSubscription();
};

export type NetworkRuntimeChangeSubscription = {
  unsubscribe: () => void;
  failedRuntimeIds: string[];
  generation: number;
};

export const subscribeNetworkRuntimeChanges = async (
  runtimeMap: Map<string, Runtime>,
  onChange: (runtimeId: string, height: number) => void,
  onError: (runtimeId: string, error: unknown) => void = () => {},
  onGeneration: (generation: number) => void = () => {},
  signal?: AbortSignal,
): Promise<NetworkRuntimeChangeSubscription> => {
  const remoteRuntimes = Array.from(runtimeMap.values())
    .filter((runtime) => runtime.type === 'remote')
    .sort((left, right) => runtimeId(left.id).localeCompare(runtimeId(right.id)));
  const allowedRuntimeIds = new Set(remoteRuntimes.map((runtime) => runtimeId(runtime.id)));
  const subscriptionGeneration = graphRemoteReaders.beginSubscription(allowedRuntimeIds);
  onGeneration(subscriptionGeneration);
  const abortSubscription = (): void => graphRemoteReaders.cancelSubscription(subscriptionGeneration);
  if (signal?.aborted) abortSubscription();
  signal?.addEventListener('abort', abortSubscription, { once: true });
  const unsubscribers: Array<() => void> = [];
  const failedRuntimeIds: string[] = [];
  try {
    const attachments = await Promise.allSettled(remoteRuntimes.map(async (runtime) => {
      const id = runtimeId(runtime.id);
      const adapter = await graphRemoteReaders.adapterFor(runtime, subscriptionGeneration);
      return { id, unsubscribe: adapter.onChange((height) => onChange(id, height)) };
    }));
    if (!graphRemoteReaders.isSubscriptionCurrent(subscriptionGeneration)) {
      attachments.forEach((result) => {
        if (result.status === 'fulfilled') result.value.unsubscribe();
      });
      throw new Error('NETWORK_GRAPH_SUBSCRIPTION_SUPERSEDED');
    }
    attachments.forEach((result, index) => {
      const id = runtimeId(remoteRuntimes[index]!.id);
      if (result.status === 'fulfilled') unsubscribers.push(result.value.unsubscribe);
      else {
        failedRuntimeIds.push(id);
        onError(id, result.reason);
      }
    });
  } catch (error) {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortSubscription);
  }
  let subscribed = true;
  return {
    failedRuntimeIds,
    generation: subscriptionGeneration,
    unsubscribe: () => {
      if (!subscribed) return;
      subscribed = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
  };
};

export const loadNetworkTimelineIndexes = async (runtimeMap: Map<string, Runtime>): Promise<RuntimeTimelineIndex[]> => {
  const sorted = Array.from(runtimeMap.values()).sort((left, right) => runtimeId(left.id).localeCompare(runtimeId(right.id)));
  pruneNetworkTimelineReaders(runtimeMap);
  const indexes: RuntimeTimelineIndex[] = [];
  for (const runtime of sorted) {
    const source = await networkTimelineSourceFor(runtime);
    indexes.push(source ? await source.readIndex() : { runtimeId: runtimeId(runtime.id), frames: [] });
  }
  return indexes;
};

const readRemoteRuntimeGraphFrameWithPool = async (
  runtime: Runtime,
  readers: RemoteRuntimeReaderPool,
  height?: number,
  subscriptionGeneration?: number,
): Promise<RuntimeAdapterGraphFrame> => {
  if (runtime.type !== 'remote') throw new Error(`NETWORK_GRAPH_REMOTE_RUNTIME_REQUIRED:${runtime.id}`);
  const adapter = await readers.adapterFor(runtime, subscriptionGeneration);
  const targetHeight = height === undefined ? undefined : Math.max(1, Math.floor(Number(height || 0)));
  const frame = await adapter.read<RuntimeAdapterGraphFrame>('graph-frame', {
    ...(targetHeight === undefined ? {} : { atHeight: targetHeight }),
    limit: 500,
    accountsLimit: 500,
  });
  const expectedRuntimeId = runtimeId(runtime.id);
  const actualRuntimeId = runtimeId(frame.runtimeId);
  if (actualRuntimeId !== expectedRuntimeId) {
    throw new Error(`NETWORK_GRAPH_RUNTIME_ID_MISMATCH:${expectedRuntimeId}:${actualRuntimeId}`);
  }
  if (targetHeight !== undefined && Math.floor(Number(frame.height || 0)) !== targetHeight) {
    throw new Error(`NETWORK_TIMELINE_REMOTE_FRAME_MISMATCH:${runtime.id}:h${targetHeight}:h${frame.height}`);
  }
  return frame;
};

export const readRemoteRuntimeGraphFrame = async (
  runtime: Runtime,
  height?: number,
  subscriptionGeneration?: number,
): Promise<RuntimeAdapterGraphFrame> =>
  readRemoteRuntimeGraphFrameWithPool(runtime, graphRemoteReaders, height, subscriptionGeneration);

export const readNetworkRuntimeFrame = async (
  runtime: Runtime,
  height: number,
): Promise<RuntimeAdapterGraphFrame> => {
  const targetHeight = Math.max(1, Math.floor(Number(height || 0)));
  const source = await networkTimelineSourceFor(runtime);
  if (!source) throw new Error(`NETWORK_TIMELINE_SOURCE_UNAVAILABLE:${runtime.id}:h${targetHeight}`);
  return await source.readGraphFrame(targetHeight);
};

/** Activity events for one runtime inside a height window — the caption source. */
export const readNetworkRuntimeActivity = async (
  runtime: Runtime,
  fromHeight: number,
  toHeight: number,
): Promise<RuntimeActivityEvent[]> => {
  const source = await networkTimelineSourceFor(runtime);
  return source ? await source.readActivity(fromHeight, toHeight) : [];
};

export const disconnectNetworkTimelineReaders = (): void => timelineRemoteReaders.disconnectAll();
