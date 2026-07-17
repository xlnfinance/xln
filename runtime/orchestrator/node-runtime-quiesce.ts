import {
  resumeRuntimeLoop,
  startP2P,
  stopJurisdictionWatchersAndWait,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
  waitForRuntimeWorkDrained,
  type RuntimeLoopConfig,
} from '../runtime';
import { transitionRuntimeLifecycle } from '../machine/lifecycle';
import type { Env, RuntimeP2PConfigLike } from '../types';

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

export const quiesceNodeRuntime = async (
  env: Env,
  options: NodeRuntimeQuiesceOptions,
): Promise<NodeRuntimeQuiesceResult> => {
  const failures: string[] = [];
  let runtimeDrained = false;
  let runtimeIdle = false;

  // Establish the ingress fence first. The runtime loop remains alive long
  // enough to drain accepted work, but cannot restart a stopped J watcher.
  if (env.runtimeState) env.runtimeState.persistenceQuiescing = true;
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
  config: RuntimeP2PConfigLike | null | undefined,
): RuntimeP2PConfigLike | null => config ? {
  ...config,
  ...(config.relayUrls ? { relayUrls: [...config.relayUrls] } : {}),
  ...(config.seedRuntimeIds ? { seedRuntimeIds: [...config.seedRuntimeIds] } : {}),
  ...(config.advertiseEntityIds ? { advertiseEntityIds: [...config.advertiseEntityIds] } : {}),
} : null;

/**
 * Publish one non-terminal runtime checkpoint from a fully quiesced state.
 * Accepted work drains before persistence is paused; watcher, loop, and P2P
 * producers are stopped before the atomic storage callback runs.
 */
export const checkpointNodeRuntime = async (
  env: Env,
  options: NodeRuntimeCheckpointOptions,
): Promise<NodeRuntimeCheckpointResult> => {
  env.runtimeState = env.runtimeState ?? {};
  const state = env.runtimeState;
  if (state.persistenceQuiescing) {
    throw new Error('NODE_RUNTIME_CHECKPOINT_ALREADY_QUIESCING');
  }

  const wasLoopActive = Boolean(state.loopActive);
  const wasP2PActive = Boolean(state.p2p);
  const wasPersistencePaused = Boolean(state.persistencePaused);
  const previousP2PConfig = copyP2PConfig(state.lastP2PConfig);
  const previousPendingP2PConfig = copyP2PConfig(state.pendingP2PConfig);
  if (wasP2PActive && !previousP2PConfig) {
    throw new Error('NODE_RUNTIME_CHECKPOINT_P2P_CONFIG_MISSING');
  }

  const quiesceResult = await quiesceNodeRuntime(env, {
    workTimeoutMs: options.workTimeoutMs,
    loopTimeoutMs: options.loopTimeoutMs,
    ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
    allowPersistencePausedDrain:
      wasPersistencePaused && options.resumePersistenceAfterCheckpoint === true,
  });
  state.persistencePaused = true;

  let persistFailure: unknown = null;
  try {
    await options.persist();
  } catch (error) {
    persistFailure = error;
  }

  let resumeFailure: unknown = null;
  try {
    state.persistencePaused = options.resumePersistenceAfterCheckpoint && !persistFailure
      ? false
      : wasPersistencePaused;
    const keepProducersStopped = Boolean(state.persistencePaused);
    state.persistenceQuiescing = false;
    transitionRuntimeLifecycle(state, 'stopped');
    if (!keepProducersStopped && wasP2PActive && previousP2PConfig) {
      if (!startP2P(env, previousP2PConfig)) {
        throw new Error('P2P_RESUME_FAILED');
      }
    } else {
      state.lastP2PConfig = previousP2PConfig;
      state.pendingP2PConfig = previousPendingP2PConfig;
    }
    if (!keepProducersStopped && wasLoopActive) {
      resumeRuntimeLoop(env, options.loopConfig);
    }
  } catch (error) {
    resumeFailure = error;
  }

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
    wasLoopActive,
    wasP2PActive,
    wasPersistencePaused,
  };
};
