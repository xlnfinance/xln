import { buildRecoveryJournalFromStorageFrame } from '../queries';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
} from '../replicas';
import { computeCanonicalStateHashFromEnv } from '../canonical-hash';
import { buildRuntimeCheckpointLineagePlan } from '../entity-lineage';
import { buildReplayVerifiableRuntimeMachineSnapshot } from '../wal/snapshot';
import {
  computeStoragePostStateHash,
  type StorageFrameRecord,
} from '..';
import type { RuntimeState } from '../../types';
import type { PersistedStorageReadApi } from '../persisted-read';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import type { LoadedRuntimeStorage } from './load';

export type PersistedFrameVerification = {
  expectedStateHash: string;
  actualStateHash: string;
  expectedCanonicalStateHash: string;
  actualCanonicalStateHash: string;
  ok: boolean;
};

export type RuntimeChainVerification = PersistedFrameVerification & {
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  restoredHeight: number;
};

export const verifyPersistedFrameState = (
  env: RuntimeState,
  frame: StorageFrameRecord,
): PersistedFrameVerification => {
  const expectedStateHash = frame.postStateHash;
  const storageHashMode = frame.hashMode === 'storage-merkle-v1';
  const lineage = frame.replicaMetaCheckpoint
    ? buildRuntimeCheckpointLineagePlan(env)
    : null;
  const replicaMetaDigest = lineage
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, lineage, {
        omitIntermediateSingleSignerState:
          frame.replicaMetaStateMode === 'shared-entity-state',
      }).digest
    : buildStorageLiveReplicaMetaCommitment(env).digest;
  const actualStateHash = computeStoragePostStateHash({
    height: frame.height,
    timestamp: frame.timestamp,
    replicaMetaDigest,
    runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
      pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
      excludePersistedHistoryRecords: true,
    }),
  });
  const expectedCanonicalStateHash = storageHashMode
    ? String(frame.canonicalStateHash || '')
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
    ok:
      expectedStateHash === actualStateHash &&
      expectedCanonicalStateHash === actualCanonicalStateHash,
  };
};

type LoadPersistedRuntime = (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeight?: number,
) => Promise<LoadedRuntimeStorage | null>;

export const createRuntimeChainVerifier = (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  loadPersistedRuntime: LoadPersistedRuntime,
) => async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: { fromSnapshotHeight?: number },
): Promise<RuntimeChainVerification> => {
  const bootstrapEnv = reads.createPersistedStorageEnv(runtimeId, runtimeSeed);
  const latestHeight = await reads.resolvePersistedLatestHeight(bootstrapEnv);
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
  const selectedSnapshotHeight = await reads.resolvePersistedSnapshotHeight(
    bootstrapEnv,
    requestedFromHeight,
  );
  const checkpointHeight = await reads.resolvePersistedSnapshotHeight(
    bootstrapEnv,
    latestHeight,
  );
  let verification: PersistedFrameVerification = {
    expectedStateHash: '',
    actualStateHash: '',
    expectedCanonicalStateHash: '',
    actualCanonicalStateHash: '',
    ok: true,
  };
  let restoredHeight = selectedSnapshotHeight;
  let restored: LoadedRuntimeStorage | null = null;
  try {
    await deps.closeRuntimeDb(bootstrapEnv);
    await deps.closeInfraDb(bootstrapEnv);
    restored = await loadPersistedRuntime(
      runtimeId,
      runtimeSeed,
      selectedSnapshotHeight,
    );
    if (!restored) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: failed to restore checkpoint at height ${selectedSnapshotHeight}`,
      );
    }
    for (let height = selectedSnapshotHeight; height <= latestHeight; height += 1) {
      const frame = await reads.readPersistedStorageFrameRecord(restored.env, height);
      if (!frame) {
        throw new Error(`REPLAY_INVARIANT_FAILED: missing persisted frame at height ${height}`);
      }
      if (height > selectedSnapshotHeight) {
        await deps.replayRecoveryFrameJournals(
          restored.env,
          [buildRecoveryJournalFromStorageFrame(frame)],
        );
      }
      if (height < requestedFromHeight) continue;
      verification = verifyPersistedFrameState(restored.env, frame);
      restoredHeight = height;
      if (!verification.ok) break;
    }
  } finally {
    if (restored) {
      await deps.closeRuntimeDb(restored.env);
      await deps.closeInfraDb(restored.env);
    }
    await deps.closeRuntimeDb(bootstrapEnv);
    await deps.closeInfraDb(bootstrapEnv);
  }
  return {
    ...verification,
    latestHeight,
    checkpointHeight,
    selectedSnapshotHeight,
    restoredHeight,
  };
};
