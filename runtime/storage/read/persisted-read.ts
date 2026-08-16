import type { Level } from 'level';

import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import {
  findStorageLatestSnapshotAtOrBelow,
  listStorageReplicaMetas,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  listStorageSnapshotReplicaMetas,
  readStorageFrameRecord,
  readStorageFramePayloads,
  readStorageHead,
  type StorageHead,
} from '..';
import { normalizeDbNamespace } from '../runtime-dbs';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import { requireStorageDbOpen } from '../commit/availability';

export type PersistedStorageHandle = {
  role: 'history';
  db: Level<Buffer, Buffer>;
  head: StorageHead;
  latestHeight: number;
  latestMaterializedHeight: number;
  latestSnapshotHeight: number;
  snapshotHeights: number[];
};

const createPersistedStorageNavigationApi = (
  deps: RuntimeStorageApiDeps,
) => {
  const createPersistedStorageEnv = (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
  ): RuntimeReplica => {
    const env = deps.createEmptyEnv(runtimeSeed ?? null);
    const normalizedRuntimeId = normalizeRuntimeId(
      runtimeId ?? env.runtimeId ?? null,
    );
    if (normalizedRuntimeId) {
      env.runtimeId = normalizedRuntimeId;
      env.dbNamespace = normalizeDbNamespace(normalizedRuntimeId);
    }
    return env;
  };

  const listPersistedStorageHandles = async (
    env: RuntimeReplica,
  ): Promise<PersistedStorageHandle[]> => {
    await requireStorageDbOpen(
      () => deps.tryOpenRuntimeWalDb(env),
      'runtime-wal:list-persisted-handles',
    );
    const db = deps.getRuntimeWalDb(env);
    const head = await readStorageHead(db);
    if (!head || head.latestHeight <= 0) return [];
    return [{
      role: 'history',
      db,
      head,
      latestHeight: head.latestHeight,
      latestMaterializedHeight: Math.max(
        0,
        Math.floor(
          Number(
            head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0,
          ),
        ),
      ),
      latestSnapshotHeight: head.latestSnapshotHeight,
      snapshotHeights: (await listStorageSnapshotHeights(db))
        .filter(height => height <= head.latestSnapshotHeight),
    }];
  };

  const restoreOverlayFromFrameLog = async (
    env: RuntimeReplica,
    targetHeight: number,
  ): Promise<void> => {
    for (const handle of await listPersistedStorageHandles(env)) {
      if (targetHeight > handle.latestHeight) continue;
      const targetFrame = await readStorageFrameRecord(handle.db, targetHeight);
      if (targetFrame?.materializedState !== false) {
        env.overlay = new Map();
        return;
      }
      // Replay of the exact Runtime inputs rebuilds the same in-memory dirty
      // map. Loading a second persisted overlay/diff is both redundant and a
      // consensus hazard because it can disagree with the reducer result.
      if (!(env.overlay instanceof Map)) {
        throw new Error(`STORAGE_REPLAY_OVERLAY_MISSING:${targetHeight}`);
      }
      return;
    }
    env.overlay = new Map();
  };

  const resolvePersistedLatestHeight = async (
    env: RuntimeReplica,
  ): Promise<number> => {
    const handles = await listPersistedStorageHandles(env);
    return handles.reduce(
      (max, handle) => Math.max(max, handle.latestHeight),
      0,
    );
  };

  const resolvePersistedCheckpointHeights = async (
    env: RuntimeReplica,
  ): Promise<number[]> => {
    const handles = await listPersistedStorageHandles(env);
    return Array.from(
      new Set(handles.flatMap(handle => handle.snapshotHeights)),
    ).sort((left, right) => left - right);
  };

  const readPersistedStorageFrameRecord = async (
    env: RuntimeReplica,
    height: number,
  ): Promise<
    ReturnType<typeof readStorageFrameRecord> extends Promise<infer T>
      ? T
      : never
  > => {
    const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
    if (targetHeight <= 0) return null;
    for (const handle of await listPersistedStorageHandles(env)) {
      if (targetHeight > handle.latestHeight) continue;
      const frame = await readStorageFrameRecord(handle.db, targetHeight);
      if (frame) return frame;
    }
    return null;
  };

  const readPersistedStorageFramePayloads = async (
    env: RuntimeReplica,
    frame: NonNullable<Awaited<ReturnType<typeof readStorageFrameRecord>>>,
  ): Promise<Awaited<ReturnType<typeof readStorageFramePayloads>>> => {
    for (const handle of await listPersistedStorageHandles(env)) {
      if (frame.height > handle.latestHeight) continue;
      return readStorageFramePayloads(handle.db, frame);
    }
    throw new Error(`STORAGE_FRAME_PAYLOAD_SOURCE_MISSING:${frame.height}`);
  };

  return {
    createPersistedStorageEnv,
    listPersistedStorageHandles,
    restoreOverlayFromFrameLog,
    resolvePersistedLatestHeight,
    resolvePersistedCheckpointHeights,
    readPersistedStorageFrameRecord,
    readPersistedStorageFramePayloads,
  };
};

