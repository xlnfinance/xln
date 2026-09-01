// Framework-neutral transport model for remote Time Machine history reads.
// The Svelte adapter owns live stores, Runtime selection, request effects, and
// clocks; this module owns deterministic query, validation, and scan results.

import type {
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterReadQuery,
  RuntimeAdapterViewFrame,
} from '@xln/core/api/public/runtime-module';

import {
  runtimeViewPageInfoFromFrame,
  type RuntimeViewHistoryScanState,
  type RuntimeViewPageInfo,
} from './runtime-view-model';

export type RuntimeHistoryFrame = Readonly<{
  runtimeId: string;
  mode: 'embedded' | 'remote';
  height: number;
  timestamp: number | null;
  activeEntityId: string | null;
  pageInfo: RuntimeViewPageInfo | null;
  frame: RuntimeAdapterViewFrame;
}>;

export type RuntimeHistoryContext = Readonly<{
  runtimeId: string;
  mode: 'embedded' | 'remote';
  entityId: string;
  accountsPage: number;
  booksPage: number;
}>;

export type TimeMachineHistorySelection = Readonly<{
  entityId: string;
  accountsPage: number;
  booksPage: number;
}>;

const normalizeHistoryHeight = (value: unknown): number => {
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

const normalizePage = (value: unknown): number => Math.max(0, Math.floor(Number(value) || 0));

export const normalizeTimeMachineRequestedHeight = (value: unknown): number => {
  const height = Math.max(1, Math.floor(Number(value || 0)));
  if (!Number.isFinite(height) || height < 1) {
    throw new Error('Remote Time Machine height must be a positive integer');
  }
  return height;
};

export const createRuntimeHistoryContext = (
  input: RuntimeHistoryContext,
): RuntimeHistoryContext => ({
  runtimeId: String(input.runtimeId || '').trim().toLowerCase(),
  mode: input.mode,
  entityId: normalizeEntityId(input.entityId) || '',
  accountsPage: normalizePage(input.accountsPage),
  booksPage: normalizePage(input.booksPage),
});

export const runtimeHistoryContextKey = (input: RuntimeHistoryContext): string => {
  const context = createRuntimeHistoryContext(input);
  return [
    context.runtimeId,
    context.mode,
    context.entityId,
    context.accountsPage,
    context.booksPage,
  ].join('|');
};

export const runtimeHistoryFrameFromViewFrame = (input: {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  frame: RuntimeAdapterViewFrame;
}): RuntimeHistoryFrame => {
  const { frame } = input;
  const activeEntityId = normalizeEntityId(
    frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.activeEntity?.core?.entityId,
  );
  const height = normalizeHistoryHeight(frame.height || frame.head?.latestHeight);
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
  frames: readonly RuntimeHistoryFrame[],
  frame: RuntimeHistoryFrame,
  limit: number,
): RuntimeHistoryFrame[] => {
  const safeLimit = Math.max(1, Math.floor(Number(limit || 1)));
  const nextByHeight = new Map<number, RuntimeHistoryFrame>();
  for (const item of frames) {
    const height = normalizeHistoryHeight(item.height);
    if (height > 0) nextByHeight.set(height, item);
  }
  if (frame.height > 0) nextByHeight.set(frame.height, frame);
  const sorted = [...nextByHeight.values()].sort((left, right) => left.height - right.height);
  return sorted.length <= safeLimit ? sorted : sorted.slice(-safeLimit);
};

export const createTimeMachineHistoryBatchQuery = (
  selection: TimeMachineHistorySelection,
  requestedHeight: number,
  pageSize: number,
): RuntimeAdapterReadQuery => {
  const height = normalizeTimeMachineRequestedHeight(requestedHeight);
  const limit = Math.max(1, Math.floor(Number(pageSize || 1)));
  return {
    entityId: selection.entityId,
    accountsLimit: limit,
    booksLimit: limit,
    accountsPage: normalizePage(selection.accountsPage),
    booksPage: normalizePage(selection.booksPage),
    heights: [height],
  };
};

export const requireTimeMachineHistoryFrame = (
  batch: RuntimeAdapterHistoryFrameBatch,
  requestedHeight: number,
): RuntimeAdapterViewFrame => {
  const height = normalizeTimeMachineRequestedHeight(requestedHeight);
  const frame = batch.frames.find((item) => normalizeHistoryHeight(item.height) === height);
  if (frame) return frame;
  const unavailable = batch.unavailable.find((item) => normalizeHistoryHeight(item.height) === height);
  const detail = unavailable ? `${unavailable.code}: ${unavailable.message}` : 'height unavailable';
  throw new Error(`Remote Time Machine scan failed for height ${height}: ${detail}`);
};

export const assertTimeMachineHistorySelection = (
  frame: RuntimeHistoryFrame,
  selection: TimeMachineHistorySelection,
): void => {
  if (selection.entityId && frame.activeEntityId !== selection.entityId) {
    throw new Error(
      `Remote Time Machine entity mismatch: expected ${selection.entityId}, received ${frame.activeEntityId || '<missing>'}`,
    );
  }
  if (
    !frame.pageInfo ||
    frame.pageInfo.accountsPageIndex !== selection.accountsPage ||
    frame.pageInfo.booksPageIndex !== selection.booksPage
  ) {
    throw new Error(
      `Remote Time Machine page mismatch: expected accounts=${selection.accountsPage}, books=${selection.booksPage}`,
    );
  }
};

export const createTimeMachineScanLoadingState = (input: {
  requestedHeight: number;
  framesCached: number;
  endpoint: string;
}): RuntimeViewHistoryScanState => ({
  loading: true,
  error: null,
  requestedHeight: normalizeTimeMachineRequestedHeight(input.requestedHeight),
  scannedHeight: null,
  latestHeight: null,
  framesCached: Math.max(0, Math.floor(input.framesCached)),
  durationMs: null,
  accountsShown: null,
  accountsTotal: null,
  booksShown: null,
  booksTotal: null,
  endpoint: input.endpoint,
});

export const createTimeMachineScanSuccessState = (input: {
  requestedHeight: number;
  frame: RuntimeAdapterViewFrame;
  adapterHeight: number;
  framesCached: number;
  durationMs: number;
  endpoint: string;
}): RuntimeViewHistoryScanState => {
  const scannedHeight = normalizeHistoryHeight(input.frame.height || input.requestedHeight);
  const activeEntity = input.frame.activeEntity ?? null;
  return {
    loading: false,
    error: null,
    requestedHeight: normalizeTimeMachineRequestedHeight(input.requestedHeight),
    scannedHeight,
    latestHeight: normalizeHistoryHeight(
      input.adapterHeight || input.frame.head?.latestHeight || scannedHeight,
    ),
    framesCached: Math.max(0, Math.floor(input.framesCached)),
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    accountsShown: activeEntity?.accounts.items.length ?? null,
    accountsTotal: activeEntity?.accounts.totalItems ?? null,
    booksShown: activeEntity?.books.items.length ?? null,
    booksTotal: activeEntity?.books.totalItems ?? null,
    endpoint: input.endpoint,
  };
};

export const createTimeMachineScanFailureState = (input: {
  error: string;
  requestedHeight: number;
  framesCached: number;
  durationMs: number;
  endpoint: string;
}): RuntimeViewHistoryScanState => ({
  loading: false,
  error: input.error,
  requestedHeight: normalizeTimeMachineRequestedHeight(input.requestedHeight),
  scannedHeight: null,
  latestHeight: null,
  framesCached: Math.max(0, Math.floor(input.framesCached)),
  durationMs: Math.max(0, Math.floor(input.durationMs)),
  accountsShown: null,
  accountsTotal: null,
  booksShown: null,
  booksTotal: null,
  endpoint: input.endpoint,
});

export const getTimeMachineTransportErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Remote Time Machine scan failed');
