import {
  inspectStorage,
  readStorageHead,
  type StorageHead,
} from '..';
import {
  resolveRuntimeWalDbPath,
  resolveStorageDbPath,
} from '../runtime-dbs';
import { verifyStorageTailIntegrity } from '../read/verify';
import { assertCertifiedJHistoryIntegrity } from '../../jurisdiction/machine/local-history';
import { projectAccountDoc } from '../read/projections';
import { normalizeEntityId } from '../keys';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { PersistenceQueryDeps } from './deps';
import { requireStorageDbOpen } from '../commit/availability';
import {
  findReplicaForEntityId,
  projectEntityViewPageFromReplica,
  type StorageEntityViewQuery,
} from './entity-view-page';

export type { StorageEntityViewQuery } from './entity-view-page';

const inspectRuntimeStorage = async (
  deps: PersistenceQueryDeps,
  env: RuntimeReplica,
) => {
  const current = await inspectStorage({
    env,
    tryOpenDb: (targetEnv) => deps.tryOpenStorageDb(targetEnv, 'current'),
    getRuntimeDb: (targetEnv) => deps.getStorageDb(targetEnv, 'current'),
  });
  const history = await inspectStorage({
    env,
    tryOpenDb: deps.tryOpenRuntimeWalDb,
    getRuntimeDb: deps.getRuntimeWalDb,
  });
  if (!current && !history) return null;

  const epochDbs = [
    current
      ? {
          role: 'current' as const,
          path: resolveStorageDbPath(env, 'current'),
          latestHeight: current.head?.latestHeight ?? 0,
          latestSnapshotHeight: current.head?.latestSnapshotHeight ?? 0,
          frameCount: current.frameCount,
          snapshotCount: current.snapshotHeights.length,
          liveBytes: current.liveBytes,
          historyBytes: current.historyBytes,
          totalBytes: current.totalBytes,
        }
      : null,
    history
      ? {
          role: 'history' as const,
          path: resolveRuntimeWalDbPath(env),
          latestHeight: history.head?.latestHeight ?? 0,
          latestSnapshotHeight: history.head?.latestSnapshotHeight ?? 0,
          frameCount: history.frameCount,
          snapshotCount: history.snapshotHeights.length,
          liveBytes: history.liveBytes,
          historyBytes: history.historyBytes,
          totalBytes: history.totalBytes,
        }
      : null,
  ].filter(Boolean);

  return {
    head: history?.head ?? current?.head ?? null,
    frameCount: history?.frameCount ?? 0,
    snapshotHeights: Array.from(new Set(history?.snapshotHeights ?? []))
      .sort((left, right) => left - right),
    liveEntityCount: current?.liveEntityCount ?? 0,
    liveAccountCount: current?.liveAccountCount ?? 0,
    liveAccountFieldCount: current?.liveAccountFieldCount ?? 0,
    liveAccountFieldBytes: current?.liveAccountFieldBytes ?? 0,
    liveBookCount: current?.liveBookCount ?? 0,
    frameBytes: history?.frameBytes ?? 0,
    boundedValueCount: history?.boundedValueCount ?? 0,
    boundedValueBytes: history?.boundedValueBytes ?? 0,
    historyViewBytes: history?.historyViewBytes ?? 0,
    snapshotBytes: history?.snapshotBytes ?? 0,
    liveBytes: current?.liveBytes ?? 0,
    historyBytes: history?.historyBytes ?? 0,
    totalBytes:
      (current?.liveBytes ?? 0) +
      (history?.historyBytes ?? 0) +
      (history?.historyViewBytes ?? 0),
    maxFrameBytes: history?.maxFrameBytes ?? 0,
    maxPhysicalValueBytes: Math.max(
      current?.maxPhysicalValueBytes ?? 0,
      history?.maxPhysicalValueBytes ?? 0,
    ),
    maxSnapshotBytes: history?.maxSnapshotBytes ?? 0,
    epochDbs,
  };
};

