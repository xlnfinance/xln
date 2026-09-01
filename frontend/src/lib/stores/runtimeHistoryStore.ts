import { get, writable } from 'svelte/store';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import { REMOTE_RUNTIME } from '@xln/core/config/constants';
import {
  assertTimeMachineHistorySelection,
  createRuntimeHistoryContext,
  createTimeMachineHistoryBatchQuery,
  createTimeMachineScanFailureState,
  createTimeMachineScanLoadingState,
  createTimeMachineScanSuccessState,
  getTimeMachineTransportErrorMessage,
  mergeRuntimeHistoryFrame,
  normalizeTimeMachineRequestedHeight,
  requireTimeMachineHistoryFrame,
  runtimeHistoryContextKey as buildRuntimeHistoryContextKey,
  runtimeHistoryFrameFromViewFrame,
  type RuntimeHistoryContext,
  type RuntimeHistoryFrame,
} from '../../../packages/runtime-client/src/time-machine-transport';
import {
  getRuntimeControllerAdapter,
  getRuntimeControllerConfig,
} from './runtimeControllerStore';
import { runtimeQueryClient } from './runtimeQueryClient';
import {
  readRuntimeViewSelection,
  emptyRuntimeViewHistoryScan,
  runtimeViewHistoryScan,
  runtimeViewSelectionMatches,
  setRuntimeViewActiveEntityId,
} from './runtimeViewStore';

export {
  createRuntimeHistoryContext,
  mergeRuntimeHistoryFrame,
  runtimeHistoryFrameFromViewFrame,
};
export type { RuntimeHistoryContext, RuntimeHistoryFrame };

export const REMOTE_HISTORY_VIEW_PAGE_SIZE = REMOTE_RUNTIME.HISTORY_VIEW_PAGE_SIZE;
export const REMOTE_HISTORY_SCAN_CACHE_LIMIT = REMOTE_RUNTIME.HISTORY_SCAN_CACHE_LIMIT;

export const runtimeHistoryFrames = writable<RuntimeHistoryFrame[]>([]);
let runtimeHistoryContextKey = '';
let runtimeHistoryScanGeneration = 0;

export const ensureRuntimeHistoryContext = (
  input: RuntimeHistoryContext,
  endpoint = '',
): RuntimeHistoryContext => {
  const context = createRuntimeHistoryContext(input);
  const nextKey = buildRuntimeHistoryContextKey(context);
  if (runtimeHistoryContextKey === nextKey) return context;
  runtimeHistoryScanGeneration += 1;
  runtimeHistoryContextKey = nextKey;
  runtimeHistoryFrames.set([]);
  runtimeViewHistoryScan.set(emptyRuntimeViewHistoryScan(endpoint));
  return context;
};

export const upsertRuntimeHistoryFrame = (
  input: {
    runtimeId: string;
    mode: 'embedded' | 'remote';
    frame: RuntimeAdapterViewFrame;
    context: RuntimeHistoryContext;
  },
  limit: number,
): RuntimeHistoryFrame[] => {
  const context = createRuntimeHistoryContext(input.context);
  const expectedContextKey = buildRuntimeHistoryContextKey(context);
  if (runtimeHistoryContextKey !== expectedContextKey) {
    throw new Error('RUNTIME_HISTORY_CONTEXT_SUPERSEDED');
  }
  const nextFrame = runtimeHistoryFrameFromViewFrame(input);
  if (nextFrame.runtimeId !== context.runtimeId || nextFrame.mode !== context.mode) {
    throw new Error(`RUNTIME_HISTORY_RUNTIME_MISMATCH:${context.runtimeId}:${nextFrame.runtimeId}`);
  }
  if (context.entityId && nextFrame.activeEntityId !== context.entityId) {
    throw new Error(`RUNTIME_HISTORY_ENTITY_MISMATCH:${context.entityId}:${nextFrame.activeEntityId || 'missing'}`);
  }
  if (nextFrame.pageInfo) {
    if (
      nextFrame.pageInfo.accountsPageIndex !== context.accountsPage ||
      nextFrame.pageInfo.booksPageIndex !== context.booksPage
    ) {
      throw new Error(
        `RUNTIME_HISTORY_PAGE_MISMATCH:${context.accountsPage}:${context.booksPage}:${nextFrame.pageInfo.accountsPageIndex}:${nextFrame.pageInfo.booksPageIndex}`,
      );
    }
  } else if (context.entityId || context.accountsPage !== 0 || context.booksPage !== 0) {
    throw new Error('RUNTIME_HISTORY_PAGE_INFO_MISSING');
  }
  const nextFrames = mergeRuntimeHistoryFrame(get(runtimeHistoryFrames), nextFrame, limit);
  runtimeHistoryFrames.set(nextFrames);
  return nextFrames;
};

