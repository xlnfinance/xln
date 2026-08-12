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
import type {
  CertifiedEntityFrameLink,
  EntityCandidateEffect,
  EntityReplica,
  EntityState,
} from '../entity/types';
import type { RuntimeReplica, RuntimeHistoryRecord } from './types';
import type { LogCategory, FrameLogEntry } from '../types/logging';

import { storageOverlayRecordKey } from '../protocol/overlay';
import { invalidateEntityAccountCommitment } from '../entity/consensus/state-root';
import { refreshAccountWorkIndex } from '../entity/consensus/account/work-index';
import {
  consumeHtlcRuntimeEvent,
  indexCertifiedEntityFrameNotes,
} from '../entity/htlc/note-index';
import { recordRuntimeSecurityIncident, resolveRuntimeSecurityIncident } from './security-incidents';

const getLogState = (env: RuntimeReplica) => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.logState) {
    env.infrastructure.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.infrastructure.logState;
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: RuntimeReplica): string[] => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.cleanLogs) env.infrastructure.cleanLogs = [];
  return env.infrastructure.cleanLogs;
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
  const p2p = env.infrastructure?.p2p as { sendDebugEvent?: (data: unknown) => boolean } | undefined;
  try {
    p2p?.sendDebugEvent?.(payload);
  } catch (error) {
    console.warn('[runtime-audit] debug event delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const getPendingAuditEvents = (env: RuntimeReplica): Map<string, Record<string, unknown>> => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.pendingAuditEvents) env.infrastructure.pendingAuditEvents = new Map();
  return env.infrastructure.pendingAuditEvents;
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
  const pending = env.infrastructure?.pendingAuditEvents;
  if (!(pending instanceof Map) || pending.size === 0) return;
  for (const payload of pending.values()) {
    forwardDebugEvent(env, payload);
  }
  pending.clear();
};

export const clearPendingAuditEvents = (env: RuntimeReplica): void => {
  const pending = env.infrastructure?.pendingAuditEvents;
  if (!(pending instanceof Map) || pending.size === 0) return;
  pending.clear();
};

const getPendingHistoryRecords = (env: RuntimeReplica): RuntimeHistoryRecord[] => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.pendingHistoryRecords) env.infrastructure.pendingHistoryRecords = [];
  return env.infrastructure.pendingHistoryRecords;
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

  const infrastructure = env.infrastructure ?? (env.infrastructure = {});
  const currentMarks = infrastructure.currentStorageOverlayMarks ?? (infrastructure.currentStorageOverlayMarks = []);
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

const applyEntityStorageChanges = (
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
      candidate.accountHeight === Math.floor(accountHeight),
  );
  if (existing) {
    if (encodeCanonicalConsensusValue(existing.frame) !== encodeCanonicalConsensusValue(record.frame)) {
      throw new Error(
        `CERTIFIED_ACCOUNT_FRAME_FORK:entity=${entityId}:counterparty=${counterpartyId}:height=${accountHeight}`,
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
  env: RuntimeReplica,
  sourceReplica: EntityReplica | null,
  effects: readonly EntityCandidateEffect[],
): void => {
  const resolveHistoryReplica = (
    effect: Extract<EntityCandidateEffect, { kind: 'entityFrameHistory' }>,
  ): EntityReplica => {
    if (
      !sourceReplica
      || sourceReplica.entityId.toLowerCase() !== effect.entityId.toLowerCase()
      || sourceReplica.signerId.toLowerCase() !== effect.signerId.toLowerCase()
    ) {
      throw new Error(
        `ENTITY_FRAME_HISTORY_REPLICA_MISSING:entity=${effect.entityId}:signer=${effect.signerId}`,
      );
    }
    return sourceReplica;
  };

  // Effects from several Entity transitions share one atomic Runtime frame,
  // but their append order is not a presentation contract. Index every
  // certified frame before emitting any Runtime event so a terminal HTLC event
  // can recover its private invoice note even when the matching history effect
  // appears later in this batch. Reading ingress instead would be unsafe: an
  // uncommitted request must never become observable metadata.
  for (const effect of effects) {
    if (effect.kind !== 'entityFrameHistory') continue;
    const replica = resolveHistoryReplica(effect);
    indexCertifiedEntityFrameNotes(replica, effect.link.frame);
  }

  for (const effect of effects) {
    if (effect.kind === 'entityFrameHistory') {
      resolveHistoryReplica(effect);
      recordEntityFrameHistory(env, effect);
    } else if (effect.kind === 'accountFrameHistory') {
      recordAccountFrameHistory(env, effect);
    } else if (effect.kind === 'runtimeEvent') {
      const eventEntityId =
        typeof effect.data['entityId'] === 'string'
          ? effect.data['entityId'].toLowerCase()
          : null;
      // The caller has just applied this exact replica. Never infer event
      // ownership by scanning siblings: one Runtime may host several validator
      // replicas for the same Entity, and choosing by entityId would make local
      // metadata depend on Map cardinality and iteration order.
      const eventReplica =
        sourceReplica && (!eventEntityId || sourceReplica.entityId.toLowerCase() === eventEntityId)
          ? sourceReplica
          : null;
      env.emit(
        effect.eventName,
        eventReplica
          ? consumeHtlcRuntimeEvent(eventReplica, effect.eventName, effect.data)
          : effect.data,
      );
    } else if (effect.kind === 'securityIncidentRecord') {
      recordRuntimeSecurityIncident(env, effect.identity);
    } else if (effect.kind === 'securityIncidentResolve') {
      resolveRuntimeSecurityIncident(env, effect.identity);
    } else {
      queuePendingAuditEvent(env, effect.payload);
    }
  }
};

const recordEntityFrameHistory = (
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
  const pending = env.infrastructure?.pendingHistoryRecords;
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
  const pending = env.infrastructure?.pendingHistoryRecords;
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
