import { encodeCanonicalConsensusValue } from '../protocol/canonical-consensus-value';
/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to RuntimeReplica (like Ethereum blocks have logs).
 * Events are stored in env.frameLogs and travel with snapshots for time-travel debugging.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type { AccountFrame, RuntimeOverlayRecord } from '../types/account';
import type { CertifiedEntityFrameLink, EntityState, EntityCandidateEffect } from '../entity/types';
import type { RuntimeReplica, RuntimeHistoryRecord } from './types';
import type { LogCategory, FrameLogEntry } from '../types/logging';

import { storageOverlayRecordKey } from '../protocol/overlay';
import { invalidateEntityAccountCommitment } from '../entity/consensus/state-root';
import { refreshAccountWorkIndex } from '../entity/consensus/account-work-index';
import { recordRuntimeSecurityIncident, resolveRuntimeSecurityIncident } from './security-incidents';

const getLogState = (env: RuntimeReplica) => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.logState) {
    env.runtimeState.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.runtimeState.logState;
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: RuntimeReplica): string[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.cleanLogs) env.runtimeState.cleanLogs = [];
  return env.runtimeState.cleanLogs;
};

const addCleanLog = (env: RuntimeReplica, level: string, msg: string): void => {
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

const forwardDebugEvent = (env: RuntimeReplica, payload: Record<string, unknown>): void => {
  const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (data: unknown) => boolean } | undefined;
  try {
    p2p?.sendDebugEvent?.(payload);
  } catch (error) {
    console.warn('[runtime-audit] debug event delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const getPendingAuditEvents = (env: RuntimeReplica): Map<string, Record<string, unknown>> => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingAuditEvents) env.runtimeState.pendingAuditEvents = new Map();
  return env.runtimeState.pendingAuditEvents;
};

const queuePendingAuditEvent = (env: RuntimeReplica, payload: Record<string, unknown>): void => {
  const pending = getPendingAuditEvents(env);
  const key = encodeCanonicalConsensusValue(payload);
  if (!pending.has(key)) pending.set(key, structuredClone(payload));
};

const appendFrameLog = (
  env: RuntimeReplica,
  entry: Omit<FrameLogEntry, 'id' | 'timestamp'>,
  cleanLevel: string,
): void => {
  const logState = getLogState(env);
  env.frameLogs.push({
    id: logState.nextId++,
    timestamp: env.state.timestamp,
    ...entry,
  });
  addCleanLog(env, cleanLevel, entry.message);
};

const queueStructuredAuditEvent = (
  env: RuntimeReplica,
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
    at: env.state.timestamp,
  });
};

const attachStructuredLogger =
  (env: RuntimeReplica, level: 'info' | 'warn' | 'error', cleanLevel: 'INFO' | 'WARN' | 'ERR') =>
  (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string): void => {
    appendFrameLog(
      env,
      {
        level,
        category,
        message,
        ...(entityId && { entityId }),
        ...(data && { data }),
      },
      cleanLevel,
    );

    if (level === 'warn') console.warn(`[${category}]`, message, data || '');
    if (level === 'error') console.error(`[${category}]`, message, data || '');
    if (level !== 'info' || message.startsWith('REB_')) {
      queueStructuredAuditEvent(env, level, category, message, data, entityId);
    }
  };

export const flushPendingAuditEvents = (env: RuntimeReplica): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!(pending instanceof Map) || pending.size === 0) return;
  for (const payload of pending.values()) {
    forwardDebugEvent(env, payload);
  }
  pending.clear();
};

export const clearPendingAuditEvents = (env: RuntimeReplica): void => {
  const pending = env.runtimeState?.pendingAuditEvents;
  if (!(pending instanceof Map) || pending.size === 0) return;
  pending.clear();
};

const getPendingHistoryRecords = (env: RuntimeReplica): RuntimeHistoryRecord[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.pendingHistoryRecords) env.runtimeState.pendingHistoryRecords = [];
  return env.runtimeState.pendingHistoryRecords;
};

const getOverlay = (env: RuntimeReplica): RuntimeOverlayRecord[] => {
  if (!env.overlay) env.overlay = [];
  return env.overlay;
};

