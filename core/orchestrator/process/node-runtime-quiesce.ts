import {
  resumeRuntimeLoop,
  startP2P,
  stopJurisdictionWatchersAndWait,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
  waitForRuntimeWorkDrained,
  type RuntimeLoopConfig,
} from '../../runtime';
import { createCheckpointBarrierRuntimeTx } from '../../runtime/checkpoint/barrier';
import { enqueueRuntimeContinuation } from '../../runtime/loop/loop-envelope';
import { haltRuntimeRequiresOperator, transitionRuntimeLifecycle } from '../../runtime/replica/lifecycle';
import type { RuntimeP2PConfig } from '../../runtime/envelope/p2p-types';
import type { RuntimeReplica } from '../../runtime/types';

export type NodeRuntimeQuiesceOptions = {
  workTimeoutMs: number;
  loopTimeoutMs: number;
  quietMs?: number;
  /**
   * Bootstrap-only: drain the in-memory pre-snapshot state while storage is
   * intentionally paused. The caller must publish the complete state as one
   * durable snapshot before persistence is resumed.
   */
  allowPersistencePausedDrain?: boolean;
};

export type NodeRuntimeQuiesceResult = {
  runtimeDrained: boolean;
  runtimeIdle: boolean;
};

export type NodeRuntimeCheckpointOptions = NodeRuntimeQuiesceOptions & {
  persist: () => Promise<void>;
  loopConfig?: RuntimeLoopConfig;
  resumePersistenceAfterCheckpoint?: boolean;
};

export type NodeRuntimeCheckpointResult = NodeRuntimeQuiesceResult & {
  wasLoopActive: boolean;
  wasP2PActive: boolean;
  wasPersistencePaused: boolean;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type ChildQuiesceLog = (event: 'quiesce.refused' | 'quiesce.post_failed', details: Record<string, unknown>) => void;

/**
 * Orchestrator side: ask a child Runtime to quiesce before it is stopped. The
 * stop proceeds either way, but a refusal (for example a 503 "runtime quiesce
 * failed") or a transport failure is logged instead of being dropped.
 */
export const requestChildQuiesce = async (url: string, timeoutMs: number, log: ChildQuiesceLog): Promise<void> => {
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) return;
    log('quiesce.refused', { url, status: response.status, body: (await response.text()).slice(0, 500) });
  } catch (error) {
    log('quiesce.post_failed', { url, error: errorText(error) });
  }
};

