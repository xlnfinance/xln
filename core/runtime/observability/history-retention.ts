import type { RuntimeReplica, EnvSnapshot } from '../types';

// Runtime memory is the live finalized state plus bounded in-flight machinery.
// Historical views belong to LevelDB or to an explicitly-owned trace collector.

type RuntimeHistoryTrace = {
  snapshots: EnvSnapshot[];
};

const testingTraceByEnv = new Map<RuntimeReplica, RuntimeHistoryTrace>();

export const hasRuntimeHistoryTraceForTesting = (env: RuntimeReplica): boolean =>
  testingTraceByEnv.has(env);

/** Read an active external collector without placing a timeline on RuntimeReplica. */
export const readRuntimeHistoryTraceForTesting = (
  env: RuntimeReplica,
): readonly EnvSnapshot[] | null => testingTraceByEnv.get(env)?.snapshots ?? null;

/** Mutate only the last value in an explicitly-owned collector. */
export const updateLatestRuntimeHistoryTraceForTesting = (
  env: RuntimeReplica,
  update: (snapshot: EnvSnapshot) => void,
): boolean => {
  const snapshots = testingTraceByEnv.get(env)?.snapshots;
  const latest = snapshots?.at(-1);
  if (!latest) return false;
  update(latest);
  return true;
};

export type RuntimeHistoryTraceCollector = {
  readonly snapshots: readonly EnvSnapshot[];
  stop: () => void;
};

/**
 * Explicit test/scenario trace. Production RuntimeReplica history stays bounded; callers
 * that need a complete determinism oracle own this separate lifetime instead.
 *
 * Also the recording primitive behind browser demos, which
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
