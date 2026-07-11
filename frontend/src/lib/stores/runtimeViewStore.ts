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
  atHeight: number | null;
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

export const runtimeViewPageNeedsNavigation = (
  pageInfo: RuntimeViewPageInfo,
  kind?: 'accounts' | 'books',
): boolean => {
  const accountsNeedNavigation = pageInfo.accountsPageIndex > 0 || pageInfo.accountsPageCount > 1;
  const booksNeedNavigation = pageInfo.booksPageIndex > 0 || pageInfo.booksPageCount > 1;
  if (kind === 'accounts') return accountsNeedNavigation;
  if (kind === 'books') return booksNeedNavigation;
  return accountsNeedNavigation || booksNeedNavigation;
};

const normalizeEntityIdForRuntimeView = (value: unknown): string => String(value || '').trim().toLowerCase();

export const normalizeRuntimeViewAtHeight = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const height = Math.floor(Number(value));
  if (!Number.isFinite(height) || height < 1) {
    throw new Error('RuntimeView historical height must be a positive integer');
  }
  return height;
};

export const runtimeViewQueryAtHeight = (
  query: RuntimeAdapterReadQuery,
  atHeight: number | null,
): RuntimeAdapterReadQuery => {
  const next = { ...query };
  if (atHeight === null) delete next.atHeight;
  else next.atHeight = atHeight;
  return next;
};

export const runtimeViewFrameMatchesAtHeight = (
  frame: RuntimeAdapterViewFrame | null | undefined,
  atHeight: number | null,
): boolean => {
  if (!frame) return false;
  if (atHeight === null) return true;
  return Math.max(0, Math.floor(Number(frame.height || 0))) === atHeight;
};

export const runtimeViewNeedsHeightRefresh = (
  view: Pick<RuntimeView, 'atHeight' | 'frame'>,
  status: RuntimeAdapterStatus,
  nextHeight: number,
): boolean => {
  if (view.atHeight !== null || status !== 'connected' || !view.frame) return false;
  const frameHeight = Math.max(0, Math.floor(Number(view.frame.height || 0)));
  return nextHeight > frameHeight;
};

export const assertRuntimeViewIsLive = (view: Pick<RuntimeView, 'atHeight'>): void => {
  if (view.atHeight === null) return;
  throw new Error(`RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: selected=h${view.atHeight}`);
};

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

let selectedRuntimeViewHeight: number | null = null;

const emptyRuntimeView = (atHeight = selectedRuntimeViewHeight): RuntimeView => {
  const handle = get(runtimeControllerHandle);
  return {
    runtimeId: handle.id,
    mode: handle.mode,
    authLevel: handle.authLevel,
    status: handle.status,
    atHeight,
    height: atHeight ?? handle.height,
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
  pendingHeightRefresh = 0;
  selectedRuntimeViewHeight = null;
  runtimeView.set(emptyRuntimeView());
};

export const refreshRuntimeView = async (inputQuery: RuntimeAdapterReadQuery = {}): Promise<RuntimeView> => {
  const refreshId = ++runtimeViewRefreshId;
  const handle = get(runtimeControllerHandle);
  const expectedRuntimeId = handle.id;
  const expectedRuntimeMode = handle.mode;
  const expectedAtHeight = selectedRuntimeViewHeight;
  const query = runtimeViewQueryAtHeight(inputQuery, expectedAtHeight);
  const requestStillCurrent = (): boolean => {
    const current = get(runtimeControllerHandle);
    return refreshId === runtimeViewRefreshId &&
      current.id === expectedRuntimeId &&
      current.mode === expectedRuntimeMode &&
      selectedRuntimeViewHeight === expectedAtHeight;
  };
  runtimeView.update((view) => ({
    ...view,
    runtimeId: handle.id,
    mode: handle.mode,
    authLevel: handle.authLevel,
    status: handle.status,
    atHeight: expectedAtHeight,
    height: expectedAtHeight ?? handle.height,
    loading: true,
    error: null,
  }));

  if (handle.status !== 'connected') {
    const next: RuntimeView = {
      ...emptyRuntimeView(expectedAtHeight),
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
    if (!runtimeViewFrameMatchesAtHeight(frame, expectedAtHeight)) {
      throw new Error(`RuntimeView returned h${Number(frame.height || 0)} for selected h${expectedAtHeight}`);
    }
    const next: RuntimeView = {
      runtimeId: handle.id,
      mode: handle.mode,
      authLevel: handle.authLevel,
      status: handle.status,
      atHeight: expectedAtHeight,
      height: expectedAtHeight ?? Math.max(Number(handle.height || 0), Number(frame.height || 0), Number(head.latestHeight || 0)),
      loading: false,
      error: null,
      head,
      frame,
      entities: frame.entities ?? [],
      activeEntityId: String(frame.activeEntityId || frame.activeEntity?.summary?.entityId || '').trim().toLowerCase(),
    };
    // A superseded read still owns its result. Latest-wins applies only to the
    // shared store; callers must never receive another request's transient state.
    if (requestStillCurrent()) runtimeView.set(next);
    return next;
  } catch (error) {
    if (!requestStillCurrent()) throw error;
    const current = get(runtimeControllerHandle);
    const next: RuntimeView = {
      ...emptyRuntimeView(expectedAtHeight),
      runtimeId: current.id,
      mode: current.mode,
      authLevel: current.authLevel,
      status: current.status,
      atHeight: expectedAtHeight,
      height: expectedAtHeight ?? current.height,
      loading: false,
      error: errorMessage(error),
    };
    runtimeView.set(next);
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
  return runtimeViewQueryAtHeight(query, selectedRuntimeViewHeight);
};

export const setRuntimeViewAtHeight = async (value: number | null): Promise<RuntimeView> => {
  const atHeight = normalizeRuntimeViewAtHeight(value);
  const current = get(runtimeView);
  if (
    selectedRuntimeViewHeight === atHeight &&
    runtimeViewFrameMatchesAtHeight(current.frame, atHeight) &&
    !current.loading &&
    !current.error
  ) {
    return current;
  }

  selectedRuntimeViewHeight = atHeight;
  runtimeViewRefreshId += 1;
  pendingHeightRefresh = 0;
  runtimeView.update((view) => ({
    ...view,
    atHeight,
    height: atHeight ?? get(runtimeControllerHandle).height,
    loading: true,
    error: null,
    frame: null,
    entities: [],
  }));
  return refreshRuntimeView(currentRuntimeViewQuery());
};

const refreshRuntimeViewAfterHeightAdvance = async (): Promise<void> => {
  if (selectedRuntimeViewHeight !== null) return;
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
    if (
      selectedRuntimeViewHeight === null &&
      pendingHeightRefresh > frameHeight &&
      get(runtimeControllerHandle).status === 'connected'
    ) {
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
    height: view.atHeight ?? Math.max(view.height, nextHeight),
  }));
  const handle = get(runtimeControllerHandle);
  const view = get(runtimeView);
  // The adapter switcher owns the initial projection. Starting an automatic
  // height refresh before that frame exists races the initial read and can
  // make its caller observe a transient frame=null as a successful result.
  if (!runtimeViewNeedsHeightRefresh(view, handle.status, nextHeight)) return;
  pendingHeightRefresh = Math.max(pendingHeightRefresh, nextHeight);
  void refreshRuntimeViewAfterHeightAdvance();
});
