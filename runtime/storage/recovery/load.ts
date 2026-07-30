import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../../runtime/input-clone';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { writeRuntimeMetadata } from '../../runtime/loop-environment';
import { restoreDurableOutputRetryState } from '../../runtime/durable-output-retry';
import type { RuntimeReplica } from '../../runtime/types';
import {
  authorizeRestoredRuntimeInput,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';
import {
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalStateHashFromEnv,
} from '../canonical-hash';
import type { PersistedStorageReadApi } from '../persisted-read';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import { assertStorageSafetyOverridesAllowed } from '../safety';
import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/registration-evidence';
import { shouldRequireCanonicalStorageAudit } from '../commit';
import { restorePersistedEntityGraph } from './entities';
import {
  resolvePersistedRestoreSource,
  type PersistedRestoreSource,
} from './source';

export type LoadedRuntimeStorage = {
  env: RuntimeReplica;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
};

const assertRestoredCanonicalState = (
  env: RuntimeReplica,
  source: PersistedRestoreSource,
): void => {
  const { frame, targetHeight } = source;
  const shouldVerify =
    Boolean(frame.canonicalStateHash) ||
    shouldRequireCanonicalStorageAudit();
  if (!shouldVerify) return;
  if (!frame.canonicalStateHash) {
    throw new Error(
      `STORAGE_RESTORE_CANONICAL_HASH_MISSING: height=${targetHeight}`,
    );
  }
  const actualStateHash = computeCanonicalStateHashFromEnv(env);
  if (actualStateHash === frame.canonicalStateHash) return;

  const expectedEntities = new Map(
    (frame.canonicalEntityHashes || []).map(entry => [
      entry.entityId,
      entry.hash,
    ]),
  );
  const actualEntities = computeCanonicalEntityHashesFromEnv(env);
  const mismatch = actualEntities.find(
    entry => expectedEntities.get(entry.entityId) !== entry.hash,
  );
  const missing = (frame.canonicalEntityHashes || []).find(
    entry => !actualEntities.some(actual => actual.entityId === entry.entityId),
  );
  const mismatchDetail = mismatch
    ? ` entity=${mismatch.entityId} ` +
      `expectedEntity=${expectedEntities.get(mismatch.entityId) || 'missing'} ` +
      `actualEntity=${mismatch.hash}`
    : missing
      ? ` entity=${missing.entityId} expectedEntity=${missing.hash} ` +
        `actualEntity=missing`
      : '';
  throw new Error(
    `STORAGE_RESTORE_CANONICAL_HASH_MISMATCH: height=${targetHeight} ` +
    `expected=${frame.canonicalStateHash} actual=${actualStateHash}` +
    mismatchDetail,
  );
};

const installRestoredRuntimeFrame = async (
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  source: PersistedRestoreSource,
): Promise<void> => {
  const {
    latestHeight,
    targetHeight,
    frame,
    selectedSnapshotHeight,
  } = source;
  env.state.height = targetHeight;
  env.state.timestamp = requireBoundaryInteger(
    frame.timestamp,
    `STORAGE_RESTORE_TIMESTAMP_INVALID:height=${targetHeight}`,
  );
  env.runtimeMempool = frame.pendingRuntimeInput
    ? authorizeRestoredRuntimeInput(
        cloneIsolatedRuntimeInput(frame.pendingRuntimeInput),
      )
    : { runtimeTxs: [], entityInputs: [] };
  env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(
    frame.runtimeOutputs ?? [],
  );
  restoreDurableOutputRetryState(
    env,
    frame.runtimeOutputRetryState ?? [],
    frame.runtimeOutputs ?? [],
  );
  await reads.restoreOverlayFromFrameLog(env, targetHeight);
  env.frameLogs = frame.activityLogs.map(entry => ({ ...entry }));
  if (frame.runtimeMachine) {
    restoreDurableRuntimeSnapshot(env, frame.runtimeMachine);
    await assertCertifiedRegistrationEvidenceStore(env);
  }
  assertRestoredCanonicalState(env, source);
  writeRuntimeMetadata(env, '__replayMeta', {
    checkpointHeight: selectedSnapshotHeight,
    selectedSnapshotHeight,
    selectedSnapshotLabel:
      selectedSnapshotHeight <= 1
        ? 'genesis:1'
        : selectedSnapshotHeight === targetHeight
          ? `checkpoint:${selectedSnapshotHeight}`
          : `snapshot:${selectedSnapshotHeight}`,
    latestHeight,
  });
  env.history = [];
};

export const loadPersistedRuntime = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: { prunedTargetReturnsNull?: boolean } = {},
): Promise<LoadedRuntimeStorage | null> => {
  const env = reads.createPersistedStorageEnv(runtimeId, runtimeSeed);
  assertStorageSafetyOverridesAllowed();
  let returningEnv = false;
  try {
    const source = await resolvePersistedRestoreSource(
      deps,
      reads,
      env,
      targetHeightOverride,
      options,
    );
    if (!source) return null;
    if (source.frame.runtimeMachine) {
      restoreDurableRuntimeSnapshot(env, source.frame.runtimeMachine);
    }
    await restorePersistedEntityGraph(
      deps,
      reads,
      env,
      source.restoredStates,
      source.targetHeight,
      source.latestHeight,
      source.selectedSnapshotHeight,
    );
    await installRestoredRuntimeFrame(
      reads,
      env,
      source,
    );
    returningEnv = true;
    return {
      env,
      latestHeight: source.latestHeight,
      checkpointHeight: source.selectedSnapshotHeight,
      selectedSnapshotHeight: source.selectedSnapshotHeight,
    };
  } finally {
    // An empty/invalid probe must release LevelDB locks before the real
    // Runtime opens the same namespace for frame one.
    if (!returningEnv) {
      await deps.closeRuntimeDb(env);
      await deps.closeInfraDb(env);
    }
  }
};
