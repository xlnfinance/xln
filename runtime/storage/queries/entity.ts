import {
  inspectStorage,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
  readStorageHead,
  type StorageHead,
} from '..';
import {
  resolveRuntimeWalDbPath,
  resolveStorageDbPath,
} from '../runtime-dbs';
import { verifyStorageTailIntegrity } from '../read/verify';
import { assertCertifiedJHistoryIntegrity } from '../../jurisdiction/machine/local-history';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { PersistenceQueryDeps } from './deps';
import { requireStorageDbOpen } from '../commit/availability';

/**
 * Pagination understood by the persisted Entity view.
 *
 * Keep this storage-owned shape narrower than RuntimeAdapterReadQuery. The
 * adapter accepts many unrelated transport filters; storage must not depend on
 * that public transport surface merely to page accounts and books.
 */
export type StorageEntityViewQuery = {
  cursor?: string;
  limit?: number;
  accountsCursor?: string;
  booksCursor?: string;
  accountsLimit?: number;
  booksLimit?: number;
  sortDir?: 'asc' | 'desc';
};

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
          diffCount: current.diffCount,
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
          diffCount: history.diffCount,
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
    diffCount: history?.diffCount ?? 0,
    snapshotHeights: Array.from(new Set(history?.snapshotHeights ?? []))
      .sort((left, right) => left - right),
    liveEntityCount: current?.liveEntityCount ?? 0,
    liveAccountCount: current?.liveAccountCount ?? 0,
    liveAccountFieldCount: current?.liveAccountFieldCount ?? 0,
    liveAccountFieldBytes: current?.liveAccountFieldBytes ?? 0,
    liveBookCount: current?.liveBookCount ?? 0,
    frameBytes: history?.frameBytes ?? 0,
    diffBytes: history?.diffBytes ?? 0,
    snapshotBytes: history?.snapshotBytes ?? 0,
    liveBytes: current?.liveBytes ?? 0,
    historyBytes: history?.historyBytes ?? 0,
    totalBytes: (current?.liveBytes ?? 0) + (history?.historyBytes ?? 0),
    maxFrameBytes: history?.maxFrameBytes ?? 0,
    maxDiffBytes: history?.maxDiffBytes ?? 0,
    maxSnapshotBytes: history?.maxSnapshotBytes ?? 0,
    epochDbs,
  };
};

export const createPersistenceEntityQueries = (deps: PersistenceQueryDeps) => {
  const getPersistedLatestHeight = (env: RuntimeReplica): Promise<number> =>
    deps.resolvePersistedLatestHeight(env);

  const loadEntityStateFromStorageDb = async (
    env: RuntimeReplica,
    entityId: string,
    height?: number,
  ): Promise<EntityState | null> => {
    const state = await loadEntityStateFromStorage({
      env,
      tryOpenDb: deps.tryOpenRuntimeWalDb,
      getRuntimeDb: deps.getRuntimeWalDb,
      entityId,
      ...(height === undefined ? {} : { height }),
      liveStateReadable: false,
    });
    if (state) assertCertifiedJHistoryIntegrity(state);
    return state;
  };

  const loadEntityAccountDocFromStorageDb = (
    env: RuntimeReplica,
    entityId: string,
    counterpartyId: string,
    height?: number,
  ) => loadEntityAccountDocFromStorage({
    env,
    tryOpenDb: deps.tryOpenRuntimeWalDb,
    getRuntimeDb: deps.getRuntimeWalDb,
    entityId,
    counterpartyId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });

  const loadEntityViewPageFromStorageDb = (
    env: RuntimeReplica,
    entityId: string,
    height: number,
    query?: StorageEntityViewQuery,
  ) => {
    const accountQuery = {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.accountsCursor ? { cursor: query.accountsCursor } : {}),
      ...(query?.accountsLimit !== undefined
        ? { limit: query.accountsLimit }
        : query?.limit !== undefined ? { limit: query.limit } : {}),
      ...(query?.sortDir ? { sortDir: query.sortDir } : {}),
    };
    const bookCursor = query?.booksCursor ?? (query?.accountsCursor ? undefined : query?.cursor);
    const bookQuery = {
      ...(bookCursor ? { cursor: bookCursor } : {}),
      ...(query?.booksLimit !== undefined
        ? { limit: query.booksLimit }
        : query?.limit !== undefined ? { limit: query.limit } : {}),
    };
    return loadEntityViewPageFromStorage({
      env,
      tryOpenDb: deps.tryOpenRuntimeWalDb,
      getRuntimeDb: deps.getRuntimeWalDb,
      entityId,
      height,
      accountQuery,
      bookQuery,
      liveStateReadable: false,
    });
  };

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
