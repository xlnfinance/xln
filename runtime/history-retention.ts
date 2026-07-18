import type { Env, EnvSnapshot } from './types';

// This is only the current in-memory debug view; the storage WAL owns history.
// Canonical snapshots contain the complete Runtime/Entity/Account projection,
// so retaining prior snapshots makes production memory scale with state size
// and can starve the WAL writer under sustained bootstrap load.
export const RECENT_RUNTIME_HISTORY_LIMIT = 1;

export const appendRecentRuntimeSnapshot = (
  history: readonly EnvSnapshot[],
  snapshot: EnvSnapshot,
  limit = RECENT_RUNTIME_HISTORY_LIMIT,
): EnvSnapshot[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`RUNTIME_HISTORY_LIMIT_INVALID:${String(limit)}`);
  }
  const keepBeforeAppend = Math.max(0, limit - 1);
  const retained = keepBeforeAppend === 0 ? [] : history.slice(-keepBeforeAppend);
  return [...retained, snapshot];
};

type RuntimeHistoryTrace = {
  snapshots: EnvSnapshot[];
};

const testingTraceByEnv = new Map<Env, RuntimeHistoryTrace>();

export type RuntimeHistoryTraceCollector = {
  readonly snapshots: readonly EnvSnapshot[];
  stop: () => void;
};

/**
 * Explicit test/scenario trace. Production Env history stays bounded; callers
 * that need a complete determinism oracle own this separate lifetime instead.
 */
export const startRuntimeHistoryTraceForTesting = (env: Env): RuntimeHistoryTraceCollector => {
  if (testingTraceByEnv.has(env)) throw new Error('RUNTIME_HISTORY_TRACE_ALREADY_ACTIVE');
  const trace: RuntimeHistoryTrace = { snapshots: [] };
  testingTraceByEnv.set(env, trace);
  return {
    get snapshots(): readonly EnvSnapshot[] {
      return trace.snapshots;
    },
    stop: () => {
      if (testingTraceByEnv.get(env) === trace) testingTraceByEnv.delete(env);
    },
  };
};

export const recordRuntimeHistoryTraceForTesting = (
  env: Env,
  snapshot: EnvSnapshot,
): void => {
  testingTraceByEnv.get(env)?.snapshots.push(snapshot);
};
