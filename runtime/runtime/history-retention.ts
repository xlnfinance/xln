import type { RuntimeReplica, EnvSnapshot } from './types';

// Runtime memory is the live finalized state plus the private in-flight clone.
// Historical views belong to LevelDB or to an explicit test-only collector.
export const RECENT_RUNTIME_HISTORY_LIMIT = 0;

export const appendRecentRuntimeSnapshot = (
  history: readonly EnvSnapshot[],
  snapshot: EnvSnapshot,
  limit = RECENT_RUNTIME_HISTORY_LIMIT,
): EnvSnapshot[] => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`RUNTIME_HISTORY_LIMIT_INVALID:${String(limit)}`);
  }
  if (limit === 0) return [];
  const keepBeforeAppend = Math.max(0, limit - 1);
  const retained = keepBeforeAppend === 0 ? [] : history.slice(-keepBeforeAppend);
  return [...retained, snapshot];
};

type RuntimeHistoryTrace = {
  snapshots: EnvSnapshot[];
};

const testingTraceByEnv = new Map<RuntimeReplica, RuntimeHistoryTrace>();

export const hasRuntimeHistoryTraceForTesting = (env: RuntimeReplica): boolean =>
  testingTraceByEnv.has(env);

export type RuntimeHistoryTraceCollector = {
  readonly snapshots: readonly EnvSnapshot[];
  stop: () => void;
};

/**
 * Explicit test/scenario trace. Production RuntimeReplica history stays bounded; callers
 * that need a complete determinism oracle own this separate lifetime instead.
 *
 * Also the recording primitive behind browser demos — see `startRuntimeFrameTrace`, which
 * is the same collector named for that second, non-test caller.
 */
export const startRuntimeHistoryTraceForTesting = (env: RuntimeReplica): RuntimeHistoryTraceCollector => {
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
  env: RuntimeReplica,
  snapshot: EnvSnapshot,
): void => {
  testingTraceByEnv.get(env)?.snapshots.push(snapshot);
};

/**
 * Capture every committed frame of one run so it can be replayed frame by frame.
 *
 * Same collector the determinism oracle uses, named for its other legitimate caller: the
 * browser demo recorder. Runtime memory stays bounded either way — the collector owns the
 * frames and `stop()` releases them.
 */
export const startRuntimeFrameTrace = startRuntimeHistoryTraceForTesting;
export type RuntimeFrameTrace = RuntimeHistoryTraceCollector;
