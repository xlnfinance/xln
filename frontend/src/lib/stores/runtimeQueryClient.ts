import { get, writable } from 'svelte/store';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeAdapter,
  RuntimeAdapterActivityPage,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSolvencySummary,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';
import type { StorageHead } from '@xln/runtime/storage/types';
import {
  getRuntimeControllerAdapter,
  runtimeAdapter,
  runtimeAdapterHeight,
  runtimeControllerHandle,
} from './runtimeControllerStore';

type RuntimeQueryCacheEntry<T> = {
  height: number;
  data: T;
};

type RuntimeReadState<T> = {
  loading: boolean;
  data: T | null;
  error: string | null;
  height: number;
};

export type RuntimeReceiptStatus = {
  status?: string | null;
  enqueuedHeight?: number | null;
  observedHeight?: number | null;
  note?: string | null;
};

export type RuntimePeerRecoveryBundleResponse = {
  ok: true;
  runtimeId: string;
  lookupKey: string;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  bundles?: EncryptedRuntimeRecoveryBundleV1[];
};

const MAX_QUERY_CACHE_ENTRIES = 200;
const queryCache = new Map<string, RuntimeQueryCacheEntry<unknown>>();

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'Runtime query failed');

const normalizeHeight = (height: unknown): number => {
  const normalized = Math.floor(Number(height || 0));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
};

const stableQueryValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableQueryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableQueryValue(entryValue)]),
    );
  }
  return value;
};

const cacheKey = (runtimeId: string, path: string, query?: RuntimeAdapterReadQuery): string =>
  `${runtimeId}|${path}|${JSON.stringify(stableQueryValue(query ?? {}))}`;

const trimQueryCache = (): void => {
  while (queryCache.size > MAX_QUERY_CACHE_ENTRIES) {
    const first = queryCache.keys().next().value;
    if (!first) return;
    queryCache.delete(first);
  }
};

export const clearRuntimeQueryCache = (): void => {
  queryCache.clear();
};

export const runtimeQueryCacheSize = (): number => queryCache.size;

export class RuntimeQueryClient {
  constructor(
    private readonly resolveAdapter: () => RuntimeAdapter | null = getRuntimeControllerAdapter,
    private readonly cacheRuntimeId?: string,
  ) {}

  private async read<T>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    const adapter = this.resolveAdapter();
    if (!adapter) throw new Error('Runtime adapter is not connected');
    return adapter.read<T>(path, query);
  }

  private async cachedRead<T>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    const adapter = this.resolveAdapter();
    if (!adapter) throw new Error('Runtime adapter is not connected');
    const handle = get(runtimeControllerHandle);
    const requestHeight = normalizeHeight(query?.atHeight ?? adapter.currentHeight ?? get(runtimeAdapterHeight));
    const key = cacheKey(this.cacheRuntimeId || handle.id, path, query);
    const cached = queryCache.get(key) as RuntimeQueryCacheEntry<T> | undefined;
    if (cached && cached.height === requestHeight) return cached.data;
    const data = await adapter.read<T>(path, query);
    queryCache.set(key, { height: requestHeight, data });
    trimQueryCache();
    return data;
  }

  readHead(): Promise<StorageHead> {
    return this.cachedRead<StorageHead>('head');
  }

  readEntities(query?: RuntimeAdapterReadQuery): Promise<RuntimeAdapterEntitySummary[]> {
    return this.cachedRead<RuntimeAdapterEntitySummary[]>('entities', query);
  }

  readViewFrame(query: RuntimeAdapterReadQuery = {}): Promise<RuntimeAdapterViewFrame> {
    return this.cachedRead<RuntimeAdapterViewFrame>('view-frame', query);
  }

  readHistoryFrameBatch(query: RuntimeAdapterReadQuery): Promise<RuntimeAdapterHistoryFrameBatch> {
    if (!query.heights) throw new Error('history-frame-batch requires heights');
    return this.cachedRead<RuntimeAdapterHistoryFrameBatch>('history-frame-batch', query);
  }

  readActivity(query: RuntimeAdapterReadQuery): Promise<RuntimeAdapterActivityPage> {
    return this.cachedRead<RuntimeAdapterActivityPage>('activity', query);
  }

  readSolvencySummary(query: RuntimeAdapterReadQuery = {}): Promise<RuntimeAdapterSolvencySummary> {
    return this.cachedRead<RuntimeAdapterSolvencySummary>('solvency-summary', query);
  }

  readCheckpoints(): Promise<Array<{ height?: number }>> {
    return this.cachedRead<Array<{ height?: number }>>('checkpoints');
  }

  async readReceiptStatus(receiptId: string): Promise<RuntimeReceiptStatus> {
    const id = String(receiptId || '').trim();
    if (!id) throw new Error('REMOTE_RUNTIME_RECEIPT_ID_MISSING');
    return this.read<RuntimeReceiptStatus>(`receipt/${encodeURIComponent(id)}`);
  }

  async readRecoveryBundles(lookupKey: string): Promise<RuntimePeerRecoveryBundleResponse> {
    const key = String(lookupKey || '').trim();
    if (!key) throw new Error('REMOTE_RUNTIME_RECOVERY_LOOKUP_KEY_MISSING');
    return this.read<RuntimePeerRecoveryBundleResponse>(`recovery/bundles/${encodeURIComponent(key)}`);
  }
}

export const runtimeQueryClient = new RuntimeQueryClient();

runtimeAdapter.subscribe(() => clearRuntimeQueryCache());

export const createRuntimeQueryStore = <T>(
  reader: (client: RuntimeQueryClient) => Promise<T>,
) => {
  const store = writable<RuntimeReadState<T>>({
    loading: true,
    data: null,
    error: null,
    height: get(runtimeAdapterHeight),
  });
  let disposed = false;
  let version = 0;
  const refresh = async (): Promise<void> => {
    const currentVersion = ++version;
    store.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const data = await reader(runtimeQueryClient);
      if (disposed || currentVersion !== version) return;
      store.set({ loading: false, data, error: null, height: get(runtimeAdapterHeight) });
    } catch (error) {
      if (disposed || currentVersion !== version) return;
      store.set({ loading: false, data: null, error: errorMessage(error), height: get(runtimeAdapterHeight) });
    }
  };
  const unsubscribeHeight = runtimeAdapterHeight.subscribe(() => void refresh());
  const unsubscribeAdapter = runtimeAdapter.subscribe(() => void refresh());
  void refresh();
  return {
    subscribe: store.subscribe,
    refresh,
    destroy: () => {
      disposed = true;
      unsubscribeHeight();
      unsubscribeAdapter();
    },
  };
};
