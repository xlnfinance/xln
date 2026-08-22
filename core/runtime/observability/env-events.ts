import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to RuntimeReplica (like Ethereum blocks have logs).
 * Events are buffered only for the active Runtime frame. WAL persists that
 * one frame's activity atomically; history readers reconstruct timelines from
 * storage instead of retaining them on RuntimeReplica.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type { AccountFrame, RuntimeOverlayRecord } from '../../types/account';
import type {
  CertifiedEntityFrameLink,
  EntityCandidateEffect,
  EntityReplica,
  EntityState,
} from '../../entity/types';
import type { RuntimeReplica, RuntimeHistoryRecord } from '../types';
import type { LogCategory, FrameLogEntry } from '../../types/logging';

import { storageOverlayRecordKey } from '../../protocol/state/overlay';
import { invalidateEntityAccountCommitment } from '../../entity/consensus/state-root';
import { accountFrameWithoutPostCommitHankos } from '../../account/settlement/witness-projection';
import {
  consumeHtlcRuntimeEvent,
  indexCertifiedEntityFrameNotes,
} from '../../entity/htlc/note-index';
import { recordRuntimeSecurityIncident, resolveRuntimeSecurityIncident } from './security-incidents';
import { ENV_REPLAY_MODE_KEY, readRuntimeMetadata } from '../loop/loop-environment';

const getLogState = (env: RuntimeReplica) => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.logState) {
    env.infrastructure.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.infrastructure.logState;
};

const getFrameEvents = (env: RuntimeReplica): FrameLogEntry[] => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.frameEvents) env.infrastructure.frameEvents = [];
  return env.infrastructure.frameEvents;
};

/** Read a detached copy so callers cannot mutate the active frame buffer. */
export const readRuntimeFrameEvents = (env: RuntimeReplica): FrameLogEntry[] =>
  getFrameEvents(env).map(entry => ({ ...entry }));

/** Remove only events produced after a known frame boundary. */
export const truncateRuntimeFrameEvents = (env: RuntimeReplica, length: number): void => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`RUNTIME_FRAME_EVENT_LENGTH_INVALID:${String(length)}`);
  }
  getFrameEvents(env).length = Math.min(length, getFrameEvents(env).length);
};

/** Clear a frame buffer after durable commit, recovery, or an explicit scenario reset. */
export const clearRuntimeFrameEvents = (env: RuntimeReplica): void => {
  getFrameEvents(env).length = 0;
};

/** Install explicit events for a synthetic frame fixture; never restores history. */
export const replaceRuntimeFrameEvents = (
  env: RuntimeReplica,
  events: readonly FrameLogEntry[],
): void => {
  const buffer = getFrameEvents(env);
  buffer.splice(0, buffer.length, ...events.map(entry => ({ ...entry })));
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: RuntimeReplica): string[] => {
  if (!env.infrastructure) env.infrastructure = {};
  if (!env.infrastructure.cleanLogs) env.infrastructure.cleanLogs = [];
  return env.infrastructure.cleanLogs;
};

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));
/** `HH:MM:SS.mmm` local time; `toLocaleTimeString` costs a locale lookup per log line. */
const cleanLogTimestamp = (): string => {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
};

const addCleanLog = (env: RuntimeReplica, level: string, msg: string): void => {
  const ts = cleanLogTimestamp();
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
  getFrameEvents(env).push({
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
    if (level !== 'info') {
      queueStructuredAuditEvent(env, level, category, message, data, entityId);
    }
  };

export const flushPendingAuditEvents = (env: RuntimeReplica): void => {
  const pending = env.infrastructure?.pendingAuditEvents;
  if (!(pending instanceof Map) || pending.size === 0) return;
  // One signed relay frame per Runtime frame; the relay only meters these.
  forwardDebugEvent(env, { code: 'RUNTIME_AUDIT_BATCH', events: [...pending.values()] });
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

const getOverlay = (env: RuntimeReplica): Map<string, RuntimeOverlayRecord> => {
  if (!(env.overlay instanceof Map)) env.overlay = new Map();
  return env.overlay;
};

const pushOverlayRecord = (env: RuntimeReplica, record: RuntimeOverlayRecord): void => {
  const overlay = getOverlay(env);
  const key = storageOverlayRecordKey(record);
  overlay.set(key, record);

  const infrastructure = env.infrastructure ?? (env.infrastructure = {});
  const currentMarks = infrastructure.currentStorageOverlayMarks instanceof Map
    ? infrastructure.currentStorageOverlayMarks
    : (infrastructure.currentStorageOverlayMarks = new Map());
  currentMarks.set(key, { ...record });
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
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    applyRuntimeStorageChanges(env, [{ family: 'account', entityId, counterpartyId }]);
    return;
  }
  // History is the certified semantic chain. Quorum witnesses are retained in
  // EntityReplica.hankoWitness; persisting their non-unique byte encodings in
  // the frame record would manufacture forks between honest threshold subsets.
  const canonicalFrame = accountFrameWithoutPostCommitHankos(record.frame);
  const pending = getPendingHistoryRecords(env);
  const existing = pending.find(
    (candidate): candidate is Extract<RuntimeHistoryRecord, { kind: 'accountFrame' }> =>
      candidate.kind === 'accountFrame' &&
      candidate.entityId === entityId &&
      candidate.counterpartyId === counterpartyId &&
      candidate.accountHeight === Math.floor(accountHeight),
  );
  if (existing) {
    if (encodeCanonicalConsensusValue(existing.frame) !== encodeCanonicalConsensusValue(canonicalFrame)) {
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
    frame: canonicalFrame,
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
      // Informational candidate traces (currently REB_STEP) are local
      // diagnostics, not a second network event stream. Relay only actionable
      // audit levels; committed machine facts already live in Runtime history.
      if (effect.payload['level'] !== 'warn' && effect.payload['level'] !== 'error') continue;
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
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
    return;
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
      existing.link = record.link;
    }
    return;
  }
  // `record.link` is the isolated clone produced by buildCertifiedEntityFrameLink
  // and is never mutated afterwards (lineage replaces links wholesale). Cloning
  // it again copied every multi-megabyte hub frame a second time per R-frame.
  const link = record.link;
  pending.push({ kind: 'entityFrame', entityId, entityHeight, link });
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
  // Records were isolated when recorded; readers only encode them.
  return [...pending];
};

export const dropPendingHistoryRecords = (env: RuntimeReplica, count: number): void => {
  const pending = env.infrastructure?.pendingHistoryRecords;
  if (!Array.isArray(pending) || pending.length === 0) return;
  pending.splice(0, Math.max(0, Math.floor(count)));
};

export const dropOverlay = (env: RuntimeReplica, keys: readonly string[]): void => {
  const pending = env.overlay;
  if (!(pending instanceof Map) || pending.size === 0) return;
  for (const key of keys) pending.delete(key);
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
    // The frame log is committed with the Runtime WAL and queried from history.
    // Mirroring every machine fact to the relay duplicated the durable stream
    // as one signed socket frame per Runtime frame. Only explicit warn/error
    // and candidate debug effects use the relay audit lane.
  };
}
