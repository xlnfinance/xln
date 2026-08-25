import { get, writable } from 'svelte/store';
import type {
  RuntimeAdapterEntitySummary,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';
import type { StorageAccountDoc, StorageHead } from '@xln/core/storage/types';
import {
  runtimeAdapter,
  runtimeAdapterHeight,
  runtimeControllerHandle,
} from './runtimeControllerStore';
import { errorLog } from './errorLogStore';
import { runtimeQueryClient } from './runtimeQueryClient';
import {
  assertRuntimeViewIsLive,
  emptyRuntimeViewHistoryScan,
  normalizeEntityIdForRuntimeView,
  normalizeRuntimeViewAtHeight,
  runtimeViewFrameMatchesAtHeight,
  runtimeViewNeedsHeightRefresh,
  runtimeViewPageInfoFromFrame,
  runtimeViewPageNeedsNavigation,
  runtimeViewQueryAtHeight,
  runtimeViewTracksHeightAdvance,
  type RuntimeViewHistoryScanState,
  type RuntimeViewPageInfo,
} from '../../../packages/runtime-client/src/runtime-view-model';
import {
  RuntimeViewCatchupCoordinator,
  runtimeViewCatchupRetryDelayMs,
} from '../../../packages/runtime-client/src/runtime-view-catchup';

export {
  assertRuntimeViewIsLive,
  emptyRuntimeViewHistoryScan,
  normalizeRuntimeViewAtHeight,
  runtimeViewFrameMatchesAtHeight,
  runtimeViewNeedsHeightRefresh,
  runtimeViewPageInfoFromFrame,
  runtimeViewPageNeedsNavigation,
  runtimeViewQueryAtHeight,
  runtimeViewTracksHeightAdvance,
};
export type { RuntimeViewHistoryScanState, RuntimeViewPageInfo };

export const runtimeViewHeightRetryDelayMs = runtimeViewCatchupRetryDelayMs;

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

/**
 * Read one detached Entity projection without changing the workspace's active
 * Entity. Cross-network tools use this for a secondary local signer: changing
 * the shared selection would replace the page the user is currently auditing.
 */
export const readRuntimeEntityProjectionFrame = async (
  entityId: string,
): Promise<RuntimeAdapterViewFrame> => {
  const normalizedEntityId = normalizeEntityIdForRuntimeView(entityId);
  if (!normalizedEntityId) throw new Error('RUNTIME_ENTITY_PROJECTION_ID_MISSING');
  const atHeight = get(runtimeView).atHeight;
  const frame = await runtimeQueryClient.readViewFrame(runtimeViewQueryAtHeight({
    entityId: normalizedEntityId,
    accountsLimit: 10,
    booksLimit: 10,
  }, atHeight));
  const projectedEntityId = normalizeEntityIdForRuntimeView(
    frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.activeEntity?.core?.entityId,
  );
  if (projectedEntityId !== normalizedEntityId) {
    throw new Error(`RUNTIME_ENTITY_PROJECTION_MISMATCH:${normalizedEntityId}:${projectedEntityId || 'missing'}`);
  }
  return frame;
};

/**
 * Point-read one Account when a panel needs bounded Account-owned detail.
 *
 * Aggregate Entity frames intentionally omit lifecycle history so their wire
 * size stays independent of `accountsLimit`. The selected Account can include
 * its recent read-model tail without multiplying that cost by every row.
 */
export const readRuntimeAccountProjection = async (
  entityId: string,
  counterpartyId: string,
): Promise<StorageAccountDoc> => {
  const normalizedEntityId = normalizeEntityIdForRuntimeView(entityId);
  const normalizedCounterpartyId = normalizeEntityIdForRuntimeView(counterpartyId);
  if (!normalizedEntityId || !normalizedCounterpartyId) {
    throw new Error('RUNTIME_ACCOUNT_PROJECTION_ID_MISSING');
  }
  const atHeight = get(runtimeView).atHeight;
  return runtimeQueryClient.readAccount(
    normalizedEntityId,
    normalizedCounterpartyId,
    runtimeViewQueryAtHeight({}, atHeight),
  );
};

/**
 * History is intentionally not part of the live Account projection. This
 * returns untrusted adapter bytes; the swap UI owns the exact page decoder.
 */
export const readRuntimeSwapHistory = async (
  entityId: string,
  counterpartyId: string,
  cursor: string | null,
): Promise<unknown> => {
  const normalizedEntityId = normalizeEntityIdForRuntimeView(entityId);
  const normalizedCounterpartyId = normalizeEntityIdForRuntimeView(counterpartyId);
  if (!normalizedEntityId || !normalizedCounterpartyId) {
    throw new Error('RUNTIME_SWAP_HISTORY_ID_MISSING');
  }
  const atHeight = get(runtimeView).atHeight;
  return runtimeQueryClient.readSwapHistory(
    normalizedEntityId,
    normalizedCounterpartyId,
    runtimeViewQueryAtHeight({ ...(cursor === null ? {} : { cursor }), limit: 100 }, atHeight),
  );
};

export const runtimeViewActiveEntityId = writable<string>('');
export const runtimeViewAccountsPage = writable<number>(0);
export const runtimeViewBooksPage = writable<number>(0);
export const runtimeViewPageInfo = writable<RuntimeViewPageInfo | null>(null);
export const runtimeViewHistoryScan = writable<RuntimeViewHistoryScanState>(
  emptyRuntimeViewHistoryScan(),
);
let runtimeViewRefreshId = 0;
let runtimeViewSelectionRevision = 0;

export type RuntimeViewSelection = {
  revision: number;
  entityId: string;
  accountsPage: number;
  booksPage: number;
  atHeight: number | null;
};

export const readRuntimeViewSelection = (): RuntimeViewSelection => ({
  revision: runtimeViewSelectionRevision,
  entityId: normalizeEntityIdForRuntimeView(get(runtimeViewActiveEntityId)),
  accountsPage: Math.max(0, Math.floor(Number(get(runtimeViewAccountsPage) ?? 0))),
  booksPage: Math.max(0, Math.floor(Number(get(runtimeViewBooksPage) ?? 0))),
  atHeight: selectedRuntimeViewHeight,
});

export const runtimeViewSelectionMatches = (expected: RuntimeViewSelection): boolean => {
  const current = readRuntimeViewSelection();
  return current.revision === expected.revision &&
    current.entityId === expected.entityId &&
    current.accountsPage === expected.accountsPage &&
    current.booksPage === expected.booksPage &&
    current.atHeight === expected.atHeight;
};

export const runtimeViewPublicationMatches = (
  expectedGeneration: number,
  currentGeneration: number,
  expectedSelection: RuntimeViewSelection,
): boolean => expectedGeneration === currentGeneration &&
  runtimeViewSelectionMatches(expectedSelection);

export const setRuntimeViewActiveEntityId = (entityId: string): void => {
  const normalizedEntityId = normalizeEntityIdForRuntimeView(entityId);
  if (get(runtimeViewActiveEntityId) === normalizedEntityId) return;
  runtimeViewSelectionRevision += 1;
  runtimeViewRefreshId += 1;
  runtimeViewActiveEntityId.set(normalizedEntityId);
  runtimeViewAccountsPage.set(0);
  runtimeViewBooksPage.set(0);
};

export const setRuntimeViewPage = (kind: 'accounts' | 'books', pageIndex: number): void => {
  const safePage = Math.max(0, Math.floor(Number(pageIndex) || 0));
  const target = kind === 'accounts' ? runtimeViewAccountsPage : runtimeViewBooksPage;
  if (get(target) === safePage) return;
  runtimeViewSelectionRevision += 1;
  runtimeViewRefreshId += 1;
  target.set(safePage);
};

export const resetRuntimeViewSelection = (): void => {
  runtimeViewSelectionRevision += 1;
  runtimeViewRefreshId += 1;
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

export const runtimeView = writable<RuntimeView>(emptyRuntimeView());

export const resetRuntimeView = (): void => {
  runtimeViewRefreshId += 1;
  runtimeViewCatchup.reset();
  if (selectedRuntimeViewHeight !== null) runtimeViewSelectionRevision += 1;
  selectedRuntimeViewHeight = null;
  runtimeViewPageInfo.set(null);
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
    if (requestStillCurrent()) {
      runtimeViewPageInfo.set(null);
      runtimeView.set(next);
    }
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
    if (requestStillCurrent()) {
      runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame));
      runtimeView.set(next);
      continueRuntimeViewCatchup();
    }
    return next;
  } catch (error) {
    const next: RuntimeView = {
      ...emptyRuntimeView(expectedAtHeight),
      loading: false,
      error: errorMessage(error),
    };
    // A superseded read must not overwrite a newer RuntimeView, and must not
    // reject: void click-handlers and height catch-up would become unhandled
    // `runtime adapter socket closed` pageerrors during a runtime switch.
    if (!requestStillCurrent()) return next;
    const current = get(runtimeControllerHandle);
    next.runtimeId = current.id;
    next.mode = current.mode;
    next.authLevel = current.authLevel;
    next.status = current.status;
    next.atHeight = expectedAtHeight;
    next.height = expectedAtHeight ?? current.height;
    runtimeViewPageInfo.set(null);
    runtimeView.set(next);
    return next;
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

export const refreshSelectedRuntimeView = (): Promise<RuntimeView> =>
  refreshRuntimeView(currentRuntimeViewQuery());

const runtimeViewCatchup = new RuntimeViewCatchupCoordinator({
  readState: () => {
    const view = get(runtimeView);
    return {
      atHeight: view.atHeight,
      frameHeight: Math.max(0, Math.floor(Number(view.frame?.height || 0))),
      hasFrame: !!view.frame,
      status: get(runtimeControllerHandle).status,
    };
  },
  refresh: async () => { await refreshSelectedRuntimeView(); },
  publishTimeout: (message) => {
    runtimeView.update((view) => ({ ...view, loading: false, error: message }));
  },
  reportRefreshError: (error) => {
    errorLog.log(errorMessage(error), 'Runtime View Catch-up', error);
  },
  scheduleRetry: (listener, delayMs) => setTimeout(listener, delayMs),
  cancelRetry: (timer) => clearTimeout(timer),
});

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

  if (selectedRuntimeViewHeight !== atHeight) runtimeViewSelectionRevision += 1;
  selectedRuntimeViewHeight = atHeight;
  runtimeViewRefreshId += 1;
  runtimeViewCatchup.reset();
  runtimeViewPageInfo.set(null);
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

function continueRuntimeViewCatchup(): void {
  void runtimeViewCatchup.continue();
}

runtimeAdapter.subscribe(() => {
  resetRuntimeView();
});

runtimeAdapterHeight.subscribe((height) => {
  const nextHeight = Math.max(0, Math.floor(Number(height || 0)));
  runtimeView.update((view) => ({
    ...view,
    height: view.atHeight ?? Math.max(view.height, nextHeight),
  }));
  runtimeViewCatchup.observeHeight(nextHeight);
});
