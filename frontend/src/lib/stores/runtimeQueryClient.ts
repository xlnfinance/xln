import { get } from 'svelte/store';
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
import { RuntimeQueryObserver } from '../../../packages/runtime-client/src/runtime-query-observer';

export { clearRuntimeQueryCache };

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
  const observer = new RuntimeQueryObserver(() => reader(runtimeQueryClient), {
    readHeight: () => get(runtimeAdapterHeight),
    subscribeHeight: (listener) => runtimeAdapterHeight.subscribe(() => listener()),
    subscribeAdapter: (listener) => runtimeAdapter.subscribe(() => listener()),
  });
  return {
    subscribe: (run: (snapshot: ReturnType<typeof observer.getSnapshot>) => void) => {
      run(observer.getSnapshot());
      return observer.subscribe(() => run(observer.getSnapshot()));
    },
    getSnapshot: observer.getSnapshot,
    refresh: observer.refresh,
    destroy: observer.destroy,
  };
};
