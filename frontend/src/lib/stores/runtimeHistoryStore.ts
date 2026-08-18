import { get, writable } from 'svelte/store';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import { REMOTE_RUNTIME } from '@xln/core/config/constants';
import {
  getRuntimeControllerAdapter,
  getRuntimeControllerConfig,
} from './runtimeControllerStore';
import { runtimeQueryClient } from './runtimeQueryClient';
import {
  readRuntimeViewSelection,
  emptyRuntimeViewHistoryScan,
  runtimeViewHistoryScan,
  runtimeViewPageInfoFromFrame,
  runtimeViewSelectionMatches,
  setRuntimeViewActiveEntityId,
  type RuntimeViewPageInfo,
} from './runtimeViewStore';

export const REMOTE_HISTORY_VIEW_PAGE_SIZE = REMOTE_RUNTIME.HISTORY_VIEW_PAGE_SIZE;
export const REMOTE_HISTORY_SCAN_CACHE_LIMIT = REMOTE_RUNTIME.HISTORY_SCAN_CACHE_LIMIT;

export type RuntimeHistoryFrame = {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  height: number;
  timestamp: number | null;
  activeEntityId: string | null;
  pageInfo: RuntimeViewPageInfo | null;
  frame: RuntimeAdapterViewFrame;
};

export type RuntimeHistoryContext = {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  entityId: string;
  accountsPage: number;
  booksPage: number;
};

const normalizeHeight = (value: unknown): number => {
  const height = Math.floor(Number(value || 0));
  return Number.isFinite(height) && height >= 0 ? height : 0;
};

const normalizeEntityId = (value: unknown): string | null => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const normalizeTimestamp = (value: unknown): number | null => {
  const timestamp = Math.floor(Number(value));
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
};

export const runtimeHistoryFrames = writable<RuntimeHistoryFrame[]>([]);
let runtimeHistoryContextKey = '';
let runtimeHistoryScanGeneration = 0;

const normalizePage = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0));

export const createRuntimeHistoryContext = (
  input: RuntimeHistoryContext,
): RuntimeHistoryContext => ({
  runtimeId: String(input.runtimeId || '').trim().toLowerCase(),
  mode: input.mode,
  entityId: normalizeEntityId(input.entityId) || '',
  accountsPage: normalizePage(input.accountsPage),
  booksPage: normalizePage(input.booksPage),
});

const runtimeHistoryContextKeyFromContext = (input: RuntimeHistoryContext): string => {
  const context = createRuntimeHistoryContext(input);
  return [
    context.runtimeId,
    context.mode,
    context.entityId,
    context.accountsPage,
    context.booksPage,
  ].join('|');
};

export const ensureRuntimeHistoryContext = (
  input: RuntimeHistoryContext,
  endpoint = '',
): RuntimeHistoryContext => {
  const context = createRuntimeHistoryContext(input);
  const nextKey = runtimeHistoryContextKeyFromContext(context);
  if (runtimeHistoryContextKey === nextKey) return context;
  runtimeHistoryScanGeneration += 1;
  runtimeHistoryContextKey = nextKey;
  runtimeHistoryFrames.set([]);
  runtimeViewHistoryScan.set(emptyRuntimeViewHistoryScan(endpoint));
  return context;
};

export const runtimeHistoryFrameFromViewFrame = (
  input: {
    runtimeId: string;
    mode: 'embedded' | 'remote';
    frame: RuntimeAdapterViewFrame;
  },
): RuntimeHistoryFrame => {
  const frame = input.frame;
  const activeEntityId = normalizeEntityId(
    frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.activeEntity?.core?.entityId,
  );
  const height = normalizeHeight(frame.height || frame.head?.latestHeight);
  return {
    runtimeId: String(input.runtimeId || '').trim().toLowerCase(),
    mode: input.mode,
    height,
    timestamp: normalizeTimestamp(frame.activeEntity?.core?.timestamp ?? height),
    activeEntityId,
    pageInfo: runtimeViewPageInfoFromFrame(frame),
    frame,
  };
};

