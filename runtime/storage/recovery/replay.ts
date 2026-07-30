import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/registration-evidence';
import { safeStringify } from '../../protocol/serialization';
import { writeRuntimeMetadata } from '../../runtime/loop-environment';
import type { RuntimeState } from '../../runtime/types';
import {
  listStorageSnapshotHeights,
  readStorageFrameRecord,
  reconcileHistoryViews,
  resolveStorageRuntimeConfig,
  type StorageFrameRecord,
} from '..';
import { computeCanonicalEntityHashesFromEnv } from '../canonical-hash';
import type { PersistedStorageReadApi } from '../persisted-read';
import { buildRecoveryJournalFromStorageFrame } from '../queries';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import { assertStorageSafetyOverridesAllowed } from '../safety';
import type { LoadedRuntimeStorage } from './load';
import { verifyPersistedFrameState } from './verify';

type ReplayTarget = {
  latestHeight: number;
  targetHeight: number;
  selectedSnapshotHeight: number;
};

type ReplayOptions = { prunedTargetReturnsNull?: boolean };

type LoadPersistedRuntime = (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeight?: number,
  options?: ReplayOptions,
) => Promise<LoadedRuntimeStorage | null>;

const resolveReplayTarget = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: ReplayOptions = {},
): Promise<ReplayTarget | null> => {
  // Unsafe restore switches are rejected even for an empty database. Otherwise
  // a daemon could silently boot a fresh Runtime under an unsafe configuration.
  assertStorageSafetyOverridesAllowed();
  const env = reads.createPersistedStorageEnv(runtimeId, runtimeSeed);
  try {
    const latestHeight = await reads.resolvePersistedLatestHeight(env);
    if (latestHeight <= 0) return null;
    const targetHeight = Math.max(
      1,
      Math.min(
        latestHeight,
        Number.isFinite(Number(targetHeightOverride))
          ? Math.floor(Number(targetHeightOverride))
          : latestHeight,
      ),
    );
    const selectedSnapshotHeight =
      await reads.resolvePersistedSnapshotHeight(env, targetHeight);
    if (selectedSnapshotHeight > 0) {
      return { latestHeight, targetHeight, selectedSnapshotHeight };
    }
    const latestSnapshotHeight =
      await reads.resolvePersistedSnapshotHeight(env, latestHeight);
    if (options.prunedTargetReturnsNull && latestSnapshotHeight > targetHeight) {
      return null;
    }
    throw new Error(`STORAGE_RESTORE_SNAPSHOT_MISSING:height=${targetHeight}`);
  } finally {
    await deps.closeRuntimeDb(env);
    await deps.closeInfraDb(env);
  }
};

const assertReplayedFrameMatches = (
  env: RuntimeState,
  frame: StorageFrameRecord,
): void => {
  const verification = verifyPersistedFrameState(env, frame);
  if (verification.ok) return;
  const expectedEntities = new Map(
    (frame.canonicalEntityHashes ?? []).map(entry => [
      entry.entityId,
      entry.hash,
    ]),
  );
  const entityMismatches = computeCanonicalEntityHashesFromEnv(env)
    .filter(entry => expectedEntities.get(entry.entityId) !== entry.hash)
    .map(entry => ({
      entityId: entry.entityId,
      expected: expectedEntities.get(entry.entityId) ?? 'missing',
      actual: entry.hash,
    }));
  throw new Error(
    `STORAGE_RESTORE_REPLAY_HASH_MISMATCH:height=${frame.height}:` +
    `expected=${verification.expectedStateHash}:` +
    `actual=${verification.actualStateHash}:` +
    `expectedCanonical=${verification.expectedCanonicalStateHash}:` +
    `actualCanonical=${verification.actualCanonicalStateHash}:` +
    `entities=${safeStringify(entityMismatches)}`,
  );
};

