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
  RuntimeViewLoader,
} from '../../../packages/runtime-client/src/runtime-view-loader';
import {
  RuntimeViewProjectionReader,
} from '../../../packages/runtime-client/src/runtime-view-projections';
import {
  RuntimeViewPublicationCoordinator,
} from '../../../packages/runtime-client/src/runtime-view-publication';
import {
  advanceRuntimeViewHeight,
  createEmptyRuntimeViewState,
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
): Promise<RuntimeAdapterViewFrame> => runtimeViewProjectionReader.readEntityFrame(entityId);

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
): Promise<StorageAccountDoc> => runtimeViewProjectionReader.readAccount(
  entityId,
  counterpartyId,
);

/**
 * History is intentionally not part of the live Account projection. This
 * returns untrusted adapter bytes; the swap UI owns the exact page decoder.
 */
export const readRuntimeSwapHistory = async (
  entityId: string,
  counterpartyId: string,
  cursor: string | null,
): Promise<unknown> => runtimeViewProjectionReader.readSwapHistory(
  entityId,
  counterpartyId,
  cursor,
);

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

const runtimeViewProjectionReader = new RuntimeViewProjectionReader<
  RuntimeAdapterViewFrame,
  StorageAccountDoc,
  unknown
>({
  readAtHeight: () => get(runtimeView).atHeight,
  readViewFrame: (query) => runtimeQueryClient.readViewFrame(query),
  readAccount: (entityId, counterpartyId, query) =>
    runtimeQueryClient.readAccount(entityId, counterpartyId, query),
  readSwapHistory: (entityId, counterpartyId, query) =>
    runtimeQueryClient.readSwapHistory(entityId, counterpartyId, query),
});

const runtimeViewLoader = new RuntimeViewLoader<
  RuntimeAdapterReadQuery,
  StorageHead,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame
>({
  readCurrentHandle: () => get(runtimeControllerHandle),
  readHead: () => runtimeQueryClient.readHead(),
  readFrame: (query) => runtimeQueryClient.readViewFrame(query),
});

const runtimeViewPublicationCoordinator = new RuntimeViewPublicationCoordinator<
  RuntimeAdapterReadQuery,
  StorageHead,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame
>({
  refresh: runtimeViewRefreshCoordinator,
  loader: runtimeViewLoader,
  readHandle: () => get(runtimeControllerHandle),
  readView: () => get(runtimeView),
  publishLoading: (view) => runtimeView.set(view),
  publishSuccess: (view, frame) => {
    runtimeViewPageInfo.set(runtimeViewPageInfoFromFrame(frame));
    runtimeView.set(view);
    continueRuntimeViewCatchup();
  },
  publishUnavailable: (view) => {
    runtimeViewPageInfo.set(null);
    runtimeView.set(view);
  },
});

export const resetRuntimeView = (): void => {
  runtimeViewCatchup.reset();
  if (!runtimeViewSelectionCoordinator.setAtHeight(null)) {
    runtimeViewRefreshCoordinator.invalidate();
  }
  runtimeViewPageInfo.set(null);
  runtimeView.set(emptyRuntimeView());
};

export const refreshRuntimeView = (
  inputQuery: RuntimeAdapterReadQuery = {},
): Promise<RuntimeView> => runtimeViewPublicationCoordinator.refresh(inputQuery);

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
