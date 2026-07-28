/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to RuntimeState (like Ethereum blocks have logs).
 * Events are stored in env.frameLogs and travel with snapshots for time-travel debugging.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type {
  AccountFrame,
  AccountState,
  CertifiedEntityFrameLink,
  EntityState,
  EntityCandidateEffect,
  RuntimeState,
  LogCategory,
  FrameLogEntry,
  RuntimeFrameDbRecord,
  RuntimeOverlayRecord,
} from '../types';
import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';
import { storageOverlayRecordKey } from '../storage/overlay';
import { invalidateEntityAccountCommitment } from '../entity/consensus/state-root';

const getLogState = (env: RuntimeState) => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.logState) {
    env.runtimeState.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.runtimeState.logState;
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: RuntimeState): string[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.cleanLogs) env.runtimeState.cleanLogs = [];
  return env.runtimeState.cleanLogs;
};

const addCleanLog = (env: RuntimeState, level: string, msg: string): void => {
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

const forwardDebugEvent = (env: RuntimeState, payload: Record<string, unknown>): void => {
  const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (data: unknown) => boolean } | undefined;
  try {
    p2p?.sendDebugEvent?.(payload);
  } catch (error) {
    console.warn('[runtime-audit] debug event delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const getPendingAuditEvents = (env: RuntimeState): Array<Record<string, unknown>> => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingAuditEvents) env.runtimeState.pendingAuditEvents = [];
  return env.runtimeState.pendingAuditEvents;
};

const queuePendingAuditEvent = (env: RuntimeState, payload: Record<string, unknown>): void => {
  const pending = getPendingAuditEvents(env);
  const encoded = encodeCanonicalEntityConsensusValue(payload);
  if (pending.some((candidate) => encodeCanonicalEntityConsensusValue(candidate) === encoded)) return;
  pending.push(structuredClone(payload));
};

const appendFrameLog = (
  env: RuntimeState,
  entry: Omit<FrameLogEntry, 'id' | 'timestamp'>,
  cleanLevel: string,
): void => {
  const logState = getLogState(env);
  env.frameLogs.push({
    id: logState.nextId++,
    timestamp: env.timestamp,
    ...entry,
  });
  addCleanLog(env, cleanLevel, entry.message);
};

const queueStructuredAuditEvent = (
  env: RuntimeState,
  level: 'info' | 'warn' | 'error',
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  entityId?: string,
): void => {
  queuePendingAuditEvent(env, {
    level,
    category,
    message,
    entityId,
    data,
    runtimeId: env.runtimeId,
    at: env.timestamp,
  });
};

const attachStructuredLogger = (
  env: RuntimeState,
  level: 'info' | 'warn' | 'error',
  cleanLevel: 'INFO' | 'WARN' | 'ERR',
) => (
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  entityId?: string,
): void => {
  appendFrameLog(env, {
    level,
    category,
    message,
    ...(entityId && { entityId }),
    ...(data && { data }),
  }, cleanLevel);

  if (level === 'warn') console.warn(`[${category}]`, message, data || '');
  if (level === 'error') console.error(`[${category}]`, message, data || '');
  if (level !== 'info' || message.startsWith('REB_')) {
    queueStructuredAuditEvent(env, level, category, message, data, entityId);
  }
};

export const flushPendingAuditEvents = (env: RuntimeState): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!Array.isArray(pending) || pending.length === 0) return;
  for (const payload of pending) {
    forwardDebugEvent(env, payload);
  }
  pending.length = 0;
};

export const clearPendingAuditEvents = (env: RuntimeState): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.length = 0;
};

const getPendingFrameDbRecords = (env: RuntimeState): RuntimeFrameDbRecord[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingFrameDbRecords) env.runtimeState.pendingFrameDbRecords = [];
  return env.runtimeState.pendingFrameDbRecords;
};

const getOverlay = (env: RuntimeState): RuntimeOverlayRecord[] => {
  if (!env.overlay) env.overlay = [];
  return env.overlay;
};