const restoreActivityViews = async (
  reads: PersistedStorageReadApi,
  env: RuntimeState,
  targetHeight: number,
): Promise<void> => {
  // Activity is a rebuildable read model. Deferred Runtime input remains owned
  // by the authoritative WAL frame and must never be erased by view hydration.
  await reads.restoreOverlayFromFrameLog(env, targetHeight);
  const frame = await reads.readPersistedStorageFrameRecord(env, targetHeight);
  env.frameLogs = frame?.activityLogs.map(entry => ({ ...entry })) ?? [];
};

const reconcileMaterializedHistory = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeState,
  latestHeight: number,
): Promise<void> => {
  if (!(await deps.tryOpenRuntimeWalDb(env))) {
    throw new Error(`HISTORY_VIEW_WAL_DB_OPEN_FAILED:height=${latestHeight}`);
  }
  if (!(await deps.tryOpenHistoryViewDb(env))) {
    throw new Error(`HISTORY_VIEW_DB_OPEN_FAILED:height=${latestHeight}`);
  }
  const walDb = deps.getRuntimeWalDb(env);
  const snapshots = await listStorageSnapshotHeights(walDb);
  await reconcileHistoryViews({
    viewDb: deps.getHistoryViewDb(env),
    firstWalHeight: snapshots[0] ?? 1,
    latestWalHeight: latestHeight,
    readWalFrame: height => readStorageFrameRecord(walDb, height),
    config: resolveStorageRuntimeConfig(env),
  });
};

const finalizeReplay = async (
  reads: PersistedStorageReadApi,
  restored: LoadedRuntimeStorage,
  target: ReplayTarget,
  frame: StorageFrameRecord,
): Promise<void> => {
  assertReplayedFrameMatches(restored.env, frame);
  await restoreActivityViews(
    reads,
    restored.env,
    target.targetHeight,
  );
  await assertCertifiedRegistrationEvidenceStore(restored.env);
  writeRuntimeMetadata(restored.env, '__replayMeta', {
    checkpointHeight: target.selectedSnapshotHeight,
    selectedSnapshotHeight: target.selectedSnapshotHeight,
    selectedSnapshotLabel:
      target.selectedSnapshotHeight <= 1
        ? 'genesis:1'
        : `checkpoint:${target.selectedSnapshotHeight}`,
    latestHeight: target.latestHeight,
  });
  restored.env.history = [];
};

export const createRuntimeReplayLoader = (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  loadPersistedRuntime: LoadPersistedRuntime,
) => async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: ReplayOptions = {},
): Promise<LoadedRuntimeStorage | null> => {
  const target = await resolveReplayTarget(
    deps,
    reads,
    runtimeId,
    runtimeSeed,
    targetHeightOverride,
    options,
  );
  if (!target) return null;
  const restored = await loadPersistedRuntime(
    runtimeId,
    runtimeSeed,
    target.selectedSnapshotHeight,
    options,
  );
  if (!restored) return null;
  let returningEnv = false;
  try {
    let targetFrame: StorageFrameRecord | null = null;
    for (
      let height = target.selectedSnapshotHeight;
      height <= target.targetHeight;
      height += 1
    ) {
      const frame = await reads.readPersistedStorageFrameRecord(
        restored.env,
        height,
      );
      if (!frame) {
        throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${height}`);
      }
      targetFrame = frame;
      if (height > target.selectedSnapshotHeight) {
        await deps.replayRecoveryFrameJournals(
          restored.env,
          [buildRecoveryJournalFromStorageFrame(frame)],
        );
      }
    }
    if (!targetFrame) {
      throw new Error(
        `STORAGE_RESTORE_FRAME_MISSING:height=${target.targetHeight}`,
      );
    }
    await finalizeReplay(
      reads,
      restored,
      target,
      targetFrame,
    );
    if (target.targetHeight === target.latestHeight) {
      await reconcileMaterializedHistory(deps, restored.env, target.latestHeight);
    }
    restored.latestHeight = target.latestHeight;
    restored.checkpointHeight = target.selectedSnapshotHeight;
    restored.selectedSnapshotHeight = target.selectedSnapshotHeight;
    returningEnv = true;
    return restored;
  } finally {
    if (!returningEnv) {
      await deps.closeRuntimeDb(restored.env);
      await deps.closeInfraDb(restored.env);
    }
  }
};
