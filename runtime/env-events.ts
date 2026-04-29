/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to Env (like Ethereum blocks have logs).
 * Events are stored in env.frameLogs and travel with snapshots for time-travel debugging.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type { AccountFrame, AccountMachine, Env, LogCategory, FrameLogEntry, RuntimeFrameDbRecord, RuntimeOverlayRecord } from './types';
import type { BookState } from './orderbook';
import { storageOverlayRecordKey } from './storage/overlay';

const getLogState = (env: Env) => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.logState) {
    env.runtimeState.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.runtimeState.logState;
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: Env): string[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.cleanLogs) env.runtimeState.cleanLogs = [];
  return env.runtimeState.cleanLogs;
};

const addCleanLog = (env: Env, level: string, msg: string): void => {
  const ts = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const buffer = getCleanLogBuffer(env);
  buffer.push(`[${ts}] ${level}: ${msg}`);
  if (buffer.length > MAX_CLEAN_LOGS) buffer.shift();
};

const HIGH_SIGNAL_EVENTS = new Set([
  'HtlcInitiated',
  'HtlcFailed',
  'HtlcReceived',
  'HtlcFinalized',
  // J-event ingress is the canonical source-of-truth signal that an on-chain event
  // actually reached the runtime state machine. Keep it in the relay debug timeline.
  'JEventReceived',
  // J-batch submission is the matching source signal for entity -> chain transitions.
  'JBatchQueued',
  'BilateralFrameCommitted',
  'EntityFrameCommitted',
  'AccountOpening',
]);

const isCriticalMessage = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes('error') ||
    m.includes('fail') ||
    m.includes('mismatch') ||
    m.includes('decrypt') ||
    m.includes('secret') ||
    m.includes('timeout') ||
    m.includes('route-defer')
  );
};

const forwardDebugEvent = (env: Env, payload: Record<string, unknown>): void => {
  const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (data: unknown) => boolean } | undefined;
  try {
    p2p?.sendDebugEvent?.(payload);
  } catch {
    // Best effort only.
  }
};

const getPendingAuditEvents = (env: Env): Array<Record<string, unknown>> => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingAuditEvents) env.runtimeState.pendingAuditEvents = [];
  return env.runtimeState.pendingAuditEvents;
};

export const flushPendingAuditEvents = (env: Env): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!Array.isArray(pending) || pending.length === 0) return;
  for (const payload of pending) {
    forwardDebugEvent(env, payload);
  }
  pending.length = 0;
};

export const clearPendingAuditEvents = (env: Env): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.length = 0;
};

const getPendingFrameDbRecords = (env: Env): RuntimeFrameDbRecord[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingFrameDbRecords) env.runtimeState.pendingFrameDbRecords = [];
  return env.runtimeState.pendingFrameDbRecords;
};

const getOverlay = (env: Env): RuntimeOverlayRecord[] => {
  if (!env.overlay) env.overlay = [];
  return env.overlay;
};

const pushOverlayRecord = (env: Env, record: RuntimeOverlayRecord): void => {
  const overlay = getOverlay(env);
  const key = storageOverlayRecordKey(record);
  const existingIndex = overlay.findIndex((candidate) => storageOverlayRecordKey(candidate) === key);
  if (existingIndex >= 0) {
    overlay[existingIndex] = record;
  } else {
    overlay.push(record);
  }

  const runtimeState = env.runtimeState ?? (env.runtimeState = {});
  const currentMarks = runtimeState.currentStorageOverlayMarks ?? (runtimeState.currentStorageOverlayMarks = []);
  const currentIndex = currentMarks.findIndex((candidate) => storageOverlayRecordKey(candidate) === key);
  if (currentIndex >= 0) {
    currentMarks[currentIndex] = { ...record };
    return;
  }
  currentMarks.push({ ...record });
};

export const markStorageEntityDirty = (env: Env, entityId: string): void => {
  const normalized = String(entityId || '').toLowerCase();
  if (!normalized) return;
  const record: RuntimeOverlayRecord = { family: 'entity', entityId: normalized };
  pushOverlayRecord(env, record);
};

export const markStorageAccountDirty = (env: Env, entityId: string, counterpartyId: string): void => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  const normalizedCounterpartyId = String(counterpartyId || '').toLowerCase();
  if (!normalizedEntityId || !normalizedCounterpartyId) return;
  const record: RuntimeOverlayRecord = {
    family: 'account',
    entityId: normalizedEntityId,
    counterpartyId: normalizedCounterpartyId,
  };
  pushOverlayRecord(env, record);
};

export const markStorageBookDirty = (
  env: Env,
  entityId: string,
  pairId: string,
  deleted = false,
): void => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  const normalizedPairId = String(pairId || '').trim();
  if (!normalizedEntityId || !normalizedPairId) return;
  const record: RuntimeOverlayRecord = {
    family: 'book',
    entityId: normalizedEntityId,
    pairId: normalizedPairId,
    ...(deleted ? { deleted: true } : {}),
  };
  pushOverlayRecord(env, record);
};

export const ACCOUNT_FRAME_HISTORY_VIEW_LIMIT = 50;
const ACCOUNT_FRAME_HISTORY_VIEW = Symbol.for('xln.accountFrameHistoryView');
type AccountWithFrameHistoryView = AccountMachine & {
  [ACCOUNT_FRAME_HISTORY_VIEW]?: AccountFrame[];
};

const cloneFrameForView = (frame: AccountFrame): AccountFrame => structuredClone(frame);