const pushOverlayRecord = (env: RuntimeReplica, record: RuntimeOverlayRecord): void => {
  const overlay = getOverlay(env);
  const key = storageOverlayRecordKey(record);
  const existingIndex = overlay.findIndex(candidate => storageOverlayRecordKey(candidate) === key);
  if (existingIndex >= 0) {
    overlay[existingIndex] = record;
  } else {
    overlay.push(record);
  }

  const runtimeState = env.runtimeState ?? (env.runtimeState = {});
  const currentMarks = runtimeState.currentStorageOverlayMarks ?? (runtimeState.currentStorageOverlayMarks = []);
  const currentIndex = currentMarks.findIndex(candidate => storageOverlayRecordKey(candidate) === key);
  if (currentIndex >= 0) {
    currentMarks[currentIndex] = { ...record };
    return;
  }
  currentMarks.push({ ...record });
};

const markStorageEntityDirty = (env: RuntimeReplica, entityId: string): void => {
  const normalized = String(entityId || '').toLowerCase();
  if (!normalized) return;
  const record: RuntimeOverlayRecord = { family: 'entity', entityId: normalized };
  pushOverlayRecord(env, record);
};

const markStorageAccountDirty = (env: RuntimeReplica, entityId: string, counterpartyId: string): void => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  const normalizedCounterpartyId = String(counterpartyId || '').toLowerCase();
  if (!normalizedEntityId || !normalizedCounterpartyId) return;
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() === normalizedEntityId) {
      invalidateEntityAccountCommitment(replica.state, normalizedCounterpartyId);
      refreshAccountWorkIndex(replica.state, normalizedCounterpartyId);
    }
  }
  const record: RuntimeOverlayRecord = {
    family: 'account',
    entityId: normalizedEntityId,
    counterpartyId: normalizedCounterpartyId,
  };
  pushOverlayRecord(env, record);
};

