import { derived, get, readable, writable } from 'svelte/store';
import type {
  RuntimeAdapterEntitySummary,
  RuntimeAdapterReadQuery,
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
import {
  RuntimeViewSelectionCoordinator,
  type RuntimeViewPageKind,
  type RuntimeViewSelection,
} from '../../../packages/runtime-client/src/runtime-view-selection';
import {
  RuntimeViewRefreshCoordinator,
  type RuntimeViewRefreshTarget,
} from '../../../packages/runtime-client/src/runtime-view-refresh';
import {
  advanceRuntimeViewHeight,
  createDisconnectedRuntimeViewState,
  createEmptyRuntimeViewState,
  createErrorRuntimeViewState,
  createLoadingRuntimeViewState,
  createSuccessRuntimeViewState,
  runtimeViewErrorMessage,
  selectRuntimeViewHeight,
  type RuntimeViewState,
} from '../../../packages/runtime-client/src/runtime-view-state';

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

export type RuntimeView = RuntimeViewState<
  StorageHead,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame
>;

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

const runtimeViewRefreshCoordinator: RuntimeViewRefreshCoordinator =
  new RuntimeViewRefreshCoordinator({
    readTarget: (): RuntimeViewRefreshTarget => {
      const handle = get(runtimeControllerHandle);
      return {
        runtimeId: handle.id,
        mode: handle.mode,
        selection: runtimeViewSelectionCoordinator.getSnapshot(),
      };
    },
  });
const runtimeViewSelectionCoordinator: RuntimeViewSelectionCoordinator =
  new RuntimeViewSelectionCoordinator({
    beforePublish: runtimeViewRefreshCoordinator.invalidate,
  });
const runtimeViewSelectionStore = readable(
  runtimeViewSelectionCoordinator.getSnapshot(),
  (set) => {
    set(runtimeViewSelectionCoordinator.getSnapshot());
    return runtimeViewSelectionCoordinator.subscribe(() => {
      set(runtimeViewSelectionCoordinator.getSnapshot());
    });
  },
);
export const runtimeViewActiveEntityId = derived(
  runtimeViewSelectionStore,
  (selection) => selection.entityId,
);
export const runtimeViewAccountsPage = derived(
  runtimeViewSelectionStore,
  (selection) => selection.accountsPage,
);
export const runtimeViewBooksPage = derived(
  runtimeViewSelectionStore,
  (selection) => selection.booksPage,
);
export const runtimeViewPageInfo = writable<RuntimeViewPageInfo | null>(null);
export const runtimeViewHistoryScan = writable<RuntimeViewHistoryScanState>(
  emptyRuntimeViewHistoryScan(),
);
export type { RuntimeViewSelection };

export const readRuntimeViewSelection = runtimeViewSelectionCoordinator.getSnapshot;

export const runtimeViewSelectionMatches = runtimeViewSelectionCoordinator.matches;

export const runtimeViewPublicationMatches = (
  expectedGeneration: number,
  currentGeneration: number,
  expectedSelection: RuntimeViewSelection,
): boolean => runtimeViewSelectionCoordinator.publicationMatches(
  expectedGeneration,
  currentGeneration,
  expectedSelection,
);

export const setRuntimeViewActiveEntityId = (entityId: string): void => {
  runtimeViewSelectionCoordinator.setActiveEntityId(entityId);
};

export const setRuntimeViewPage = (kind: RuntimeViewPageKind, pageIndex: number): void => {
  runtimeViewSelectionCoordinator.setPage(kind, pageIndex);
};

export const resetRuntimeViewSelection = (): void => {
  runtimeViewSelectionCoordinator.resetNavigation();
  runtimeViewPageInfo.set(null);
  runtimeViewHistoryScan.set(emptyRuntimeViewHistoryScan());
};

const emptyRuntimeView = (
  atHeight = runtimeViewSelectionCoordinator.getSnapshot().atHeight,
): RuntimeView => createEmptyRuntimeViewState<
  StorageHead,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame
>(get(runtimeControllerHandle), atHeight);

export const runtimeView = writable<RuntimeView>(emptyRuntimeView());

export const resetRuntimeView = (): void => {
  runtimeViewCatchup.reset();
  if (!runtimeViewSelectionCoordinator.setAtHeight(null)) {
    runtimeViewRefreshCoordinator.invalidate();
  }
  runtimeViewPageInfo.set(null);
  runtimeView.set(emptyRuntimeView());
};

export const refreshRuntimeView = async (inputQuery: RuntimeAdapterReadQuery = {}): Promise<RuntimeView> => {
  const refreshLease = runtimeViewRefreshCoordinator.begin();
  const handle = get(runtimeControllerHandle);
  const expectedAtHeight = refreshLease.selection.atHeight;
  const query = runtimeViewQueryAtHeight(inputQuery, expectedAtHeight);
  const requestStillCurrent = (): boolean =>
    runtimeViewRefreshCoordinator.isCurrent(refreshLease);
  runtimeView.update((view) =>
    createLoadingRuntimeViewState(view, handle, expectedAtHeight));

  if (handle.status !== 'connected') {
    const next = createDisconnectedRuntimeViewState<
      StorageHead,
      RuntimeAdapterEntitySummary,
      RuntimeAdapterViewFrame
    >(handle, expectedAtHeight);
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
    const next = createSuccessRuntimeViewState<
      StorageHead,
      RuntimeAdapterEntitySummary,
      RuntimeAdapterViewFrame
    >(handle, expectedAtHeight, head, frame);
    // A superseded read still owns its result. Latest-wins applies only to the
    // shared store; callers must never receive another request's transient state.
    if (requestStillCurrent()) {
      runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame));
      runtimeView.set(next);
      continueRuntimeViewCatchup();
    }
    return next;
  } catch (error) {
    const current = get(runtimeControllerHandle);
    const next = createErrorRuntimeViewState<
      StorageHead,
      RuntimeAdapterEntitySummary,
      RuntimeAdapterViewFrame
    >(current, expectedAtHeight, error);
    // A superseded read must not overwrite a newer RuntimeView, and must not
    // reject: void click-handlers and height catch-up would become unhandled
    // `runtime adapter socket closed` pageerrors during a runtime switch.
    if (!requestStillCurrent()) return next;
    runtimeViewPageInfo.set(null);
    runtimeView.set(next);
    return next;
  }
};

