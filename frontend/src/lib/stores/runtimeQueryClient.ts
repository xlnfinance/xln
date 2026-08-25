import { get, writable } from 'svelte/store';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeAdapter,
  RuntimeAdapterActivityPage,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterFrameSummary,
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSolvencySummary,
  RuntimeAdapterTimelineIndexPage,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';
import type { StorageAccountDoc, StorageHead } from '@xln/core/storage/types';
import {
  getRuntimeControllerAdapter,
  runtimeAdapter,
  runtimeAdapterHeight,
  runtimeControllerHandle,
} from './runtimeControllerStore';
import { registerDebugSurface } from '$lib/utils/runtime/debugSurface';
import {
  RuntimeQueryClient as RuntimeQueryClientBoundary,
  clearRuntimeQueryCache,
} from '../../../packages/runtime-client/src/runtime-query-client';

export { clearRuntimeQueryCache };

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

type XlnRuntimeQueryResults = {
  head: StorageHead;
  frameSummary: RuntimeAdapterFrameSummary;
  entities: RuntimeAdapterEntitySummary[];
  viewFrame: RuntimeAdapterViewFrame;
  account: StorageAccountDoc;
  swapHistory: unknown;
  historyFrameBatch: RuntimeAdapterHistoryFrameBatch;
  timelineIndex: RuntimeAdapterTimelineIndexPage;
  activity: RuntimeAdapterActivityPage;
  solvencySummary: RuntimeAdapterSolvencySummary;
  checkpoints: Array<{ height?: number }>;
  receiptStatus: RuntimeReceiptStatus;
  recoveryBundles: RuntimePeerRecoveryBundleResponse;
};

export class RuntimeQueryClient extends RuntimeQueryClientBoundary<
  RuntimeAdapterReadQuery,
  XlnRuntimeQueryResults
> {
  constructor(
    resolveAdapter: () => RuntimeAdapter | null = getRuntimeControllerAdapter,
    cacheRuntimeId?: string,
  ) {
    super({
      resolveAdapter,
      readRuntimeId: () => get(runtimeControllerHandle).id,
      readCurrentHeight: () => get(runtimeAdapterHeight),
      createEmptyQuery: () => ({}),
    }, cacheRuntimeId);
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Runtime query failed');

export const runtimeQueryClient = new RuntimeQueryClient();

runtimeAdapter.subscribe(() => clearRuntimeQueryCache());

const exposeRuntimeAdapterDebugSurface = (): void => {
  registerDebugSurface('adapter', () => ({
    query: {
      head: async () => runtimeQueryClient.readHead(),
      frame: async (height: number) => runtimeQueryClient.readFrameSummary(height),
      entities: async (query?: RuntimeAdapterReadQuery) => runtimeQueryClient.readEntities(query),
      viewFrame: async (query: RuntimeAdapterReadQuery = {}) => runtimeQueryClient.readViewFrame(query),
      historyFrameBatch: async (query: RuntimeAdapterReadQuery) => runtimeQueryClient.readHistoryFrameBatch(query),
      timelineIndex: async (query: RuntimeAdapterReadQuery = {}) => runtimeQueryClient.readTimelineIndex(query),
      activity: async (query: RuntimeAdapterReadQuery) => runtimeQueryClient.readActivity(query),
      solvencySummary: async (query: RuntimeAdapterReadQuery = {}) => runtimeQueryClient.readSolvencySummary(query),
      checkpoints: async () => runtimeQueryClient.readCheckpoints(),
      receiptStatus: async (receiptId: string) => runtimeQueryClient.readReceiptStatus(receiptId),
    },
    status: () => {
      const adapter = getRuntimeControllerAdapter();
      const handle = get(runtimeControllerHandle);
      return {
        connected: adapter?.status === 'connected',
        height: Math.max(0, Math.floor(Number(adapter?.currentHeight || 0))),
        authLevel: adapter?.authLevel ?? null,
        runtimeId: handle.runtimeId,
        mode: handle.mode,
        endpoint: handle.endpoint,
        permissions: handle.permissions,
        commandReady: handle.commandReady,
        commandReadyReason: handle.commandReadyReason,
      };
    },
  }));
};

exposeRuntimeAdapterDebugSurface();

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
