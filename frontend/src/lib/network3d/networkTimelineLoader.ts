import type {
  EnvSnapshot,
  RuntimeAdapter,
  RuntimeAdapterTimelineIndexPage,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';
import { RemoteRuntimeAdapter } from '../../../../runtime/radapter/remote';
import type { Runtime } from '$lib/stores/runtimeStore';
import { getRuntimeControllerAdapter } from '$lib/stores/runtimeControllerStore';
import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import {
  normalizeRuntimeTimelineIndex,
  type RuntimeTimelineIndex,
} from './runtimeGraphTimeline';

const PAGE_SIZE = 250;
const PAGE_SCAN_LIMIT = 2_000;

const runtimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const localFrameChangedGraph = (snapshot: EnvSnapshot): boolean => {
  const input = snapshot.runtimeInput;
  if ((input.runtimeTxs?.length ?? 0) > 0 || (input.jInputs?.length ?? 0) > 0) return true;
  return (input.entityInputs ?? []).some((entry) => (entry.entityTxs?.length ?? 0) > 0);
};

export const timelineIndexFromBrowserRuntime = (runtime: Runtime): RuntimeTimelineIndex => {
  if (runtime.type !== 'local') throw new Error(`NETWORK_TIMELINE_BROWSER_RUNTIME_REQUIRED:${runtime.id}`);
  const env = unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env;
  const id = runtimeId(runtime.id || env?.runtimeId);
  if (!id) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  const frames = (env?.history ?? []).map((snapshot) => ({
    runtimeId: id,
    height: Math.max(0, Math.floor(Number(snapshot.height || 0))),
    timestamp: Math.max(0, Math.floor(Number(snapshot.timestamp || 0))),
    stateHash: String((snapshot as EnvSnapshot & { stateHash?: string }).stateHash || ''),
    materialized: true,
    graphChanged: localFrameChangedGraph(snapshot),
  }));
  return normalizeRuntimeTimelineIndex({ runtimeId: id, frames });
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

class RemoteRuntimeReaderPool {
  private entries = new Map<string, PoolEntry>();

  async adapterFor(runtime: Runtime): Promise<RuntimeAdapter> {
    if (runtime.type !== 'remote' || !runtime.wsUrl || !runtime.apiKey) {
      throw new Error(`NETWORK_TIMELINE_REMOTE_CONFIG_INCOMPLETE:${runtime.id}`);
    }
    const id = runtimeId(runtime.id);
    const active = getRuntimeControllerAdapter();
    if (active?.mode === 'remote' && active.status === 'connected' && runtimeId(active.runtimeId) === id) return active;
    const signature = `${runtime.wsUrl}|${runtime.apiKey}`;
    const cached = this.entries.get(id);
    if (cached?.signature === signature && cached.adapter.status === 'connected') return cached.adapter;
    cached?.adapter.disconnect();
    const adapter = new RemoteRuntimeAdapter();
    await adapter.connect({
      mode: 'remote',
      runtimeId: id,
      wsUrl: runtime.wsUrl,
      authKey: runtime.apiKey,
      requestTimeoutMs: 15_000,
    });
    if (adapter.status !== 'connected') {
      adapter.disconnect();
      throw new Error(`NETWORK_TIMELINE_REMOTE_CONNECT_FAILED:${id}`);
    }
    this.entries.set(id, { signature, adapter });
    return adapter;
  }

  prune(allowedRuntimeIds: Set<string>): void {
    for (const [id, entry] of this.entries) {
      if (allowedRuntimeIds.has(id)) continue;
      entry.adapter.disconnect();
      this.entries.delete(id);
    }
  }

  disconnectAll(): void {
    for (const entry of this.entries.values()) entry.adapter.disconnect();
    this.entries.clear();
  }
}

const remoteReaders = new RemoteRuntimeReaderPool();

export const loadNetworkTimelineIndexes = async (runtimeMap: Map<string, Runtime>): Promise<RuntimeTimelineIndex[]> => {
  const sorted = Array.from(runtimeMap.values()).sort((left, right) => runtimeId(left.id).localeCompare(runtimeId(right.id)));
  remoteReaders.prune(new Set(sorted.filter((runtime) => runtime.type === 'remote').map((runtime) => runtimeId(runtime.id))));
  const indexes: RuntimeTimelineIndex[] = [];
  for (const runtime of sorted) {
    if (runtime.type === 'local') indexes.push(timelineIndexFromBrowserRuntime(runtime));
    else indexes.push(await readTimelineIndexPages(await remoteReaders.adapterFor(runtime), runtime.id));
  }
  return indexes;
};

export const readNetworkRuntimeFrame = async (
  runtime: Runtime,
  height: number,
): Promise<EnvSnapshot | RuntimeAdapterViewFrame> => {
  const targetHeight = Math.max(1, Math.floor(Number(height || 0)));
  if (runtime.type === 'local') {
    const env = unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env;
    const frame = (env?.history ?? []).find((candidate) => Number(candidate.height) === targetHeight);
    if (!frame) throw new Error(`NETWORK_TIMELINE_BROWSER_FRAME_MISSING:${runtime.id}:h${targetHeight}`);
    return frame;
  }
  const adapter = await remoteReaders.adapterFor(runtime);
  const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', {
    atHeight: targetHeight,
    ...(runtime.hubEntityId ? { entityId: runtime.hubEntityId } : {}),
    accountsLimit: 100,
    booksLimit: 20,
  });
  if (Math.floor(Number(frame.height || 0)) !== targetHeight) {
    throw new Error(`NETWORK_TIMELINE_REMOTE_FRAME_MISMATCH:${runtime.id}:h${targetHeight}:h${frame.height}`);
  }
  return frame;
};

export const disconnectNetworkTimelineReaders = (): void => remoteReaders.disconnectAll();