export const resetRuntimeHistoryFrames = (): void => {
  runtimeHistoryScanGeneration += 1;
  runtimeHistoryContextKey = '';
  runtimeHistoryFrames.set([]);
};

export const scanRuntimeAdapterHistoryAtHeight = async (
  height: number,
): Promise<{ frameIndex: number; snapshot: { height: number }; frame: RuntimeAdapterViewFrame; framesCached: number } | null> => {
  const config = getRuntimeControllerConfig();
  if (!config || config.mode !== 'remote') {
    throw new Error('Remote Time Machine scan requires a remote runtime adapter');
  }
  const requestedHeight = normalizeTimeMachineRequestedHeight(height);
  const adapter = getRuntimeControllerAdapter();
  if (!adapter || adapter.mode !== 'remote') {
    throw new Error('Runtime adapter is not connected');
  }
  let selection = readRuntimeViewSelection();
  let historyContext = ensureRuntimeHistoryContext({
    runtimeId: adapter.runtimeId,
    mode: 'remote',
    entityId: selection.entityId,
    accountsPage: selection.accountsPage,
    booksPage: selection.booksPage,
  }, config.wsUrl || '');
  let scanGeneration = ++runtimeHistoryScanGeneration;
  const requestStillCurrent = (): boolean =>
    scanGeneration === runtimeHistoryScanGeneration &&
    getRuntimeControllerAdapter() === adapter &&
    runtimeViewSelectionMatches(selection);

  const startedAt = Date.now();
  runtimeViewHistoryScan.set(createTimeMachineScanLoadingState({
    requestedHeight,
    framesCached: get(runtimeHistoryFrames).length,
    endpoint: config.wsUrl || '',
  }));

  try {
    const batch = await runtimeQueryClient.readHistoryFrameBatch(createTimeMachineHistoryBatchQuery(
      selection,
      requestedHeight,
      REMOTE_HISTORY_VIEW_PAGE_SIZE,
    ));
    if (!requestStillCurrent()) return null;
    const frame = requireTimeMachineHistoryFrame(batch, requestedHeight);
    const projected = runtimeHistoryFrameFromViewFrame({
      runtimeId: adapter.runtimeId,
      mode: 'remote',
      frame,
    });
    assertTimeMachineHistorySelection(projected, selection);
    if (!selection.entityId && projected.activeEntityId) {
      setRuntimeViewActiveEntityId(projected.activeEntityId);
      selection = readRuntimeViewSelection();
      historyContext = ensureRuntimeHistoryContext({
        runtimeId: adapter.runtimeId,
        mode: 'remote',
        entityId: selection.entityId,
        accountsPage: selection.accountsPage,
        booksPage: selection.booksPage,
      }, config.wsUrl || '');
      scanGeneration = runtimeHistoryScanGeneration;
    }
    const projectionHistory = upsertRuntimeHistoryFrame({
      runtimeId: adapter.runtimeId,
      mode: 'remote',
      frame,
      context: historyContext,
    }, REMOTE_HISTORY_SCAN_CACHE_LIMIT);

    const scannedHeight = Math.max(0, Math.floor(Number(frame.height || requestedHeight)));
    const frameIndex = projectionHistory.findIndex((item) => Math.max(0, Number(item.height || 0)) === scannedHeight);
    if (frameIndex < 0) throw new Error(`Remote Time Machine scan did not cache height ${scannedHeight}`);
    if (!requestStillCurrent()) return null;
    runtimeViewHistoryScan.set(createTimeMachineScanSuccessState({
      requestedHeight,
      frame,
      adapterHeight: adapter.currentHeight,
      framesCached: projectionHistory.length,
      durationMs: Date.now() - startedAt,
      endpoint: config.wsUrl || '',
    }));
    return { frameIndex, snapshot: { height: scannedHeight }, frame, framesCached: projectionHistory.length };
  } catch (error) {
    if (!requestStillCurrent()) return null;
    const message = getTimeMachineTransportErrorMessage(error);
    runtimeViewHistoryScan.set(createTimeMachineScanFailureState({
      error: message,
      requestedHeight,
      framesCached: get(runtimeHistoryFrames).length,
      durationMs: Date.now() - startedAt,
      endpoint: config.wsUrl || '',
    }));
    throw error;
  }
};