export const setAccountFrameHistoryView = (
  account: AccountMachine,
  frames: AccountFrame[],
  limit = ACCOUNT_FRAME_HISTORY_VIEW_LIMIT,
): void => {
  const boundedLimit = Math.max(0, Math.floor(Number(limit || 0)));
  const view = boundedLimit > 0
    ? frames.slice(-boundedLimit).map((frame) => cloneFrameForView(frame))
    : [];
  Object.defineProperty(account, ACCOUNT_FRAME_HISTORY_VIEW, {
    value: view,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

export const getAccountFrameHistoryView = (account: AccountMachine): AccountFrame[] => {
  const view = (account as AccountWithFrameHistoryView)[ACCOUNT_FRAME_HISTORY_VIEW];
  return Array.isArray(view) ? view.map((frame) => cloneFrameForView(frame)) : [];
};

export const appendAccountFrameHistoryView = (
  account: AccountMachine,
  frame: AccountFrame,
  limit = ACCOUNT_FRAME_HISTORY_VIEW_LIMIT,
): void => {
  const existing = (account as AccountWithFrameHistoryView)[ACCOUNT_FRAME_HISTORY_VIEW] ?? [];
  setAccountFrameHistoryView(account, [...existing, frame], limit);
};

export const recordAccountFrameHistory = (
  env: Env,
  record: {
    entityId: string;
    counterpartyId: string;
    accountHeight: number;
    source: Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }>['source'];
    frame: AccountFrame;
  },
): void => {
  const entityId = String(record.entityId || '').toLowerCase();
  const counterpartyId = String(record.counterpartyId || '').toLowerCase();
  const accountHeight = Number(record.accountHeight || record.frame?.height || 0);
  if (!entityId || !counterpartyId || !Number.isFinite(accountHeight) || accountHeight <= 0) return;
  getPendingFrameDbRecords(env).push({
    kind: 'accountFrame',
    entityId,
    counterpartyId,
    accountHeight: Math.floor(accountHeight),
    source: record.source,
    frame: structuredClone(record.frame),
  });
  markStorageAccountDirty(env, entityId, counterpartyId);
};

export const recordOrderbookPairUpdate = (
  env: Env,
  record: {
    entityId: string;
    pairId: string;
    book?: BookState | null;
  },
): void => {
  const entityId = String(record.entityId || '').toLowerCase();
  const pairId = String(record.pairId || '').trim();
  if (!entityId || !pairId) return;
  getPendingFrameDbRecords(env).push({
    kind: 'bookUpdate',
    entityId,
    pairId,
    book: record.book ? structuredClone(record.book) : null,
  });
  markStorageBookDirty(env, entityId, pairId, !record.book);
};

export const peekPendingFrameDbRecords = (env: Env): RuntimeFrameDbRecord[] =>
  Array.isArray(env.runtimeState?.pendingFrameDbRecords)
    ? env.runtimeState.pendingFrameDbRecords.map((record) => structuredClone(record))
    : [];

export const dropPendingFrameDbRecords = (env: Env, count: number): void => {
  const pending = env.runtimeState?.pendingFrameDbRecords;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.splice(0, Math.max(0, Math.floor(count)));
};

export const dropOverlay = (env: Env, count: number): void => {
  const pending = env.overlay;
  if (!Array.isArray(pending) || pending.length === 0) return;
  if (Math.max(0, Math.floor(count)) >= pending.length) {
    env.overlay = [];
    return;
  }
  pending.splice(0, Math.max(0, Math.floor(count)));
};

/**
 * Create event emission methods for an environment.
 * Called once during env creation (createEmptyEnv).
 */
export function attachEventEmitters(env: Env): void {
  // Helper: Use env.timestamp for deterministic logs
  const getTimestamp = () => env.timestamp;
  const logState = getLogState(env);

  // Simple log (like console.log but captured)
  env.log = (message: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message,
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'LOG', message);
  };

  // Structured info log
  env.info = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'INFO', message);
    if (message.startsWith('REB_')) {
      forwardDebugEvent(env, {
        level: 'info',
        category,
        message,
        entityId,
        data,
        runtimeId: env.runtimeId,
        at: getTimestamp(),
      });
    }
  };

  // Structured warning log
  env.warn = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'warn',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'WARN', message);
    console.warn(`[${category}]`, message, data || '');
    forwardDebugEvent(env, {
      level: 'warn',
      category,
      message,
      entityId,
      data,
      runtimeId: env.runtimeId,
      at: getTimestamp(),
    });
  };

  // Structured error log
  env.error = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'error',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'ERR', message);
    console.error(`[${category}]`, message, data || '');
    forwardDebugEvent(env, {
      level: 'error',
      category,
      message,
      entityId,
      data,
      runtimeId: env.runtimeId,
      at: getTimestamp(),
    });
  };

  // Generic event emission (EVM-style)
  env.emit = (eventName: string, data: Record<string, unknown>) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message: eventName,
      data,
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'EVENT', eventName);
    if (HIGH_SIGNAL_EVENTS.has(eventName) || isCriticalMessage(eventName)) {
      getPendingAuditEvents(env).push({
        level: 'event',
        eventName,
        data,
        runtimeId: env.runtimeId,
        at: getTimestamp(),
      });
    }
  };
}

/**
 * Reset global log ID counter (for testing)
 */
export function resetLogCounter(env: Env): void {
  const logState = getLogState(env);
  logState.nextId = 0;
}
