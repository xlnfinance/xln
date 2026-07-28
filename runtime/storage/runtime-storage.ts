import { runtimeIsBrowser } from '../runtime/platform';
import { cloneIsolatedRoutedEntityInputs, cloneIsolatedRuntimeInput } from '../protocol/runtime-input-clone';
import { requireBoundaryInteger } from '../protocol/boundary-validation';
import {
  buildReplayVerifiableRuntimeMachineSnapshot,
  authorizeRestoredRuntimeInput,
  restoreDurableRuntimeSnapshot,
} from './wal/snapshot';
import { setAccountFrameHistoryView } from '../runtime/env-events';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { restoreDurableOutputRetryState } from '../runtime/durable-output-retry';
import { safeStringify } from '../protocol/serialization';
import {
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalStateHashFromEnv,
} from './canonical-hash';
import {
  buildRuntimeCheckpointLineagePlan,
} from './entity-lineage';
import { assertCertifiedRegistrationEvidenceStore } from '../jurisdiction/registration-evidence';
import {
  computeStoragePostStateHash,
  listStorageSnapshotHeights,
  readHistoryViewAccountFrames,
  reconcileHistoryViews,
  resolveStorageRuntimeConfig,
  readStorageFrameRecord,
  type StorageFrameRecord,
} from '.';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
} from './replicas';
import { assertStorageSafetyOverridesAllowed } from './safety';
import type { RuntimeState } from '../types';
import { buildRecoveryJournalFromStorageFrame } from './queries';
import { createStructuredLogger } from '../infra/logger';
import { envRecord } from '../runtime/loop-environment';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';
import {
  createRuntimeStorageCommitApi,
  shouldRequireCanonicalStorageAudit,
} from './commit';
import { createPersistedStorageReadApi } from './persisted-read';
import { resolvePersistedRestoreSource } from './recovery/source';
import { restorePersistedEntityGraph } from './recovery/entities';

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

  type VerifyRuntimeChainResult = {
    ok: boolean;
    latestHeight: number;
    checkpointHeight: number;
    selectedSnapshotHeight: number;
    restoredHeight: number;
    expectedStateHash: string;
    actualStateHash: string;
    expectedCanonicalStateHash?: string;
    actualCanonicalStateHash?: string;
  };

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

  const loadEnvFromStorage = async (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options: { prunedTargetReturnsNull?: boolean } = {},
  ): Promise<{
    env: RuntimeState;
    latestHeight: number;
    checkpointHeight: number;
    selectedSnapshotHeight: number;
  } | null> => {
    /**
     * Authoritative daemon restore has three deliberately separate phases:
     *
     * 1. Read compact snapshot/frame records and decode every Runtime, Entity,
     *    Account, replica-meta and immutable DAG node through its strict schema.
     * 2. Rebuild Maps and reachable node stores in memory, then verify lineage,
     *    J-history roots and the canonical state hash before returning any RuntimeState.
     * 3. Only the caller may attach live RPC/network infrastructure and start the
     *    runtime loop. New J-events and durable outbox retries therefore cannot
     *    mutate state until the restored checkpoint has passed every check.
     *
     * Keep external I/O out of phases 1-2. A restore failure must close the probe
     * databases and fail loud; it must never expose a partially hydrated RuntimeState.
     */
    const env = createPersistedStorageEnv(runtimeId, runtimeSeed);
    assertStorageSafetyOverridesAllowed();
    let returningEnv = false;
    try {
      const source = await resolvePersistedRestoreSource(
        deps,
        persistedReadApi,
        env,
        targetHeightOverride,
        options,
      );
      if (!source) return null;
      const {
        latestHeight,
        targetHeight,
        frame,
        selectedSnapshotHeight,
        restoredStates,
      } = source;
      if (frame.runtimeMachine) restoreDurableRuntimeSnapshot(env, frame.runtimeMachine);

      await restorePersistedEntityGraph(
        deps,
        persistedReadApi,
        env,
        restoredStates,
        targetHeight,
        latestHeight,
        selectedSnapshotHeight,
      );

      env.height = targetHeight;
      env.timestamp = requireBoundaryInteger(
        frame.timestamp,
        `STORAGE_RESTORE_TIMESTAMP_INVALID:height=${targetHeight}`,
      );
      env.runtimeMempool = frame.pendingRuntimeInput
        ? authorizeRestoredRuntimeInput(cloneIsolatedRuntimeInput(frame.pendingRuntimeInput))
        : { runtimeTxs: [], entityInputs: [] };
      env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs ?? []);
      restoreDurableOutputRetryState(env, frame.runtimeOutputRetryState ?? [], frame.runtimeOutputs ?? []);
      await restoreOverlayFromFrameLog(env, targetHeight);
      await hydrateAccountFrameHistoryViews(env);
      env.frameLogs = frame.activityLogs.map(entry => ({ ...entry }));
      if (frame.runtimeMachine) {
        restoreDurableRuntimeSnapshot(env, frame.runtimeMachine);
        await assertCertifiedRegistrationEvidenceStore(env);
      }
      const shouldVerifyCanonicalAudit = Boolean(frame.canonicalStateHash) || shouldRequireCanonicalStorageAudit();
      if (shouldVerifyCanonicalAudit && !frame.canonicalStateHash) {
        throw new Error(`STORAGE_RESTORE_CANONICAL_HASH_MISSING: height=${targetHeight}`);
      }
      const restoredCanonicalStateHash = shouldVerifyCanonicalAudit ? computeCanonicalStateHashFromEnv(env) : '';
      if (shouldVerifyCanonicalAudit && restoredCanonicalStateHash !== frame.canonicalStateHash) {
        const expectedEntities = new Map(
          (frame.canonicalEntityHashes || []).map(entry => [entry.entityId, entry.hash]),
        );
        const actualEntities = computeCanonicalEntityHashesFromEnv(env);
        const mismatch = actualEntities.find(entry => expectedEntities.get(entry.entityId) !== entry.hash);
        const missing = (frame.canonicalEntityHashes || []).find(
          entry => !actualEntities.some(actual => actual.entityId === entry.entityId),
        );
        const mismatchDetail = mismatch
          ? ` entity=${mismatch.entityId} expectedEntity=${expectedEntities.get(mismatch.entityId) || 'missing'} actualEntity=${mismatch.hash}`
          : missing
            ? ` entity=${missing.entityId} expectedEntity=${missing.hash} actualEntity=missing`
            : '';
        throw new Error(
          `STORAGE_RESTORE_CANONICAL_HASH_MISMATCH: height=${targetHeight} ` +
            `expected=${frame.canonicalStateHash} actual=${restoredCanonicalStateHash}${mismatchDetail}`,
        );
      }
      envRecord(env)['__replayMeta'] = {
        checkpointHeight: selectedSnapshotHeight,
        selectedSnapshotHeight,
        selectedSnapshotLabel:
          selectedSnapshotHeight <= 1
            ? 'genesis:1'
            : selectedSnapshotHeight === targetHeight
              ? `checkpoint:${selectedSnapshotHeight}`
              : `snapshot:${selectedSnapshotHeight}`,
        latestHeight,
      };
      env.history = [];

      returningEnv = true;
      return {
        env,
        latestHeight,
        checkpointHeight: selectedSnapshotHeight,
        selectedSnapshotHeight,
      };
    } finally {
      // loadEnvFromDB probes storage on fresh starts. If there is nothing to
      // restore, the probe env must release LevelDB locks before the real runtime
      // opens the same storage path for frame 1.
      if (!returningEnv) {
        await closeRuntimeDb(env);
        await closeInfraDb(env);
      }
    }
  };

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

  const verifyPersistedFrameState = (
    env: RuntimeState,
    persistedFrame: StorageFrameRecord,
  ): {
    expectedStateHash: string;
    actualStateHash: string;
    expectedCanonicalStateHash: string;
    actualCanonicalStateHash: string;
    ok: boolean;
  } => {
    const expectedStateHash = persistedFrame.postStateHash;
    const storageHashMode = persistedFrame.hashMode === 'storage-merkle-v1';
    const replayCheckpointLineagePlan = persistedFrame.replicaMetaCheckpoint
      ? buildRuntimeCheckpointLineagePlan(env)
      : null;
    const actualReplicaMetaDigest = replayCheckpointLineagePlan
      ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, replayCheckpointLineagePlan, {
          omitIntermediateSingleSignerState: persistedFrame.replicaMetaStateMode === 'shared-entity-state',
        }).digest
      : buildStorageLiveReplicaMetaCommitment(env).digest;
    const actualStateHash = computeStoragePostStateHash({
      height: persistedFrame.height,
      timestamp: persistedFrame.timestamp,
      replicaMetaDigest: actualReplicaMetaDigest,
      runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
        pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
        excludePersistedHistoryRecords: true,
      }),
    });
    const expectedCanonicalStateHash = storageHashMode
      ? String(persistedFrame.canonicalStateHash || '')
      : expectedStateHash;
    const actualCanonicalStateHash = storageHashMode
      ? expectedCanonicalStateHash
        ? computeCanonicalStateHashFromEnv(env)
        : ''
      : actualStateHash;
    return {
      expectedStateHash,
      actualStateHash,
      expectedCanonicalStateHash,
      actualCanonicalStateHash,
      ok: expectedStateHash === actualStateHash && expectedCanonicalStateHash === actualCanonicalStateHash,
    };
  };

  const verifyRuntimeChain = async (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: { fromSnapshotHeight?: number },
  ): Promise<VerifyRuntimeChainResult> => {
    const bootstrapEnv = createPersistedStorageEnv(runtimeId, runtimeSeed);
    const latestHeight = await resolvePersistedLatestHeight(bootstrapEnv);
    if (latestHeight <= 0) {
      throw new Error('REPLAY_INVARIANT_FAILED: no persisted runtime state');
    }
    const requestedFromHeight = Number.isFinite(Number(options?.fromSnapshotHeight))
      ? Math.max(1, Math.floor(Number(options?.fromSnapshotHeight)))
      : latestHeight;
    if (requestedFromHeight > latestHeight) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: requested height ${requestedFromHeight} exceeds latest ${latestHeight}`,
      );
    }
    const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, requestedFromHeight);
    const checkpointHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, latestHeight);
    let expectedStateHash = '';
    let actualStateHash = '';
    let expectedCanonicalStateHash = '';
    let actualCanonicalStateHash = '';
    let restoredHeight = selectedSnapshotHeight;
    let replayed: Awaited<ReturnType<typeof loadEnvFromStorage>> = null;
    try {
      await closeRuntimeDb(bootstrapEnv);
      await closeInfraDb(bootstrapEnv);
      replayed = await loadEnvFromStorage(runtimeId, runtimeSeed, selectedSnapshotHeight);
      if (!replayed) {
        throw new Error(`REPLAY_INVARIANT_FAILED: failed to restore checkpoint at height ${selectedSnapshotHeight}`);
      }
      for (let height = selectedSnapshotHeight; height <= latestHeight; height += 1) {
        const persistedFrame = await readPersistedStorageFrameRecord(replayed.env, height);
        if (!persistedFrame) {
          throw new Error(`REPLAY_INVARIANT_FAILED: missing persisted frame at height ${height}`);
        }
        if (height > selectedSnapshotHeight) {
          await replayRecoveryFrameJournals(replayed.env, [buildRecoveryJournalFromStorageFrame(persistedFrame)]);
        }
        if (height < requestedFromHeight) continue;
        const verification = verifyPersistedFrameState(replayed.env, persistedFrame);
        ({ expectedStateHash, actualStateHash, expectedCanonicalStateHash, actualCanonicalStateHash } = verification);
        restoredHeight = height;
        if (!verification.ok) {
          return {
            ok: false,
            latestHeight,
            checkpointHeight,
            selectedSnapshotHeight,
            restoredHeight,
            expectedStateHash,
            actualStateHash,
            expectedCanonicalStateHash,
            actualCanonicalStateHash,
          };
        }
      }
    } finally {
      if (replayed) {
        await closeRuntimeDb(replayed.env);
        await closeInfraDb(replayed.env);
      }
      await closeRuntimeDb(bootstrapEnv);
      await closeInfraDb(bootstrapEnv);
    }

    return {
      ok: true,
      latestHeight,
      checkpointHeight,
      selectedSnapshotHeight,
      restoredHeight,
      expectedStateHash,
      actualStateHash,
      expectedCanonicalStateHash,
      actualCanonicalStateHash,
    };
  };

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
