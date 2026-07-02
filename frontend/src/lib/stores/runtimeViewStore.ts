import { get, writable } from 'svelte/store';
import type {
  RuntimeAdapterEntitySummary,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';
import type { StorageHead } from '@xln/runtime/storage/types';
import {
  runtimeAdapter,
  runtimeAdapterHeight,
  runtimeControllerHandle,
} from './runtimeControllerStore';
import { runtimeQueryClient } from './runtimeQueryClient';

export type RuntimeView = {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  authLevel: 'inspect' | 'admin' | null;
  status: RuntimeAdapterStatus;
  height: number;
  loading: boolean;
  error: string | null;
  head: StorageHead | null;
  frame: RuntimeAdapterViewFrame | null;
  entities: RuntimeAdapterEntitySummary[];
  activeEntityId: string;
};

export type RuntimeViewHistoryScanState = {
  loading: boolean;
  error: string | null;
  requestedHeight: number | null;
  scannedHeight: number | null;
  latestHeight: number | null;
  framesCached: number;
  durationMs: number | null;
  accountsShown: number | null;
  accountsTotal: number | null;
  booksShown: number | null;
  booksTotal: number | null;
  endpoint: string;
};

export type RuntimeViewPageInfo = {
  entityId: string;
  accountsShown: number;
  accountsTotal: number;
  accountsPageIndex: number;
  accountsPageCount: number;
  accountsPrevCursor: string | null;
  accountsNextCursor: string | null;
  accountsHasMore: boolean;
  booksShown: number;
  booksTotal: number;
  booksPageIndex: number;
  booksPageCount: number;
  booksPrevCursor: string | null;
  booksNextCursor: string | null;
  booksHasMore: boolean;
};

const normalizeEntityIdForRuntimeView = (value: unknown): string => String(value || '').trim().toLowerCase();

export const emptyRuntimeViewHistoryScan = (endpoint = ''): RuntimeViewHistoryScanState => ({
  loading: false,
  error: null,
  requestedHeight: null,
  scannedHeight: null,
  latestHeight: null,
  framesCached: 0,
  durationMs: null,
  accountsShown: null,
  accountsTotal: null,
  booksShown: null,
  booksTotal: null,
  endpoint,
});

export const runtimeViewActiveEntityId = writable<string>('');
export const runtimeViewAccountsPage = writable<number>(0);
export const runtimeViewBooksPage = writable<number>(0);
export const runtimeViewPageInfo = writable<RuntimeViewPageInfo | null>(null);
export const runtimeViewHistoryScan = writable<RuntimeViewHistoryScanState>(
  emptyRuntimeViewHistoryScan(),
);

export const setRuntimeViewActiveEntityId = (entityId: string): void => {
  runtimeViewActiveEntityId.set(normalizeEntityIdForRuntimeView(entityId));
  runtimeViewAccountsPage.set(0);
  runtimeViewBooksPage.set(0);
};

export const setRuntimeViewPage = (kind: 'accounts' | 'books', pageIndex: number): void => {
  const safePage = Math.max(0, Math.floor(Number(pageIndex) || 0));
  if (kind === 'accounts') runtimeViewAccountsPage.set(safePage);
  else runtimeViewBooksPage.set(safePage);
};

export const resetRuntimeViewSelection = (): void => {
  runtimeViewActiveEntityId.set('');
  runtimeViewAccountsPage.set(0);
  runtimeViewBooksPage.set(0);
  runtimeViewPageInfo.set(null);
  runtimeViewHistoryScan.set(emptyRuntimeViewHistoryScan());
};

const emptyRuntimeView = (): RuntimeView => {
  const handle = get(runtimeControllerHandle);
  return {
    runtimeId: handle.id,
    mode: handle.mode,
    authLevel: handle.authLevel,
    status: handle.status,
    height: handle.height,
    loading: false,
    error: null,
    head: null,
    frame: null,
    entities: [],
    activeEntityId: '',
  };
};

const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value || 'RuntimeView refresh failed');

let runtimeViewRefreshId = 0;
let heightRefreshInFlight = false;
let pendingHeightRefresh = 0;

export const runtimeView = writable<RuntimeView>(emptyRuntimeView());

export const resetRuntimeView = (): void => {
  runtimeViewRefreshId += 1;
  runtimeView.set(emptyRuntimeView());
};