const markStorageBookDirty = (env: RuntimeReplica, entityId: string, pairId: string, deleted = false): void => {
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

export const applyRuntimeStorageChanges = (env: RuntimeReplica, changes: readonly RuntimeOverlayRecord[]): void => {
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

export const applyEntityStorageChanges = (
  state: EntityState,
  changes: readonly RuntimeOverlayRecord[],
): void => {
  for (const change of changes) {
    if (change.family === 'account' && change.entityId.toLowerCase() === state.entityId.toLowerCase()) {
      invalidateEntityAccountCommitment(state, change.counterpartyId);
      refreshAccountWorkIndex(state, change.counterpartyId);
    }
  }
};

export const applyStorageChanges = (
  env: RuntimeReplica,
  state: EntityState,
  changes: readonly RuntimeOverlayRecord[],
): void => {
  applyEntityStorageChanges(state, changes);
  applyRuntimeStorageChanges(env, changes);
};

export const recordAccountFrameHistory = (
  env: RuntimeReplica,
  record: {
    entityId: string;
    counterpartyId: string;
    accountHeight: number;
    source: Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }>['source'];
    frame: AccountFrame;
  },
): void => {
  const entityId = String(record.entityId || '').toLowerCase();
  const counterpartyId = String(record.counterpartyId || '').toLowerCase();
  const accountHeight = Number(record.accountHeight || record.frame?.height || 0);
  if (!entityId || !counterpartyId || !Number.isFinite(accountHeight) || accountHeight <= 0) return;
  const pending = getPendingHistoryRecords(env);
  const existing = pending.find(
    (candidate): candidate is Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }> =>
      candidate.kind === 'accountFrame' &&
      candidate.entityId === entityId &&
      candidate.counterpartyId === counterpartyId &&
      candidate.accountHeight === Math.floor(accountHeight) &&
      candidate.source === record.source,
  );
  if (existing) {
    if (encodeCanonicalConsensusValue(existing.frame) !== encodeCanonicalConsensusValue(record.frame)) {
      throw new Error(
        `HISTORY_VIEW_ACCOUNT_FRAME_FORK:entity=${entityId}:counterparty=${counterpartyId}:height=${accountHeight}`,
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

export const publishEntityCandidateEffects = (env: RuntimeReplica, effects: readonly EntityCandidateEffect[]): void => {
  for (const effect of effects) {
    if (effect.kind === 'entityFrameHistory') {
      recordEntityFrameHistory(env, effect);
    } else if (effect.kind === 'accountFrameHistory') {
      recordAccountFrameHistory(env, effect);
    } else if (effect.kind === 'runtimeEvent') {
      env.emit(effect.eventName, effect.data);
    } else if (effect.kind === 'securityIncidentRecord') {
      recordRuntimeSecurityIncident(env, effect.identity);
    } else if (effect.kind === 'securityIncidentResolve') {
      resolveRuntimeSecurityIncident(env, effect.identity);
    } else {
      queuePendingAuditEvent(env, effect.payload);
    }
  }
};

export const recordEntityFrameHistory = (
  env: RuntimeReplica,
  record: { entityId: string; link: CertifiedEntityFrameLink },
): void => {
  const entityId = String(record.entityId || '').toLowerCase();
  const entityHeight = Number(record.link?.frame?.height ?? 0);
  if (!entityId || !Number.isSafeInteger(entityHeight) || entityHeight <= 0) {
    throw new Error(`HISTORY_VIEW_ENTITY_FRAME_IDENTITY_INVALID:${entityId}:${String(entityHeight)}`);
  }
  const pending = getPendingHistoryRecords(env);
  const existing = pending.find(
    (candidate): candidate is Extract<RuntimeHistoryRecord, { kind: 'entityFrame' }> =>
      candidate.kind === 'entityFrame' && candidate.entityId === entityId && candidate.entityHeight === entityHeight,
  );
  if (existing) {
    if (existing.link.frame.hash !== record.link.frame.hash) {
      throw new Error(
        `HISTORY_VIEW_ENTITY_FRAME_FORK:entity=${entityId}:height=${entityHeight}:` +
          `existing=${existing.link.frame.hash}:incoming=${record.link.frame.hash}`,
      );
    }
    if (encodeCanonicalConsensusValue(record.link) < encodeCanonicalConsensusValue(existing.link)) {
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

export const peekPendingHistoryRecords = (
  env: RuntimeReplica,
  runtimeHeight?: number,
  timestamp?: number,
): RuntimeHistoryRecord[] => {
  const pending = env.runtimeState?.pendingHistoryRecords;
  if (!Array.isArray(pending) || pending.length === 0) return [];
  const stampedHeight = Number.isFinite(runtimeHeight) ? Math.max(0, Math.floor(Number(runtimeHeight))) : null;
  const stampedTimestamp = Number.isFinite(timestamp) ? Math.max(0, Math.floor(Number(timestamp))) : null;
  for (const record of pending) {
    if (record.runtimeHeight === undefined && stampedHeight !== null) record.runtimeHeight = stampedHeight;
    if (record.timestamp === undefined && stampedTimestamp !== null) record.timestamp = stampedTimestamp;
  }
  return pending.map(record => structuredClone(record));
};

export const dropPendingHistoryRecords = (env: RuntimeReplica, count: number): void => {
  const pending = env.runtimeState?.pendingHistoryRecords;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.splice(0, Math.max(0, Math.floor(count)));
};

export const dropOverlay = (env: RuntimeReplica, count: number): void => {
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
export function attachEventEmitters(env: RuntimeReplica): void {
  env.log = (message: string) => {
    appendFrameLog(
      env,
      {
        level: 'info',
        category: 'system',
        message,
      },
      'LOG',
    );
  };

  env.info = attachStructuredLogger(env, 'info', 'INFO');
  env.warn = attachStructuredLogger(env, 'warn', 'WARN');
  env.error = attachStructuredLogger(env, 'error', 'ERR');

  env.emit = (eventName: string, data: Record<string, unknown>) => {
    appendFrameLog(
      env,
      {
        level: 'info',
        category: 'system',
        message: eventName,
        data,
      },
      'EVENT',
    );
    // `emit` means a committed machine fact, so every event belongs in the
    // Runtime event stream. Importance-by-name heuristics are both lossy and
    // brittle: adding a new event must not require updating a second table.
    // Operational debug logs use the structured logger methods instead.
    queuePendingAuditEvent(env, {
      level: 'event',
      eventName,
      data,
      runtimeId: env.runtimeId,
      at: env.state.timestamp,
    });
  };
}
