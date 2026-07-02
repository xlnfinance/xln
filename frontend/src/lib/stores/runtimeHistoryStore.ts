import { get, writable } from 'svelte/store';
import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
import { REMOTE_RUNTIME } from '@xln/runtime/constants';
import {
  getRuntimeControllerAdapter,
  getRuntimeControllerConfig,
} from './runtimeControllerStore';
import { runtimeQueryClient } from './runtimeQueryClient';
import {
  runtimeViewAccountsPage,
  runtimeViewActiveEntityId,
  runtimeViewBooksPage,
  runtimeViewHistoryScan,
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

const pageInfoFromFrame = (
  entityId: string | null,
  frame: RuntimeAdapterViewFrame,
): RuntimeViewPageInfo | null => {
  const active = frame.activeEntity;
  if (!active || !entityId) return null;
  return {
    entityId,
    accountsShown: active.accounts.items.length,
    accountsTotal: active.accounts.totalItems ?? active.accounts.items.length,
    accountsPageIndex: active.accounts.pageIndex ?? 0,
    accountsPageCount: active.accounts.pageCount ?? 1,
    accountsPrevCursor: active.accounts.prevCursor ?? null,
    accountsNextCursor: active.accounts.nextCursor ?? null,
    accountsHasMore: !!active.accounts.nextCursor,
    booksShown: active.books.items.length,
    booksTotal: active.books.totalItems ?? active.books.items.length,
    booksPageIndex: active.books.pageIndex ?? 0,
    booksPageCount: active.books.pageCount ?? 1,
    booksPrevCursor: active.books.prevCursor ?? null,
    booksNextCursor: active.books.nextCursor ?? null,
    booksHasMore: !!active.books.nextCursor,
  };
};

export const runtimeHistoryFrames = writable<RuntimeHistoryFrame[]>([]);

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
    pageInfo: pageInfoFromFrame(activeEntityId, frame),
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
  },
  limit: number,
): RuntimeHistoryFrame[] => {
  const nextFrame = runtimeHistoryFrameFromViewFrame(input);
  const nextFrames = mergeRuntimeHistoryFrame(get(runtimeHistoryFrames), nextFrame, limit);
  runtimeHistoryFrames.set(nextFrames);
  return nextFrames;
};

export const resetRuntimeHistoryFrames = (): void => {
  runtimeHistoryFrames.set([]);
};

export const scanRuntimeAdapterHistoryAtHeight = async (
  height: number,
): Promise<{ frameIndex: number; snapshot: { height: number }; frame: RuntimeAdapterViewFrame; framesCached: number }> => {
  const config = getRuntimeControllerConfig();
  if (!config || config.mode !== 'remote') {
    throw new Error('Remote Time Machine scan requires a remote runtime adapter');
  }
  const requestedHeight = Math.max(1, Math.floor(Number(height || 0)));
  if (!Number.isFinite(requestedHeight) || requestedHeight < 1) {
    throw new Error('Remote Time Machine height must be a positive integer');
  }

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
    const adapter = getRuntimeControllerAdapter();
    if (!adapter || adapter.mode !== 'remote') {
      throw new Error('Runtime adapter is not connected');
    }
    const activeEntityId = get(runtimeViewActiveEntityId);
    const accountsPage = get(runtimeViewAccountsPage);
    const booksPage = get(runtimeViewBooksPage);
    const batch = await runtimeQueryClient.readHistoryFrameBatch({
      entityId: activeEntityId,
      accountsLimit: REMOTE_HISTORY_VIEW_PAGE_SIZE,
      booksLimit: REMOTE_HISTORY_VIEW_PAGE_SIZE,
      accountsPage,
      booksPage,
      heights: [requestedHeight],
    });
    const frame = batch.frames.find((item) => Math.max(0, Number(item.height || 0)) === requestedHeight)
      ?? batch.frames[0];
    if (!frame) {
      const unavailable = (batch.unavailable || []).find((item) => Number(item.height || 0) === requestedHeight);
      const detail = unavailable ? `${unavailable.code}: ${unavailable.message}` : 'height unavailable';
      throw new Error(`Remote Time Machine scan failed for height ${requestedHeight}: ${detail}`);
    }
    const projectionHistory = upsertRuntimeHistoryFrame({
      runtimeId: adapter.runtimeId,
      mode: 'remote',
      frame,
    }, REMOTE_HISTORY_SCAN_CACHE_LIMIT);

    const activeEntity = frame.activeEntity ?? null;
    const scannedHeight = Math.max(0, Math.floor(Number(frame.height || requestedHeight)));
    const frameIndex = projectionHistory.findIndex((item) => Math.max(0, Number(item.height || 0)) === scannedHeight);
    if (frameIndex < 0) throw new Error(`Remote Time Machine scan did not cache height ${scannedHeight}`);
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