export const refreshRuntimeView = async (query: RuntimeAdapterReadQuery = {}): Promise<RuntimeView> => {
  const refreshId = ++runtimeViewRefreshId;
  const handle = get(runtimeControllerHandle);
  const expectedRuntimeId = handle.id;
  const expectedRuntimeMode = handle.mode;
  const requestStillCurrent = (): boolean => {
    const current = get(runtimeControllerHandle);
    return refreshId === runtimeViewRefreshId &&
      current.id === expectedRuntimeId &&
      current.mode === expectedRuntimeMode;
  };
  runtimeView.update((view) => ({
    ...view,
    runtimeId: handle.id,
    mode: handle.mode,
    authLevel: handle.authLevel,
    status: handle.status,
    height: handle.height,
    loading: true,
    error: null,
  }));

  if (handle.status !== 'connected') {
    const next: RuntimeView = {
      ...emptyRuntimeView(),
      loading: false,
      error: 'Runtime adapter is not connected',
    };
    if (requestStillCurrent()) runtimeView.set(next);
    return next;
  }

  try {
    const [head, frame] = await Promise.all([
      runtimeQueryClient.readHead(),
      runtimeQueryClient.readViewFrame(query),
    ]);
    const current = get(runtimeControllerHandle);
    const next: RuntimeView = {
      runtimeId: current.id,
      mode: current.mode,
      authLevel: current.authLevel,
      status: current.status,
      height: Math.max(Number(current.height || 0), Number(frame.height || 0), Number(head.latestHeight || 0)),
      loading: false,
      error: null,
      head,
      frame,
      entities: frame.entities ?? [],
      activeEntityId: String(frame.activeEntityId || frame.activeEntity?.summary?.entityId || '').trim().toLowerCase(),
    };
    if (!requestStillCurrent()) return get(runtimeView);
    runtimeView.set(next);
    return next;
  } catch (error) {
    const current = get(runtimeControllerHandle);
    const next: RuntimeView = {
      ...emptyRuntimeView(),
      runtimeId: current.id,
      mode: current.mode,
      authLevel: current.authLevel,
      status: current.status,
      height: current.height,
      loading: false,
      error: errorMessage(error),
    };
    if (requestStillCurrent()) runtimeView.set(next);
    throw error;
  }
};

const currentRuntimeViewQuery = (): RuntimeAdapterReadQuery => {
  const view = get(runtimeView);
  const entityId = get(runtimeViewActiveEntityId) || view.activeEntityId;
  const query: RuntimeAdapterReadQuery = {
    accountsPage: get(runtimeViewAccountsPage),
    booksPage: get(runtimeViewBooksPage),
  };
  if (entityId) query.entityId = entityId;
  return query;
};

const refreshRuntimeViewAfterHeightAdvance = async (): Promise<void> => {
  if (heightRefreshInFlight) return;
  heightRefreshInFlight = true;
  try {
    while (pendingHeightRefresh > Math.max(0, Math.floor(Number(get(runtimeView).frame?.height || 0)))) {
      const targetHeight = pendingHeightRefresh;
      await refreshRuntimeView(currentRuntimeViewQuery());
      if (pendingHeightRefresh <= targetHeight) break;
    }
  } catch (error) {
    runtimeView.update((view) => ({
      ...view,
      loading: false,
      error: errorMessage(error),
    }));
  } finally {
    heightRefreshInFlight = false;
    const frameHeight = Math.max(0, Math.floor(Number(get(runtimeView).frame?.height || 0)));
    if (pendingHeightRefresh > frameHeight && get(runtimeControllerHandle).status === 'connected') {
      void refreshRuntimeViewAfterHeightAdvance();
    }
  }
};

runtimeAdapter.subscribe(() => {
  resetRuntimeView();
});

runtimeAdapterHeight.subscribe((height) => {
  const nextHeight = Math.max(0, Math.floor(Number(height || 0)));
  runtimeView.update((view) => ({
    ...view,
    height: Math.max(view.height, nextHeight),
  }));
  const handle = get(runtimeControllerHandle);
  if (handle.status !== 'connected' || nextHeight <= 0) return;
  const frameHeight = Math.max(0, Math.floor(Number(get(runtimeView).frame?.height || 0)));
  if (nextHeight <= frameHeight) return;
  pendingHeightRefresh = Math.max(pendingHeightRefresh, nextHeight);
  void refreshRuntimeViewAfterHeightAdvance();
});