export const quiesceNodeRuntime = async (
  env: RuntimeReplica,
  options: NodeRuntimeQuiesceOptions,
  afterInitialDrain?: () => Promise<void>,
): Promise<NodeRuntimeQuiesceResult> => {
  const failures: string[] = [];
  let runtimeDrained = false;
  let runtimeIdle = false;

  // Establish the ingress fence first. The runtime loop remains alive long
  // enough to drain accepted work, but cannot restart a stopped J watcher.
  if (env.infrastructure) env.infrastructure.persistenceQuiescing = true;
  try {
    await stopJurisdictionWatchersAndWait(env);
  } catch (error) {
    failures.push(`watchers:${errorText(error)}`);
  }
  try {
    runtimeDrained = await waitForRuntimeWorkDrained(
      env,
      options.workTimeoutMs,
      options.quietMs,
      { allowPersistencePaused: options.allowPersistencePausedDrain === true },
    );
    if (!runtimeDrained) failures.push('work_drain_timeout');
  } catch (error) {
    failures.push(`work_drain:${errorText(error)}`);
  }
  if (runtimeDrained && afterInitialDrain) {
    try {
      await afterInitialDrain();
      runtimeDrained = await waitForRuntimeWorkDrained(
        env,
        options.workTimeoutMs,
        options.quietMs,
        { allowPersistencePaused: options.allowPersistencePausedDrain === true },
      );
      if (!runtimeDrained) failures.push('barrier_drain_timeout');
    } catch (error) {
      failures.push(`barrier:${errorText(error)}`);
    }
  }
  try {
    runtimeIdle = await stopRuntimeLoopAndWait(env, options.loopTimeoutMs);
    if (!runtimeIdle) failures.push('loop_drain_timeout');
  } catch (error) {
    failures.push(`loop_drain:${errorText(error)}`);
  }
  try {
    await stopP2PAndWait(env, options.loopTimeoutMs);
  } catch (error) {
    failures.push(`p2p:${errorText(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`NODE_RUNTIME_QUIESCE_FAILED:${failures.join('|')}`);
  }
  return { runtimeDrained, runtimeIdle };
};

const copyP2PConfig = (
  config: RuntimeP2PConfig | null | undefined,
): RuntimeP2PConfig | null => config ? {
  ...config,
  ...(config.relayUrls ? { relayUrls: [...config.relayUrls] } : {}),
  ...(config.seedRuntimeIds ? { seedRuntimeIds: [...config.seedRuntimeIds] } : {}),
  ...(config.advertiseEntityIds ? { advertiseEntityIds: [...config.advertiseEntityIds] } : {}),
} : null;

type NodeRuntimeState = NonNullable<RuntimeReplica['infrastructure']>;

type NodeRuntimeProducers = Readonly<{
  wasLoopActive: boolean;
  wasP2PActive: boolean;
  previousP2PConfig: RuntimeP2PConfig | null;
  previousPendingP2PConfig: RuntimeP2PConfig | null;
  loopConfig: RuntimeLoopConfig | undefined;
}>;

/** Restore the pre-checkpoint producers; returns the restore failure, if any. */
const restoreNodeRuntimeProducers = (
  env: RuntimeReplica,
  state: NodeRuntimeState,
  producers: NodeRuntimeProducers,
  keepProducersStopped: boolean,
): unknown => {
  try {
    state.persistenceQuiescing = false;
    transitionRuntimeLifecycle(state, 'stopped');
    if (!keepProducersStopped && producers.wasP2PActive && producers.previousP2PConfig) {
      if (!startP2P(env, producers.previousP2PConfig)) {
        throw new Error('P2P_RESUME_FAILED');
      }
    } else {
      state.lastP2PConfig = producers.previousP2PConfig;
      state.pendingP2PConfig = producers.previousPendingP2PConfig;
    }
    if (!keepProducersStopped && producers.wasLoopActive) {
      resumeRuntimeLoop(env, producers.loopConfig);
    }
    return null;
  } catch (error) {
    return error;
  }
};

const quiesceForCheckpoint = async (
  env: RuntimeReplica,
  state: NodeRuntimeState,
  options: NodeRuntimeCheckpointOptions,
  producers: NodeRuntimeProducers,
  wasPersistencePaused: boolean,
): Promise<NodeRuntimeQuiesceResult> => {
  try {
    return await quiesceNodeRuntime(env, {
      workTimeoutMs: options.workTimeoutMs,
      loopTimeoutMs: options.loopTimeoutMs,
      ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
      allowPersistencePausedDrain:
        wasPersistencePaused && options.resumePersistenceAfterCheckpoint === true,
    }, wasPersistencePaused ? undefined : async () => {
      enqueueRuntimeContinuation(
        env,
        [],
        [createCheckpointBarrierRuntimeTx()],
        [],
        env.state.timestamp,
      );
    });
  } catch (error) {
    // A loop that outlived its drain deadline may still apply a frame. A second
    // loop beside it is unsafe, so the Runtime halts for the operator.
    if (state.loopPromise || state.processingPromise) {
      haltRuntimeRequiresOperator(env, error);
      throw new Error(`NODE_RUNTIME_CHECKPOINT_FAILED:quiesce:${errorText(error)}|halted:loop_not_drained`, {
        cause: error,
      });
    }
    // Otherwise put the producers back: a failed drain must not leave an inert,
    // unhalted Runtime that refuses every later checkpoint as already quiescing.
    const resumeFailure = restoreNodeRuntimeProducers(env, state, producers, wasPersistencePaused);
    const failures = [
      `quiesce:${errorText(error)}`,
      ...(resumeFailure ? [`resume:${errorText(resumeFailure)}`] : []),
    ];
    throw new Error(`NODE_RUNTIME_CHECKPOINT_FAILED:${failures.join('|')}`, { cause: error });
  }
};

/**
 * Publish one non-terminal runtime checkpoint from a fully quiesced state.
 * Accepted work drains before persistence is paused; watcher, loop, and P2P
 * producers are stopped before the atomic storage callback runs.
 */
export const checkpointNodeRuntime = async (
  env: RuntimeReplica,
  options: NodeRuntimeCheckpointOptions,
): Promise<NodeRuntimeCheckpointResult> => {
  env.infrastructure = env.infrastructure ?? {};
  const state = env.infrastructure;
  if (state.persistenceQuiescing) {
    throw new Error('NODE_RUNTIME_CHECKPOINT_ALREADY_QUIESCING');
  }

  const wasPersistencePaused = Boolean(state.persistencePaused);
  const producers: NodeRuntimeProducers = {
    wasLoopActive: Boolean(state.loopActive),
    wasP2PActive: Boolean(state.p2p),
    previousP2PConfig: copyP2PConfig(state.lastP2PConfig),
    previousPendingP2PConfig: copyP2PConfig(state.pendingP2PConfig),
    loopConfig: options.loopConfig,
  };
  if (producers.wasP2PActive && !producers.previousP2PConfig) {
    throw new Error('NODE_RUNTIME_CHECKPOINT_P2P_CONFIG_MISSING');
  }
  if (!wasPersistencePaused && !producers.wasLoopActive) {
    throw new Error('NODE_RUNTIME_CHECKPOINT_LOOP_INACTIVE');
  }

  const quiesceResult = await quiesceForCheckpoint(env, state, options, producers, wasPersistencePaused);
  state.persistencePaused = true;

  let persistFailure: unknown = null;
  try {
    await options.persist();
  } catch (error) {
    persistFailure = error;
  }

  state.persistencePaused = options.resumePersistenceAfterCheckpoint && !persistFailure
    ? false
    : wasPersistencePaused;
  const resumeFailure = restoreNodeRuntimeProducers(env, state, producers, Boolean(state.persistencePaused));

  const failures = [
    ...(persistFailure ? [`persist:${errorText(persistFailure)}`] : []),
    ...(resumeFailure ? [`resume:${errorText(resumeFailure)}`] : []),
  ];
  if (failures.length > 0) {
    throw new Error(`NODE_RUNTIME_CHECKPOINT_FAILED:${failures.join('|')}`, {
      cause: persistFailure ?? resumeFailure,
    });
  }

  return {
    ...quiesceResult,
    wasLoopActive: producers.wasLoopActive,
    wasP2PActive: producers.wasP2PActive,
    wasPersistencePaused,
  };
};
