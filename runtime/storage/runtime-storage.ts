import { runtimeIsBrowser } from '../infra/runtime-process';
import { ensureRuntimeState } from '../runtime/runtime-state';
import type { RuntimeState } from '../types';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';
import { createRuntimeStorageCommitApi } from './commit';
import { createPersistedStorageReadApi } from './persisted-read';
import { loadPersistedRuntime } from './recovery/load';
import { createRuntimeReplayLoader } from './recovery/replay';
import { createRuntimeChainVerifier } from './recovery/verify';
import { createAccountFrameHistoryHydrator } from './views/account-history';

export type { RuntimeStorageApiDeps } from './runtime-storage-deps';

type RuntimeSyncChannel = NonNullable<NonNullable<RuntimeState['runtimeState']>['runtimeSyncChannel']>;

export type RuntimeSyncNotificationOptions = {
  enabled?: boolean;
  createChannel?: (name: string) => RuntimeSyncChannel;
};

/**
 * Broadcast is an operational effect after the WAL commit, never part of it.
 * A broken browser channel is visible in Runtime state but cannot turn a
 * durable financial frame into an apparent rollback.
 */
export const notifyRuntimeSyncAfterCommit = (
  env: RuntimeState,
  options: RuntimeSyncNotificationOptions = {},
): Error | null => {
  const enabled = options.enabled ?? runtimeIsBrowser;
  if (!enabled || !env.runtimeId) return null;
  const state = ensureRuntimeState(env);
  try {
    const createChannel =
      options.createChannel ??
      ((name: string): RuntimeSyncChannel => new BroadcastChannel(name));
    state.runtimeSyncChannel ??= createChannel('xln-runtime-sync');
    state.runtimeSyncChannel.postMessage({ runtimeId: env.runtimeId, height: env.height });
    delete state.runtimeSyncNotificationFailure;
    return null;
  } catch (cause) {
    const notificationError = new Error(`RUNTIME_SYNC_NOTIFICATION_FAILED:height=${env.height}`, { cause });
    let reportedError: Error = notificationError;
    try {
      state.runtimeSyncChannel?.close();
    } catch (closeCause) {
      reportedError = new AggregateError(
        [notificationError, closeCause],
        `RUNTIME_SYNC_NOTIFICATION_AND_CLOSE_FAILED:height=${env.height}`,
      );
    }
    state.runtimeSyncChannel = null;
    state.runtimeSyncNotificationFailure = { height: env.height, message: reportedError.message };
    return reportedError;
  }
};

export const createRuntimeStorageApi = (deps: RuntimeStorageApiDeps) => {
  const commitApi = createRuntimeStorageCommitApi(deps);
  const hydrateAccountFrameHistoryViews =
    createAccountFrameHistoryHydrator(deps);

  const persistedReadApi = createPersistedStorageReadApi(deps);
  const {
    resolvePersistedLatestHeight,
    resolvePersistedCheckpointHeights,
    readPersistedStorageFrameRecord,
    listPersistedEntityIdsAtHeight,
  } = persistedReadApi;

  const loadEnvFromStorage = (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options: { prunedTargetReturnsNull?: boolean } = {},
  ) =>
    loadPersistedRuntime(
      deps,
      persistedReadApi,
      hydrateAccountFrameHistoryViews,
      runtimeId,
      runtimeSeed,
      targetHeightOverride,
      options,
    );

  const verifyRuntimeChain = createRuntimeChainVerifier(
    deps,
    persistedReadApi,
    loadEnvFromStorage,
  );
  const loadEnvFromStorageByReplay = createRuntimeReplayLoader(
    deps,
    persistedReadApi,
    loadEnvFromStorage,
    hydrateAccountFrameHistoryViews,
  );

  return {
    ...commitApi,
    readPersistedStorageFrameRecord,
    listPersistedEntityIdsAtHeight,
    verifyRuntimeChain,
    resolvePersistedLatestHeight,
    resolvePersistedCheckpointHeights,
    loadEnvFromStorageByReplay,
  };
};
