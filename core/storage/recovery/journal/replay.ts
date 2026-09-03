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
import { authorityReplayEnabled } from '../../../rscore/authority-driver';
import type { LoadedRuntimeStorage } from '../load';
import { verifyPersistedFrameState } from '../verify';
import { borrowOpenRuntimeWalDb } from '../../runtime-dbs';
import {
  loadRscoreCheckpoint,
  type LoadedRscoreCheckpoint,
} from '../../schema/rscore/checkpoint';
import type { StorageRscoreCheckpointRef } from '../../types';

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
  if (options.borrowRuntimeWalFrom) {
    await borrowOpenRuntimeWalDb(options.borrowRuntimeWalFrom, env, deps);
  }
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
    const selectedMaterializedHeight = (await reads.listPersistedStorageHandles(env))
      .reduce((highest, handle) => (
        handle.latestMaterializedHeight <= targetHeight
          ? Math.max(highest, handle.latestMaterializedHeight)
          : highest
      ), 0);
    const selectedCheckpointHeight = Math.max(
      selectedSnapshotHeight,
      selectedMaterializedHeight,
    );
    if (selectedCheckpointHeight > 0) {
      return {
        latestHeight,
        targetHeight,
        selectedCheckpointHeight,
        selectedSnapshotHeight,
      };
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

const checkpointRefMatches = (
  loaded: LoadedRscoreCheckpoint,
  ref: StorageRscoreCheckpointRef,
): boolean => {
  const token = loaded.restoreToken;
  return loaded.ownerEntityId === ref.ownerEntityId &&
    loaded.protocolFingerprint === ref.protocolFingerprint &&
    String(token[0]) === ref.baseRevision &&
    String(token[1]) === ref.revision &&
    `0x${Buffer.from(token[2]).toString('hex')}` === ref.accountsRoot &&
    `0x${Buffer.from(token[3]).toString('hex')}` === ref.signerDigest &&
    token[4] === ref.accountCount;
};

/** Restore the Account authority at the materialized TS boundary, before any
 * WAL-tail Runtime input is replayed through it. */
const restoreAccountAuthorityAtCheckpoint = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  restored: LoadedRuntimeStorage,
  checkpointHeight: number,
): Promise<void> => {
  const frame = await reads.readPersistedStorageFrameRecord(restored.env, checkpointHeight);
  if (!frame) throw new Error(`RSCORE_RESTORE_FRAME_MISSING:height=${checkpointHeight}`);
  const refs = frame.accountAuthorityCheckpoints ?? [];
  if (refs.length === 0) {
    await deps.restoreAccountAuthorityExact(restored.env, []);
    return;
  }
  if (!(await deps.tryOpenRuntimeWalDb(restored.env))) {
    throw new Error(`RSCORE_RESTORE_WAL_DB_OPEN_FAILED:height=${checkpointHeight}`);
  }
  const db = deps.getRuntimeWalDb(restored.env);
  const checkpoints: LoadedRscoreCheckpoint[] = [];
  for (const ref of refs) {
    const loaded = await loadRscoreCheckpoint(db, ref.ownerEntityId);
    if (!loaded) throw new Error(`RSCORE_RESTORE_ROWS_MISSING:${ref.ownerEntityId}`);
    if (!checkpointRefMatches(loaded, ref)) {
      throw new Error(`RSCORE_RESTORE_REF_MISMATCH:${ref.ownerEntityId}`);
    }
    checkpoints.push(loaded);
  }
  await deps.restoreAccountAuthorityExact(restored.env, checkpoints);
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
  if (
    deps.accountAuthorityConfigured() &&
    options.readOnly !== true &&
    target.targetHeight !== target.latestHeight
  ) {
    throw new Error(
      `RSCORE_HISTORICAL_LIVE_RESTORE_UNSUPPORTED:` +
      `target=${target.targetHeight}:latest=${target.latestHeight}`,
    );
  }
  const restored = await loadPersistedRuntime(
    runtimeId,
    runtimeSeed,
    target.selectedCheckpointHeight,
    options,
  );
  if (!restored) return null;
  let returningEnv = false;
  try {
    if (options.readOnly && !authorityReplayEnabled()) {
      deps.setAccountAuthoritySuppressed(restored.env, true);
    } else {
      await restoreAccountAuthorityAtCheckpoint(
        deps,
        reads,
        restored,
        target.selectedCheckpointHeight,
      );
    }
    let targetFrame: RuntimeFrame | null = null;
    for (
      let height = target.selectedCheckpointHeight;
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
      if (height > target.selectedCheckpointHeight) {
        const payloads = await reads.readPersistedStorageFramePayloads(restored.env, frame);
        await deps.replayRecoveryFrameJournals(
          restored.env,
          [buildRecoveryJournalFromStorageFrame(frame, payloads)],
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
    restored.latestHeight = target.latestHeight;
    restored.checkpointHeight = target.selectedCheckpointHeight;
    restored.selectedSnapshotHeight = target.selectedSnapshotHeight;
    returningEnv = true;
    return restored;
  } finally {
    if (!returningEnv) {
      if (!options.readOnly) await deps.discardAccountAuthority(restored.env);
      await deps.closeRuntimeDb(restored.env);
      await deps.closeInfraDb(restored.env);
    }
  }
};
