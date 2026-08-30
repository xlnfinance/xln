import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../protocol/crypto/keccak-text';
/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to RuntimeReplica (like Ethereum blocks have logs).
 * Events are buffered only for the active Runtime frame. WAL persists that
 * one frame's activity atomically. UI timelines are derived from the bounded
 * Runtime WAL instead of retaining a second R/E/A archive on RuntimeReplica.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type { RuntimeOverlayRecord } from '../../types/account';
import type {
  EntityCandidateEffect,
  EntityReplica,
  EntityState,
} from '../../entity/types';
import type { RuntimeReplica } from '../types';
import type { LogCategory, FrameLogEntry } from '../../types/logging';

import { storageOverlayRecordKey } from '../../protocol/state/overlay';
import { invalidateEntityAccountCommitment } from '../../entity/consensus/state-root';
import { recordRuntimeSecurityIncident, resolveRuntimeSecurityIncident } from './security-incidents';

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
  const key = keccakBytesHash(encodeCanonicalConsensusBytes(payload));
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
    ...(entityId === undefined ? {} : { entityId }),
    ...(data === undefined ? {} : { data }),
    runtimeId: env.runtimeId,
    at: env.state.timestamp,
  });
};

const attachStructuredLogger =
  (env: RuntimeReplica, level: 'info' | 'warn' | 'error', cleanLevel: 'INFO' | 'WARN' | 'ERR') =>
  (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string): void => {
    if (level === 'info') {
      addCleanLog(env, cleanLevel, message);
    } else {
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
    }

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

export const publishEntityCandidateEffects = (
  env: RuntimeReplica,
  sourceReplica: EntityReplica | null,
  effects: readonly EntityCandidateEffect[],
): void => {
  const resolveCommittedReplica = (
    effect: Extract<EntityCandidateEffect, { kind: 'entityFrameCommitted' }>,
  ): EntityReplica => {
    if (
      !sourceReplica
      || sourceReplica.entityId.toLowerCase() !== effect.entityId.toLowerCase()
      || sourceReplica.signerId.toLowerCase() !== effect.signerId.toLowerCase()
    ) {
      throw new Error(
        `ENTITY_FRAME_COMMIT_REPLICA_MISSING:entity=${effect.entityId}:signer=${effect.signerId}`,
      );
    }
    return sourceReplica;
  };

  for (const effect of effects) {
    if (effect.kind === 'entityFrameCommitted') {
      resolveCommittedReplica(effect);
      applyRuntimeStorageChanges(env, [{ family: 'entity', entityId: effect.entityId }]);
    } else if (effect.kind === 'accountFrameCommitted') {
      applyRuntimeStorageChanges(env, [{
        family: 'account',
        entityId: effect.entityId,
        counterpartyId: effect.counterpartyId,
      }]);
    } else if (effect.kind === 'runtimeEvent') {
      env.emit(effect.eventName, effect.data);
    } else if (effect.kind === 'securityIncidentRecord') {
      recordRuntimeSecurityIncident(env, effect.identity);
    } else if (effect.kind === 'securityIncidentResolve') {
      resolveRuntimeSecurityIncident(env, effect.identity);
    } else if (effect.kind === 'debug') {
      // Informational candidate traces (currently REB_STEP) are local
      // diagnostics, not a second network event stream. Relay only actionable
      // audit levels; committed machine facts are already bound to the Runtime WAL.
      if (effect.payload['level'] !== 'warn' && effect.payload['level'] !== 'error') continue;
      queuePendingAuditEvent(env, effect.payload);
    } else {
      const unhandled: never = effect;
      throw new Error(`ENTITY_CANDIDATE_EFFECT_UNHANDLED:${String(unhandled)}`);
    }
  }
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
    addCleanLog(env, 'LOG', message);
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
    // The frame log is attached only to this Runtime WAL frame.
    // Mirroring every machine fact to the relay duplicated the durable stream
    // as one signed socket frame per Runtime frame. Only explicit warn/error
    // and candidate debug effects use the relay audit lane.
  };
}