const pushOverlayRecord = (env: RuntimeState, record: RuntimeOverlayRecord): void => {
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

const markStorageEntityDirty = (env: RuntimeState, entityId: string): void => {
  const normalized = String(entityId || '').toLowerCase();
  if (!normalized) return;
  const record: RuntimeOverlayRecord = { family: 'entity', entityId: normalized };
  pushOverlayRecord(env, record);
};

const markStorageAccountDirty = (env: RuntimeState, entityId: string, counterpartyId: string): void => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  const normalizedCounterpartyId = String(counterpartyId || '').toLowerCase();
  if (!normalizedEntityId || !normalizedCounterpartyId) return;
  for (const replica of env.eReplicas.values()) {
    if (replica.entityId.toLowerCase() === normalizedEntityId) {
      invalidateEntityAccountCommitment(replica.state, normalizedCounterpartyId);
    }
  }
  const record: RuntimeOverlayRecord = {
    family: 'account',
    entityId: normalizedEntityId,
    counterpartyId: normalizedCounterpartyId,
  };
  pushOverlayRecord(env, record);
};

const markStorageBookDirty = (
  env: RuntimeState,
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

export const applyRuntimeStorageChanges = (
  env: RuntimeState,
  changes: readonly RuntimeOverlayRecord[],
): void => {
  for (const change of changes) {
    if (change.family === 'entity') {
      markStorageEntityDirty(env, change.entityId);
    } else if (change.family === 'account') {
      markStorageAccountDirty(env, change.entityId, change.counterpartyId);
    } else {
      markStorageBookDirty(env, change.entityId, change.pairId, change.deleted === true);
    }
  }
};

export const applyStorageChanges = (
  env: RuntimeState,
  state: EntityState,
  changes: readonly RuntimeOverlayRecord[],
): void => {
  for (const change of changes) {
    if (change.family === 'account' && change.entityId.toLowerCase() === state.entityId.toLowerCase()) {
      invalidateEntityAccountCommitment(state, change.counterpartyId);
    }
  }
  applyRuntimeStorageChanges(env, changes);
};

// AccountState already owns currentFrame and pendingFrame. Historical frames
// are written to the frame DB and loaded explicitly by inspection APIs.
export const ACCOUNT_FRAME_HISTORY_VIEW_LIMIT = 0;
const ACCOUNT_FRAME_HISTORY_VIEW = Symbol.for('xln.accountFrameHistoryView');
type AccountWithFrameHistoryView = AccountState & {
  [ACCOUNT_FRAME_HISTORY_VIEW]?: AccountFrame[];
};

const cloneFrameForView = (frame: AccountFrame): AccountFrame => structuredClone(frame);

export const setAccountFrameHistoryView = (
  account: AccountState,
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

export const getAccountFrameHistoryView = (account: AccountState): AccountFrame[] => {
  const view = (account as AccountWithFrameHistoryView)[ACCOUNT_FRAME_HISTORY_VIEW];
  return Array.isArray(view) ? view.map((frame) => cloneFrameForView(frame)) : [];
};

export const appendAccountFrameHistoryView = (
  account: AccountState,
  frame: AccountFrame,
  limit = ACCOUNT_FRAME_HISTORY_VIEW_LIMIT,
): void => {
  const existing = (account as AccountWithFrameHistoryView)[ACCOUNT_FRAME_HISTORY_VIEW] ?? [];
  setAccountFrameHistoryView(account, [...existing, frame], limit);
};

export const recordAccountFrameHistory = (
  env: RuntimeState,
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
  const pending = getPendingFrameDbRecords(env);
  const existing = pending.find((candidate): candidate is Extract<RuntimeFrameDbRecord, { kind: 'accountFrame' }> => (
    candidate.kind === 'accountFrame' &&
    candidate.entityId === entityId &&
    candidate.counterpartyId === counterpartyId &&
    candidate.accountHeight === Math.floor(accountHeight) &&
    candidate.source === record.source
  ));
  if (existing) {
    if (
      encodeCanonicalEntityConsensusValue(existing.frame) !==
      encodeCanonicalEntityConsensusValue(record.frame)
    ) {
      throw new Error(
        `FRAME_DB_ACCOUNT_FRAME_FORK:entity=${entityId}:counterparty=${counterpartyId}:height=${accountHeight}`,
      );
    }
    return;
  }
  pending.push({
    kind: 'accountFrame',
    entityId,
    counterpartyId,
    accountHeight: Math.floor(accountHeight),
    source: record.source,
    frame: structuredClone(record.frame),
  });
  applyRuntimeStorageChanges(env, [{ family: 'account', entityId, counterpartyId }]);
};

export const publishEntityCandidateEffects = (
  env: RuntimeState,
  effects: readonly EntityCandidateEffect[],
): void => {
  for (const effect of effects) {
    if (effect.kind === 'accountFrameHistory') {
      recordAccountFrameHistory(env, effect);
    } else if (effect.kind === 'runtimeEvent') {
      env.emit(effect.eventName, effect.data);
    } else {
      queuePendingAuditEvent(env, effect.payload);
    }
  }
};

export const recordEntityFrameHistory = (
  env: RuntimeState,
  record: { entityId: string; link: CertifiedEntityFrameLink },
): void => {
  const entityId = String(record.entityId || '').toLowerCase();
  const entityHeight = Number(record.link?.frame?.height ?? 0);
  if (!entityId || !Number.isSafeInteger(entityHeight) || entityHeight <= 0) {
    throw new Error(`FRAME_DB_ENTITY_FRAME_IDENTITY_INVALID:${entityId}:${String(entityHeight)}`);
  }
  const pending = getPendingFrameDbRecords(env);
  const existing = pending.find((candidate): candidate is Extract<RuntimeFrameDbRecord, { kind: 'entityFrame' }> => (
    candidate.kind === 'entityFrame' &&
    candidate.entityId === entityId &&
    candidate.entityHeight === entityHeight
  ));
  if (existing) {
    if (existing.link.frame.hash !== record.link.frame.hash) {
      throw new Error(
        `FRAME_DB_ENTITY_FRAME_FORK:entity=${entityId}:height=${entityHeight}:` +
        `existing=${existing.link.frame.hash}:incoming=${record.link.frame.hash}`,
      );
    }
    if (
      encodeCanonicalEntityConsensusValue(record.link) <
      encodeCanonicalEntityConsensusValue(existing.link)
    ) {
      existing.link = structuredClone(record.link);
    }
    return;
  }
  pending.push({
    kind: 'entityFrame',
    entityId,
    entityHeight,
    link: structuredClone(record.link),
  });
  applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
};

export const peekPendingFrameDbRecords = (
  env: RuntimeState,
  runtimeHeight?: number,
  timestamp?: number,
): RuntimeFrameDbRecord[] => {
  const pending = env.runtimeState?.pendingFrameDbRecords;
  if (!Array.isArray(pending) || pending.length === 0) return [];
  const stampedHeight = Number.isFinite(runtimeHeight)
    ? Math.max(0, Math.floor(Number(runtimeHeight)))
    : null;
  const stampedTimestamp = Number.isFinite(timestamp)
    ? Math.max(0, Math.floor(Number(timestamp)))
    : null;
  for (const record of pending) {
    if (record.runtimeHeight === undefined && stampedHeight !== null) record.runtimeHeight = stampedHeight;
    if (record.timestamp === undefined && stampedTimestamp !== null) record.timestamp = stampedTimestamp;
  }
  return pending.map((record) => structuredClone(record));
};

export const dropPendingFrameDbRecords = (env: RuntimeState, count: number): void => {
  const pending = env.runtimeState?.pendingFrameDbRecords;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.splice(0, Math.max(0, Math.floor(count)));
};

export const dropOverlay = (env: RuntimeState, count: number): void => {
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
export function attachEventEmitters(env: RuntimeState): void {
  env.log = (message: string) => {
    appendFrameLog(env, {
      level: 'info',
      category: 'system',
      message,
    }, 'LOG');
  };

  env.info = attachStructuredLogger(env, 'info', 'INFO');
  env.warn = attachStructuredLogger(env, 'warn', 'WARN');
  env.error = attachStructuredLogger(env, 'error', 'ERR');

  env.emit = (eventName: string, data: Record<string, unknown>) => {
    appendFrameLog(env, {
      level: 'info',
      category: 'system',
      message: eventName,
      data,
    }, 'EVENT');
    if (HIGH_SIGNAL_EVENTS.has(eventName) || isCriticalMessage(eventName)) {
      queuePendingAuditEvent(env, {
        level: 'event',
        eventName,
        data,
        runtimeId: env.runtimeId,
        at: env.timestamp,
      });
    }
  };
}

/**
 * Reset global log ID counter (for testing)
 */
export function resetLogCounter(env: RuntimeState): void {
  const logState = getLogState(env);
  logState.nextId = 0;
}
