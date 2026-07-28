import { runtimeIsBrowser } from '../runtime/platform';
import { setAccountFrameHistoryView } from '../runtime/env-events';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { safeStringify } from '../protocol/serialization';
import { computeCanonicalEntityHashesFromEnv } from './canonical-hash';
import { assertCertifiedRegistrationEvidenceStore } from '../jurisdiction/registration-evidence';
import {
  listStorageSnapshotHeights,
  readHistoryViewAccountFrames,
  reconcileHistoryViews,
  resolveStorageRuntimeConfig,
  readStorageFrameRecord,
  type StorageFrameRecord,
} from '.';
import { assertStorageSafetyOverridesAllowed } from './safety';
import type { RuntimeState } from '../types';
import { buildRecoveryJournalFromStorageFrame } from './queries';
import { createStructuredLogger } from '../infra/logger';
import { envRecord } from '../runtime/loop-environment';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';
import { createRuntimeStorageCommitApi } from './commit';
import { createPersistedStorageReadApi } from './persisted-read';
import { loadPersistedRuntime } from './recovery/load';
import {
  createRuntimeChainVerifier,
  verifyPersistedFrameState,
} from './recovery/verify';

export type { RuntimeStorageApiDeps } from './runtime-storage-deps';

const runtimeLog = createStructuredLogger('runtime');

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
  const {
    getRuntimeWalDb,
    getHistoryViewDb,
    tryOpenRuntimeWalDb,
    tryOpenHistoryViewDb,
    closeRuntimeDb,
    closeInfraDb,
    replayRecoveryFrameJournals,
  } = deps;

  const commitApi = createRuntimeStorageCommitApi(deps);

  const persistedReadApi = createPersistedStorageReadApi(deps);
  const {
    createPersistedStorageEnv,
    restoreOverlayFromFrameLog,
    resolvePersistedLatestHeight,
    resolvePersistedCheckpointHeights,
    readPersistedStorageFrameRecord,
    resolvePersistedSnapshotHeight,
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

  const hydrateAccountFrameHistoryViews = async (env: RuntimeState, limit = 0): Promise<void> => {
    if (limit <= 0) return;
    try {
      if (!(await tryOpenRuntimeWalDb(env))) return;
      const db = getRuntimeWalDb(env);
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const entityId = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
        if (!entityId || !replica?.state?.accounts) continue;
        for (const [counterpartyId, account] of replica.state.accounts.entries()) {
          const accountCurrentHeight = Math.max(0, Math.floor(Number(account.currentHeight ?? 0)));
          const records = await readHistoryViewAccountFrames(db, entityId, String(counterpartyId).toLowerCase(), {
            limit,
            maxRuntimeHeight: env.height,
            maxAccountHeight: accountCurrentHeight,
          });
          setAccountFrameHistoryView(
            account,
            records.map(record => record.frame),
            limit,
          );
        }
      }
    } catch (error) {
      runtimeLog.warn('account_frame_history.hydrate_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const verifyRuntimeChain = createRuntimeChainVerifier(
    deps,
    persistedReadApi,
    loadEnvFromStorage,
  );

  type PersistedReplayTarget = {
    latestHeight: number;
    targetHeight: number;
    selectedSnapshotHeight: number;
  };

  const resolvePersistedReplayTarget = async (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options: { prunedTargetReturnsNull?: boolean } = {},
  ): Promise<PersistedReplayTarget | null> => {
    // Safety overrides are forbidden at the restore boundary even when the DB is
    // empty. Delaying this check until a snapshot is found lets a production
    // daemon silently boot fresh with an unsafe restore configuration.
    assertStorageSafetyOverridesAllowed();
    const probeEnv = createPersistedStorageEnv(runtimeId, runtimeSeed);
    try {
      const latestHeight = await resolvePersistedLatestHeight(probeEnv);
      if (latestHeight <= 0) return null;
      const targetHeight = Math.max(
        1,
        Math.min(
          latestHeight,
          Number.isFinite(Number(targetHeightOverride)) ? Math.floor(Number(targetHeightOverride)) : latestHeight,
        ),
      );
      const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, targetHeight);
      if (selectedSnapshotHeight <= 0) {
        const latestSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, latestHeight);
        if (options.prunedTargetReturnsNull && latestSnapshotHeight > targetHeight) return null;
        throw new Error(`STORAGE_RESTORE_SNAPSHOT_MISSING:height=${targetHeight}`);
      }
      return { latestHeight, targetHeight, selectedSnapshotHeight };
    } finally {
      await closeRuntimeDb(probeEnv);
      await closeInfraDb(probeEnv);
    }
  };

  const restoreReplayedActivityViews = async (env: RuntimeState, targetHeight: number): Promise<void> => {
    // Activity/history hydration is a read-model concern. Never erase deferred
    // input state reconstructed from the latest WAL frame.
    await restoreOverlayFromFrameLog(env, targetHeight);
    await hydrateAccountFrameHistoryViews(env);
    const frame = await readPersistedStorageFrameRecord(env, targetHeight);
    env.frameLogs = frame?.activityLogs.map(entry => ({ ...entry })) ?? [];
  };

  const reconcilePersistedHistoryViews = async (
    env: RuntimeState,
    latestHeight: number,
  ): Promise<void> => {
    if (!(await tryOpenRuntimeWalDb(env))) {
      throw new Error(`HISTORY_VIEW_WAL_DB_OPEN_FAILED:height=${latestHeight}`);
    }
    if (!(await tryOpenHistoryViewDb(env))) {
      throw new Error(`HISTORY_VIEW_DB_OPEN_FAILED:height=${latestHeight}`);
    }
    const retainedSnapshotHeights = await listStorageSnapshotHeights(getRuntimeWalDb(env));
    await reconcileHistoryViews({
      viewDb: getHistoryViewDb(env),
      firstWalHeight: retainedSnapshotHeights[0] ?? 1,
      latestWalHeight: latestHeight,
      readWalFrame: height => readStorageFrameRecord(getRuntimeWalDb(env), height),
      config: resolveStorageRuntimeConfig(env),
    });
  };

  const assertReplayedStorageFrameMatches = (env: RuntimeState, frame: StorageFrameRecord): void => {
    const verification = verifyPersistedFrameState(env, frame);
    if (verification.ok) return;
    const expectedEntities = new Map((frame.canonicalEntityHashes ?? []).map(entry => [entry.entityId, entry.hash]));
    const actualEntities = computeCanonicalEntityHashesFromEnv(env);
    const entityMismatches = actualEntities
      .filter(entry => expectedEntities.get(entry.entityId) !== entry.hash)
      .map(entry => ({
        entityId: entry.entityId,
        expected: expectedEntities.get(entry.entityId) ?? 'missing',
        actual: entry.hash,
      }));
    throw new Error(
      `STORAGE_RESTORE_REPLAY_HASH_MISMATCH:height=${frame.height}:` +
        `expected=${verification.expectedStateHash}:actual=${verification.actualStateHash}:` +
        `expectedCanonical=${verification.expectedCanonicalStateHash}:` +
        `actualCanonical=${verification.actualCanonicalStateHash}:` +
        `entities=${safeStringify(entityMismatches)}`,
    );
  };

  const finalizeReplayedStorageRestore = async (
    restored: NonNullable<Awaited<ReturnType<typeof loadEnvFromStorage>>>,
    target: PersistedReplayTarget,
    frame: StorageFrameRecord,
  ): Promise<void> => {
    const { env } = restored;
    assertReplayedStorageFrameMatches(env, frame);
    await restoreReplayedActivityViews(env, target.targetHeight);
    await assertCertifiedRegistrationEvidenceStore(env);
    envRecord(env)['__replayMeta'] = {
      checkpointHeight: target.selectedSnapshotHeight,
      selectedSnapshotHeight: target.selectedSnapshotHeight,
      selectedSnapshotLabel:
        target.selectedSnapshotHeight <= 1 ? 'genesis:1' : `checkpoint:${target.selectedSnapshotHeight}`,
      latestHeight: target.latestHeight,
    };
    env.history = [];
  };

  const loadEnvFromStorageByReplay = async (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options: { prunedTargetReturnsNull?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof loadEnvFromStorage>>> => {
    const target = await resolvePersistedReplayTarget(runtimeId, runtimeSeed, targetHeightOverride, options);
    if (!target) return null;
    const restored = await loadEnvFromStorage(runtimeId, runtimeSeed, target.selectedSnapshotHeight, options);
    if (!restored) return null;
    let returningEnv = false;
    try {
      let targetFrame: StorageFrameRecord | null = null;
      for (let height = target.selectedSnapshotHeight; height <= target.targetHeight; height += 1) {
        const frame = await readPersistedStorageFrameRecord(restored.env, height);
        if (!frame) throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${height}`);
        targetFrame = frame;
        if (height > target.selectedSnapshotHeight) {
          await replayRecoveryFrameJournals(restored.env, [buildRecoveryJournalFromStorageFrame(frame)]);
        }
      }
      if (!targetFrame) throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${target.targetHeight}`);
      await finalizeReplayedStorageRestore(restored, target, targetFrame);
      if (target.targetHeight === target.latestHeight) {
        await reconcilePersistedHistoryViews(restored.env, target.latestHeight);
      }
      restored.latestHeight = target.latestHeight;
      restored.checkpointHeight = target.selectedSnapshotHeight;
      restored.selectedSnapshotHeight = target.selectedSnapshotHeight;
      returningEnv = true;
      return restored;
    } finally {
      if (!returningEnv) {
        await closeRuntimeDb(restored.env);
        await closeInfraDb(restored.env);
      }
    }
  };

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
