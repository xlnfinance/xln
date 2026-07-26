import {
  inspectStorage,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
  readStorageHead,
  type StorageHead,
} from '../storage';
import {
  resolveFrameDbPath,
  resolveStorageDbPath,
} from '../storage/runtime-dbs';
import { verifyStorageTailIntegrity } from '../storage/verify';
import { assertCertifiedJHistoryIntegrity } from '../jurisdiction/local-history';
import type { RuntimeAdapterReadQuery } from '../radapter';
import type { EntityState, Env } from '../types';
import type { PersistenceQueryDeps } from './query-deps';

export const createPersistenceEntityQueries = (deps: PersistenceQueryDeps) => {
  const getPersistedLatestHeight = (env: Env): Promise<number> =>
    deps.resolvePersistedLatestHeight(env);

  const loadEntityStateFromStorageDb = async (
    env: Env,
    entityId: string,
    height?: number,
  ): Promise<EntityState | null> => {
    const state = await loadEntityStateFromStorage({
      env,
      tryOpenDb: deps.tryOpenFrameDb,
      getRuntimeDb: deps.getFrameDb,
      entityId,
      ...(height === undefined ? {} : { height }),
      liveStateReadable: false,
    });
    if (state) assertCertifiedJHistoryIntegrity(state);
    return state;
  };

  const loadEntityAccountDocFromStorageDb = (
    env: Env,
    entityId: string,
    counterpartyId: string,
    height?: number,
  ) => loadEntityAccountDocFromStorage({
    env,
    tryOpenDb: deps.tryOpenFrameDb,
    getRuntimeDb: deps.getFrameDb,
    entityId,
    counterpartyId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });

  const loadEntityViewPageFromStorageDb = (
    env: Env,
    entityId: string,
    height: number,
    query?: RuntimeAdapterReadQuery,
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
      tryOpenDb: deps.tryOpenFrameDb,
      getRuntimeDb: deps.getFrameDb,
      entityId,
      height,
      accountQuery,
      bookQuery,
      liveStateReadable: false,
    });
  };

  const inspectStorageDb = async (env: Env) => {
    const current = await inspectStorage({
      env,
      tryOpenDb: (targetEnv) => deps.tryOpenStorageDb(targetEnv, 'current'),
      getRuntimeDb: (targetEnv) => deps.getStorageDb(targetEnv, 'current'),
    });
    const history = await inspectStorage({
      env,
      tryOpenDb: deps.tryOpenFrameDb,
      getRuntimeDb: deps.getFrameDb,
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
            path: resolveFrameDbPath(env),
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

  const listPersistedCheckpointHeights = (env: Env): Promise<number[]> =>
    deps.resolvePersistedCheckpointHeights(env);

  const readPersistedStorageHead = async (env: Env): Promise<StorageHead | null> => {
    if (!(await deps.tryOpenFrameDb(env))) return null;
    return readStorageHead(deps.getFrameDb(env));
  };

  const verifyLiveRuntimeStorage = async (env: Env): Promise<{
    ok: true;
    runtimeId: string;
    latestHeight: number;
    checkedFrames: number;
  }> => {
    if (!(await deps.tryOpenFrameDb(env))) throw new Error('LIVE_RUNTIME_STORAGE_UNAVAILABLE');
    return deps.withStorageConsistentRead(env, async () => {
      const result = await verifyStorageTailIntegrity(deps.getFrameDb(env));
      return { ok: true, runtimeId: String(env.runtimeId || ''), ...result };
    });
  };

  return {
    getPersistedLatestHeight,
    loadEntityStateFromStorageDb,
    loadEntityAccountDocFromStorageDb,
    loadEntityViewPageFromStorageDb,
    inspectStorageDb,
    listPersistedCheckpointHeights,
    readPersistedStorageHead,
    verifyLiveRuntimeStorage,
  };
};