export const createPersistenceEntityQueries = (deps: PersistenceQueryDeps) => {
  const getPersistedLatestHeight = (env: RuntimeReplica): Promise<number> =>
    deps.resolvePersistedLatestHeight(env);

  const withReplayedEnv = async <T>(
    env: RuntimeReplica,
    height: number | undefined,
    read: (restored: RuntimeReplica) => Promise<T | null>,
  ): Promise<T | null> => {
    return deps.withStorageConsistentRead(env, async () => {
      // Opening the source handle is part of the borrow contract even when a
      // caller supplies an exact historical height. Historical inspection has
      // exactly one path: replay the authoritative Runtime input journal.
      const latestHeight = await deps.resolvePersistedLatestHeight(env);
      const restored = await deps.loadEnvFromStorageByReplay(
        env.runtimeId,
        env.runtimeSeed,
        height ?? latestHeight,
        {
          prunedTargetReturnsNull: true,
          borrowRuntimeWalFrom: env,
          readOnly: true,
        },
      );
      if (!restored) return null;
      try {
        return await read(restored.env);
      } finally {
        await deps.closeRuntimeDb(restored.env);
      }
    });
  };

  const loadEntityStateFromStorageDb = (
    env: RuntimeReplica,
    entityId: string,
    height?: number,
  ): Promise<EntityState | null> => withReplayedEnv(env, height, async restored => {
    const replica = findReplicaForEntityId(restored.state.eReplicas.values(), entityId);
    if (!replica) return null;
    assertCertifiedJHistoryIntegrity(replica.state);
    return replica.state;
  });

  const loadEntityAccountDocFromStorageDb = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    height?: number,
  ) => withReplayedEnv(env, height, async restored => {
    const replica = findReplicaForEntityId(restored.state.eReplicas.values(), entityId);
    if (!replica) return null;
    const account = replica.state.accounts.get(normalizeEntityId(counterpartyId));
    return account ? projectAccountDoc(account) : null;
  });

  const loadEntityViewPageFromStorageDb = (
    env: RuntimeReplica,
    entityId: string,
    height: number,
    query?: StorageEntityViewQuery,
  ) => withReplayedEnv(env, height, async restored => {
    const replica = findReplicaForEntityId(restored.state.eReplicas.values(), entityId);
    if (!replica) return null;
    assertCertifiedJHistoryIntegrity(replica.state);
    return projectEntityViewPageFromReplica(replica, query);
  });

  const listPersistedCheckpointHeights = (env: RuntimeReplica): Promise<number[]> =>
    deps.resolvePersistedCheckpointHeights(env);

  const readPersistedStorageHead = async (env: RuntimeReplica): Promise<StorageHead | null> => {
    await requireStorageDbOpen(
      () => deps.tryOpenRuntimeWalDb(env),
      'runtime-wal:head',
    );
    return readStorageHead(deps.getRuntimeWalDb(env));
  };

  const verifyLiveRuntimeStorage = async (env: RuntimeReplica): Promise<{
    ok: true;
    runtimeId: string;
    latestHeight: number;
    checkedFrames: number;
  }> => {
    if (!(await deps.tryOpenRuntimeWalDb(env))) throw new Error('LIVE_RUNTIME_STORAGE_UNAVAILABLE');
    return deps.withStorageConsistentRead(env, async () => {
      const result = await verifyStorageTailIntegrity(deps.getRuntimeWalDb(env));
      return { ok: true, runtimeId: String(env.runtimeId || ''), ...result };
    });
  };

  return {
    getPersistedLatestHeight,
    loadEntityStateFromStorageDb,
    loadEntityAccountDocFromStorageDb,
    loadEntityViewPageFromStorageDb,
    inspectStorageDb: (env: RuntimeReplica) => inspectRuntimeStorage(deps, env),
    listPersistedCheckpointHeights,
    readPersistedStorageHead,
    verifyLiveRuntimeStorage,
  };
};