type PersistedStorageNavigationApi = ReturnType<
  typeof createPersistedStorageNavigationApi
>;

const createPersistedStorageEntityReadApi = (
  deps: RuntimeStorageApiDeps,
  navigation: PersistedStorageNavigationApi,
) => {
  const { listPersistedStorageHandles } = navigation;

  const readPersistedStorageReplicaMetas = async (
    env: RuntimeReplica,
    entityId: string,
    sharedState?: EntityState,
  ): Promise<Awaited<ReturnType<typeof listStorageReplicaMetas>>> => {
    const normalizedEntityId = String(entityId || '').toLowerCase();
    if (!normalizedEntityId) return [];
    await requireStorageDbOpen(
      () => deps.tryOpenRuntimeWalDb(env),
      'runtime-wal:replica-metadata',
    );
    return listStorageReplicaMetas(
      deps.getRuntimeWalDb(env),
      normalizedEntityId,
      sharedState,
    );
  };

  const readPersistedStorageSnapshotReplicaMetas = async (
    env: RuntimeReplica,
    snapshotHeight: number,
    entityId: string,
    sharedState: EntityState,
  ): Promise<Awaited<ReturnType<typeof listStorageSnapshotReplicaMetas>>> => {
    const normalizedEntityId = String(entityId || '').toLowerCase();
    if (!normalizedEntityId || snapshotHeight <= 0) return [];
    await requireStorageDbOpen(
      () => deps.tryOpenRuntimeWalDb(env),
      'runtime-wal:snapshot-replica-metadata',
    );
    return listStorageSnapshotReplicaMetas(
      deps.getRuntimeWalDb(env),
      snapshotHeight,
      normalizedEntityId,
      sharedState,
    );
  };

  const resolvePersistedSnapshotHeight = async (
    env: RuntimeReplica,
    targetHeight: number,
  ): Promise<number> => {
    let best = 0;
    for (const handle of await listPersistedStorageHandles(env)) {
      if (targetHeight > handle.latestHeight) continue;
      const candidate = await findStorageLatestSnapshotAtOrBelow(
        handle.db,
        targetHeight,
      );
      if (candidate > best) best = candidate;
    }
    return best;
  };

  const listPersistedEntityIdsAtHeight = async (
    env: RuntimeReplica,
    targetHeight: number,
  ): Promise<string[]> => {
    const entityIds = new Set<string>();
    for (const handle of await listPersistedStorageHandles(env)) {
      const snapshotHeight = await findStorageLatestSnapshotAtOrBelow(
        handle.db,
        targetHeight,
      );
      if (snapshotHeight > 0) {
        const ids = await listStorageSnapshotEntityIds(
          handle.db,
          snapshotHeight,
        );
        for (const entityId of ids) entityIds.add(entityId);
      }
      const replayStartHeight = Math.max(1, snapshotHeight + 1);
      const replayEndHeight = Math.min(targetHeight, handle.latestHeight);
      for (
        let height = replayStartHeight;
        height <= replayEndHeight;
        height += 1
      ) {
        const frame = await readStorageFrameRecord(handle.db, height);
        for (const entityId of frame?.touchedEntities ?? []) {
          const normalized = String(entityId || '').toLowerCase();
          if (normalized) entityIds.add(normalized);
        }
        for (const account of frame?.touchedAccounts ?? []) {
          const entityId = String(account?.entityId || '').toLowerCase();
          if (entityId) entityIds.add(entityId);
          // The counterparty may be remote and have no Entity core document in
          // this Runtime. Graph projection creates that endpoint separately.
        }
        for (const entry of frame?.canonicalEntityHashes ?? []) {
          const entityId = String(entry?.entityId || '').toLowerCase();
          if (entityId) entityIds.add(entityId);
        }
      }
    }
    return Array.from(entityIds).sort();
  };

  return {
    readPersistedStorageReplicaMetas,
    readPersistedStorageSnapshotReplicaMetas,
    resolvePersistedSnapshotHeight,
    listPersistedEntityIdsAtHeight,
  };
};

export const createPersistedStorageReadApi = (
  deps: RuntimeStorageApiDeps,
) => {
  const navigation = createPersistedStorageNavigationApi(deps);
  const entityReads = createPersistedStorageEntityReadApi(deps, navigation);
  return { ...navigation, ...entityReads };
};

export type PersistedStorageReadApi = ReturnType<
  typeof createPersistedStorageReadApi
>;
