import type { RuntimeReplica, EnvSnapshot } from '../types';

// Runtime memory is the live finalized state plus bounded in-flight machinery.
// UI timelines are derived from the bounded WAL; tests may own an explicit trace collector.

type RuntimeTrace = {
  snapshots: EnvSnapshot[];
};

const testingTraceByEnv = new Map<RuntimeReplica, RuntimeTrace>();

export const hasRuntimeTraceForTesting = (env: RuntimeReplica): boolean =>
  testingTraceByEnv.has(env);

/** Read an active external collector without placing a timeline on RuntimeReplica. */
export const readRuntimeTraceForTesting = (
  env: RuntimeReplica,
): readonly EnvSnapshot[] | null => testingTraceByEnv.get(env)?.snapshots ?? null;

/** Mutate only the last value in an explicitly-owned collector. */
export const updateLatestRuntimeTraceForTesting = (
  env: RuntimeReplica,
  update: (snapshot: EnvSnapshot) => void,
): boolean => {
  const snapshots = testingTraceByEnv.get(env)?.snapshots;
  const latest = snapshots?.at(-1);
  if (!latest) return false;
  update(latest);
  return true;
};

export type RuntimeTraceCollector = {
  readonly snapshots: readonly EnvSnapshot[];
  stop: () => void;
};

export type RuntimeTraceScope = RuntimeTraceCollector & {
  readonly startIndex: number;
};

/**
 * Explicit test/scenario trace. Production RuntimeReplica state stays bounded; callers
 * that need a complete determinism oracle own this separate lifetime instead.
 *
 * Also the recording primitive behind browser demos, which
 * is the same collector named for that second, non-test caller.
 */
export const startRuntimeTraceForTesting = (env: RuntimeReplica): RuntimeTraceCollector => {
  if (testingTraceByEnv.has(env)) throw new Error('RUNTIME_TRACE_ALREADY_ACTIVE');
  const trace: RuntimeTrace = { snapshots: [] };
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

/** Reuse an outer recorder when present; only the creator may stop the collector. */
export const openRuntimeTraceScopeForTesting = (env: RuntimeReplica): RuntimeTraceScope => {
  const active = readRuntimeTraceForTesting(env);
  if (active) {
    return {
      snapshots: active,
      startIndex: active.length,
      stop: () => {},
    };
  }
  const recorder = startRuntimeTraceForTesting(env);
  return {
    snapshots: recorder.snapshots,
    startIndex: recorder.snapshots.length,
    stop: recorder.stop,
  };
};

export const recordRuntimeTraceForTesting = (
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
