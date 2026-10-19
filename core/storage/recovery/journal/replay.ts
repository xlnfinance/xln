import { assertCertifiedRegistrationEvidenceStore } from '../../../jurisdiction/machine/registration-evidence';
import { safeStringify } from '../../../protocol/serialization';
import { writeRuntimeMetadata } from '../../../runtime/loop/loop-environment.ts';
import type { RuntimeReplica } from '../../../runtime/types';
import { type RuntimeFrame } from '../..';
import { computeCanonicalEntityHashesFromEnv } from '../../canonical-hash';
import type { PersistedStorageReadApi } from '../../read/persisted-read';
import { buildRecoveryJournalFromStorageFrame } from '../../queries';
import type { RuntimeStorageApiDeps } from '../../runtime-storage-deps';
import { assertStorageSafetyOverridesAllowed } from '../../commit/safety';
import type { LoadedRuntimeStorage } from '../load';
import { verifyPersistedFrameState } from '../verify';
import { borrowOpenRuntimeWalDb } from '../../runtime-dbs';

type ReplayTarget = {
  latestHeight: number;
  targetHeight: number;
  selectedCheckpointHeight: number;
  selectedSnapshotHeight: number;
};

export type ReplayOptions = {
  prunedTargetReturnsNull?: boolean;
  /** Existing live Runtime whose open WAL handle may be borrowed read-only. */
  borrowRuntimeWalFrom?: RuntimeReplica;
  /** Historical queries rebuild State but never mutate auxiliary read models. */
  readOnly?: boolean;
};

type LoadPersistedRuntime = (env: RuntimeReplica, targetHeight?: number) => Promise<LoadedRuntimeStorage | null>;

const resolveReplayTarget = async (
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  targetHeightOverride?: number,
  options: ReplayOptions = {},
): Promise<ReplayTarget | null> => {
  // Unsafe restore switches are rejected even for an empty database. Otherwise
  // a daemon could silently boot a fresh Runtime under an unsafe configuration.
  assertStorageSafetyOverridesAllowed();
  const latestHeight = await reads.resolvePersistedLatestHeight(env);
  if (latestHeight <= 0) return null;
  const targetHeight = Math.max(
    1,
    Math.min(
      latestHeight,
      Number.isFinite(Number(targetHeightOverride)) ? Math.floor(Number(targetHeightOverride)) : latestHeight,
    ),
  );
  const selectedSnapshotHeight = await reads.resolvePersistedSnapshotHeight(env, targetHeight);
  const selectedMaterializedHeight = (await reads.listPersistedStorageHandles(env)).reduce(
    (highest, handle) =>
      handle.latestMaterializedHeight <= targetHeight ? Math.max(highest, handle.latestMaterializedHeight) : highest,
    0,
  );
  const selectedCheckpointHeight = Math.max(selectedSnapshotHeight, selectedMaterializedHeight);
  if (selectedCheckpointHeight > 0) {
    return {
      latestHeight,
      targetHeight,
      selectedCheckpointHeight,
      selectedSnapshotHeight,
    };
  }
  const latestSnapshotHeight = await reads.resolvePersistedSnapshotHeight(env, latestHeight);
  if (options.prunedTargetReturnsNull && latestSnapshotHeight > targetHeight) {
    return null;
  }
  throw new Error(`STORAGE_RESTORE_SNAPSHOT_MISSING:height=${targetHeight}`);
};

const assertReplayedFrameMatches = (
  env: RuntimeReplica,
  frame: RuntimeFrame,
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

const restoreReplayOverlay = async (
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  targetHeight: number,
): Promise<void> => {
  // The dirty overlay is derived from replayed Runtime inputs. There is no
  // separately persisted activity or frame-history sidecar.
  await reads.restoreOverlayFromFrameLog(env, targetHeight);
};

const finalizeReplay = async (
  reads: PersistedStorageReadApi,
  restored: LoadedRuntimeStorage,
  target: ReplayTarget,
  frame: RuntimeFrame,
): Promise<void> => {
  assertReplayedFrameMatches(restored.env, frame);
  await restoreReplayOverlay(
    reads,
    restored.env,
    target.targetHeight,
  );
  await assertCertifiedRegistrationEvidenceStore(restored.env);
  writeRuntimeMetadata(restored.env, '__replayMeta', {
    checkpointHeight: target.selectedCheckpointHeight,
    selectedSnapshotHeight: target.selectedSnapshotHeight,
    selectedSnapshotLabel:
      target.selectedCheckpointHeight <= 1
        ? 'genesis:1'
        : `checkpoint:${target.selectedCheckpointHeight}`,
    latestHeight: target.latestHeight,
    replayedFrameCount: target.targetHeight - target.selectedCheckpointHeight,
  });
};

export const createRuntimeReplayLoader =
  (deps: RuntimeStorageApiDeps, reads: PersistedStorageReadApi, loadPersistedRuntime: LoadPersistedRuntime) =>
  async (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    targetHeightOverride?: number,
    options: ReplayOptions = {},
  ): Promise<LoadedRuntimeStorage | null> => {
    // Checkpoint selection and graph/tail restore own the same verified handle.
    // Closing a probe then reopening repeated the full WAL integrity decode and
    // introduced an unnecessary gap between selecting and reading its head.
    const env = reads.createPersistedStorageEnv(runtimeId, runtimeSeed);
    let returningEnv = false;
    try {
      if (options.borrowRuntimeWalFrom) {
        await borrowOpenRuntimeWalDb(options.borrowRuntimeWalFrom, env, deps);
      }
      const target = await resolveReplayTarget(reads, env, targetHeightOverride, options);
      if (!target) return null;
      const restored = await loadPersistedRuntime(env, target.selectedCheckpointHeight);
      if (!restored) return null;
      let targetFrame: RuntimeFrame | null = null;
      for (let height = target.selectedCheckpointHeight; height <= target.targetHeight; height += 1) {
        const frame = await reads.readPersistedStorageFrameRecord(restored.env, height);
        if (!frame) {
          throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${height}`);
        }
        targetFrame = frame;
        if (height > target.selectedCheckpointHeight) {
          const payloads = await reads.readPersistedStorageFramePayloads(restored.env, frame);
          await deps.replayRecoveryFrameJournals(restored.env, [buildRecoveryJournalFromStorageFrame(frame, payloads)]);
        }
      }
      if (!targetFrame) {
        throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${target.targetHeight}`);
      }
      await finalizeReplay(reads, restored, target, targetFrame);
      restored.latestHeight = target.latestHeight;
      restored.checkpointHeight = target.selectedCheckpointHeight;
      restored.selectedSnapshotHeight = target.selectedSnapshotHeight;
      returningEnv = true;
      return restored;
    } finally {
      if (!returningEnv) {
        await deps.closeRuntimeDb(env);
        await deps.closeInfraDb(env);
      }
    }
  };