export const mergeRuntimeHistoryFrame = (
  frames: RuntimeHistoryFrame[],
  frame: RuntimeHistoryFrame,
  limit: number,
): RuntimeHistoryFrame[] => {
  const safeLimit = Math.max(1, Math.floor(Number(limit || 1)));
  const nextByHeight = new Map<number, RuntimeHistoryFrame>();
  for (const item of frames) {
    const height = normalizeHeight(item.height);
    if (height > 0) nextByHeight.set(height, item);
  }
  if (frame.height > 0) nextByHeight.set(frame.height, frame);
  const sorted = Array.from(nextByHeight.values()).sort((left, right) => left.height - right.height);
  return sorted.length <= safeLimit ? sorted : sorted.slice(-safeLimit);
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
  const expectedContextKey = runtimeHistoryContextKeyFromContext(context);
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
  const requestedHeight = Math.max(1, Math.floor(Number(height || 0)));
  if (!Number.isFinite(requestedHeight) || requestedHeight < 1) {
    throw new Error('Remote Time Machine height must be a positive integer');
  }
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
  runtimeViewHistoryScan.set({
    loading: true,
    error: null,
    requestedHeight,
    scannedHeight: null,
    latestHeight: null,
    framesCached: get(runtimeHistoryFrames).length,
    durationMs: null,
    accountsShown: null,
    accountsTotal: null,
    booksShown: null,
    booksTotal: null,
    endpoint: config.wsUrl || '',
  });

  try {
    const batch = await runtimeQueryClient.readHistoryFrameBatch({
      entityId: selection.entityId,
      accountsLimit: REMOTE_HISTORY_VIEW_PAGE_SIZE,
      booksLimit: REMOTE_HISTORY_VIEW_PAGE_SIZE,
      accountsPage: selection.accountsPage,
      booksPage: selection.booksPage,
      heights: [requestedHeight],
    });
    if (!requestStillCurrent()) return null;
    const frame = batch.frames.find((item) => Math.max(0, Number(item.height || 0)) === requestedHeight);
    if (!frame) {
      const unavailable = (batch.unavailable || []).find((item) => Number(item.height || 0) === requestedHeight);
      const detail = unavailable ? `${unavailable.code}: ${unavailable.message}` : 'height unavailable';
      throw new Error(`Remote Time Machine scan failed for height ${requestedHeight}: ${detail}`);
    }
    const projected = runtimeHistoryFrameFromViewFrame({
      runtimeId: adapter.runtimeId,
      mode: 'remote',
      frame,
    });
    if (selection.entityId && projected.activeEntityId !== selection.entityId) {
      throw new Error(`Remote Time Machine entity mismatch: expected ${selection.entityId}, received ${projected.activeEntityId || '<missing>'}`);
    }
    if (
      !projected.pageInfo ||
      projected.pageInfo.accountsPageIndex !== selection.accountsPage ||
      projected.pageInfo.booksPageIndex !== selection.booksPage
    ) {
      throw new Error(
        `Remote Time Machine page mismatch: expected accounts=${selection.accountsPage}, books=${selection.booksPage}`,
      );
    }
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

    const activeEntity = frame.activeEntity ?? null;
    const scannedHeight = Math.max(0, Math.floor(Number(frame.height || requestedHeight)));
    const frameIndex = projectionHistory.findIndex((item) => Math.max(0, Number(item.height || 0)) === scannedHeight);
    if (frameIndex < 0) throw new Error(`Remote Time Machine scan did not cache height ${scannedHeight}`);
    if (!requestStillCurrent()) return null;
    runtimeViewHistoryScan.set({
      loading: false,
      error: null,
      requestedHeight,
      scannedHeight,
      latestHeight: Math.max(0, Math.floor(Number(adapter.currentHeight || frame.head?.latestHeight || scannedHeight || 0))),
      framesCached: projectionHistory.length,
      durationMs: Date.now() - startedAt,
      accountsShown: activeEntity?.accounts.items.length ?? null,
      accountsTotal: activeEntity?.accounts.totalItems ?? null,
      booksShown: activeEntity?.books.items.length ?? null,
      booksTotal: activeEntity?.books.totalItems ?? null,
      endpoint: config.wsUrl || '',
    });
    return { frameIndex, snapshot: { height: scannedHeight }, frame, framesCached: projectionHistory.length };
  } catch (error) {
    if (!requestStillCurrent()) return null;
    const message = error instanceof Error ? error.message : String(error || 'Remote Time Machine scan failed');
    runtimeViewHistoryScan.set({
      loading: false,
      error: message,
      requestedHeight,
      scannedHeight: null,
      latestHeight: null,
      framesCached: get(runtimeHistoryFrames).length,
      durationMs: Date.now() - startedAt,
      accountsShown: null,
      accountsTotal: null,
      booksShown: null,
      booksTotal: null,
      endpoint: config.wsUrl || '',
    });
    throw error;
  }
};