const currentRuntimeViewQuery = (): RuntimeAdapterReadQuery => {
  const view = get(runtimeView);
  const selection = runtimeViewSelectionCoordinator.getSnapshot();
  const entityId = selection.entityId || view.activeEntityId;
  const query: RuntimeAdapterReadQuery = {
    accountsPage: selection.accountsPage,
    booksPage: selection.booksPage,
  };
  if (entityId) query.entityId = entityId;
  return runtimeViewQueryAtHeight(query, selection.atHeight);
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
    errorLog.log(runtimeViewErrorMessage(error), 'Runtime View Catch-up', error);
  },
  scheduleRetry: (listener, delayMs) => setTimeout(listener, delayMs),
  cancelRetry: (timer) => clearTimeout(timer),
});

export const setRuntimeViewAtHeight = async (value: number | null): Promise<RuntimeView> => {
  const atHeight = normalizeRuntimeViewAtHeight(value);
  const current = get(runtimeView);
  if (
    runtimeViewSelectionCoordinator.getSnapshot().atHeight === atHeight &&
    runtimeViewFrameMatchesAtHeight(current.frame, atHeight) &&
    !current.loading &&
    !current.error
  ) {
    return current;
  }

  runtimeViewSelectionCoordinator.setAtHeight(atHeight);
  runtimeViewCatchup.reset();
  runtimeViewPageInfo.set(null);
  runtimeView.update((view) =>
    selectRuntimeViewHeight(view, atHeight, get(runtimeControllerHandle).height));
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
  runtimeView.update((view) => advanceRuntimeViewHeight(view, nextHeight));
  runtimeViewCatchup.observeHeight(nextHeight);
});
