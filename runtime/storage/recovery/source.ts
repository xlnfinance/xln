import { assertCertifiedJHistoryIntegrity } from '../../jurisdiction/local-history';
import type { EntityState, RuntimeState } from '../../types';
import {
  loadEntityStatesAtHeightFromStorage,
  verifyStorageSnapshotAtHeight,
  type StorageFrameRecord,
} from '..';
import type {
  PersistedStorageHandle,
  PersistedStorageReadApi,
} from '../persisted-read';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';

export type PersistedRestoreSource = {
  persistedHandles: PersistedStorageHandle[];
  latestHeight: number;
  targetHeight: number;
  frame: StorageFrameRecord;
  selectedSnapshotHeight: number;
  restoredStates: Map<string, EntityState>;
};

export const resolvePersistedRestoreSource = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  env: RuntimeState,
  targetHeightOverride?: number,
  options: { prunedTargetReturnsNull?: boolean } = {},
): Promise<PersistedRestoreSource | null> => {
  const persistedHandles = await reads.listPersistedStorageHandles(env);
  const latestHeight = persistedHandles.reduce(
    (max, handle) => Math.max(max, handle.latestHeight),
    0,
  );
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
  const frame = await reads.readPersistedStorageFrameRecord(env, targetHeight);
  if (!frame) {
    const latestSnapshotHeight = persistedHandles.reduce(
      (max, handle) => Math.max(max, handle.latestSnapshotHeight),
      0,
    );
    const retainedCheckpoint = persistedHandles.some(handle =>
      handle.snapshotHeights.includes(targetHeight),
    );
    if (
      options.prunedTargetReturnsNull &&
      targetHeight < latestSnapshotHeight &&
      !retainedCheckpoint
    ) {
      return null;
    }
    throw new Error(`STORAGE_RESTORE_FRAME_MISSING: height=${targetHeight}`);
  }

  const selectedSnapshotHeight = await reads.resolvePersistedSnapshotHeight(
    env,
    targetHeight,
  );
  if (selectedSnapshotHeight > 0) {
    const snapshotHandle = persistedHandles.find(handle =>
      handle.snapshotHeights.includes(selectedSnapshotHeight),
    );
    if (!snapshotHandle) {
      throw new Error(
        `STORAGE_RESTORE_SNAPSHOT_HANDLE_MISSING:` +
        `height=${selectedSnapshotHeight}`,
      );
    }
    await verifyStorageSnapshotAtHeight(
      snapshotHandle.db,
      snapshotHandle.head,
      selectedSnapshotHeight,
    );
  }

  const restoredStates = await loadEntityStatesAtHeightFromStorage({
    env,
    tryOpenDb: deps.tryOpenRuntimeWalDb,
    getRuntimeDb: deps.getRuntimeWalDb,
    height: targetHeight,
  });
  for (const state of restoredStates.values()) {
    assertCertifiedJHistoryIntegrity(state);
  }
  return {
    persistedHandles,
    latestHeight,
    targetHeight,
    frame,
    selectedSnapshotHeight,
    restoredStates,
  };
};
