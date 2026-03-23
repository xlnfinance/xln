import { serializeTaggedJson } from '../serialization-utils';
import type { Env, FrameLogEntry, RuntimeInput } from '../types';
import { computePersistedEnvStateHash } from './hash';
import { replayFromSnapshotBuffer, selectReplayStart, type ReplaySnapshotDeps } from './replay';
import { buildRuntimeCheckpointSnapshot } from './snapshot';
import {
  buildPersistedFrameWriteOps,
  getPersistedLatestHeightFromDb,
  listPersistedSnapshotHeightsFromDb,
  readPersistedFrameJournalFromDb,
  readPersistedCheckpointHeight,
  readPersistedLatestHeight,
  readPersistedSchemaVersion,
  readPersistedSnapshotBuffer,
  verifyPersistedFrameWrite,
  writePersistedWalOps,
  type PersistedFrameJournal,
  type RuntimeWalDb,
  type RuntimeWalWritableDb,
} from './store';

export type SaveRuntimeFrameToWalOptions = {
  env: Env;
  currentFrameInput?: RuntimeInput;
  persistenceSchemaVersion: number;
  defaultSnapshotIntervalFrames: number;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeWalWritableDb;
  resolveDbNamespace: (options: { env: Env }) => string;
  ensureRuntimeState: (env: Env) => { persistencePaused?: boolean; db?: unknown };
  ensureRuntimeConfig: (env: Env) => { snapshotIntervalFrames?: number };
  hasUnsafePendingAccountStateForCheckpoint: (env: Env) => boolean;
  assertPersistedContractConfigReady: (env: Env, label: string) => void;
  isDbUnavailableError: (error: unknown) => boolean;
  getPerfMs: () => number;
  formatPerfMs: (ms: number) => string;
};

export const saveRuntimeFrameToWal = async (options: SaveRuntimeFrameToWalOptions): Promise<void> => {
  const {
    env,
    currentFrameInput,
    persistenceSchemaVersion,
    defaultSnapshotIntervalFrames,
    tryOpenDb,
    getRuntimeDb,
    resolveDbNamespace,
    ensureRuntimeState,
    ensureRuntimeConfig,
    hasUnsafePendingAccountStateForCheckpoint,
    assertPersistedContractConfigReady,
    isDbUnavailableError,
    getPerfMs,
    formatPerfMs,
  } = options;

  const state = ensureRuntimeState(env);
  if (state.persistencePaused) return;

  try {
    const persistStartedAt = getPerfMs();
    let openMs = 0;
    let frameSerializeMs = 0;
    let snapshotSerializeMs = 0;
    let writeMs = 0;
    let verifyMs = 0;
    let logsCloneMs = 0;
    let contractConfigMs = 0;
    let checkpointBuildMs = 0;
    let stateHashMs = 0;
    let opsBuildMs = 0;
    let frameJournalBytes = 0;
    let snapshotBytes = 0;

    const openStartedAt = getPerfMs();
    const dbReady = await tryOpenDb(env);
    openMs = getPerfMs() - openStartedAt;
    if (!dbReady) return;

    const dbNamespace = resolveDbNamespace({ env });
    const db = getRuntimeDb(env);
    const logsCloneStartedAt = getPerfMs();
    const committedFrameLogs = Array.isArray(env.frameLogs)
      ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
      : [];
    logsCloneMs = getPerfMs() - logsCloneStartedAt;

    const contractConfigStartedAt = getPerfMs();
    assertPersistedContractConfigReady(env, `saveEnvToDB frame=${env.height}`);
    contractConfigMs = getPerfMs() - contractConfigStartedAt;

    const checkpointInterval = ensureRuntimeConfig(env).snapshotIntervalFrames ?? defaultSnapshotIntervalFrames;
    const checkpointDue = env.height <= 1 || env.height % checkpointInterval === 0;
    const checkpointBlockedByPendingAccountState = checkpointDue && hasUnsafePendingAccountStateForCheckpoint(env);
    const shouldCheckpoint = checkpointDue && !checkpointBlockedByPendingAccountState;
    const checkpointBuildStartedAt = getPerfMs();
    const persistedSnapshot = buildRuntimeCheckpointSnapshot(env);
    checkpointBuildMs = getPerfMs() - checkpointBuildStartedAt;
    let runtimeStateHash: string | undefined;
    if (shouldCheckpoint) {
      const stateHashStartedAt = getPerfMs();
      runtimeStateHash = computePersistedEnvStateHash(persistedSnapshot);
      stateHashMs = getPerfMs() - stateHashStartedAt;
    }

    const frameSerializeStartedAt = getPerfMs();
    const frameJournal = serializeTaggedJson({
      height: env.height,
      timestamp: env.timestamp,
      runtimeInput: currentFrameInput ?? { runtimeTxs: [], entityInputs: [] },
      ...(runtimeStateHash ? { runtimeStateHash } : {}),
      logs: committedFrameLogs,
    } satisfies PersistedFrameJournal);
    frameSerializeMs = getPerfMs() - frameSerializeStartedAt;
    frameJournalBytes = Buffer.byteLength(frameJournal);
    let checkpointSnapshot: string | undefined;

    if (shouldCheckpoint) {
      const snapshotSerializeStartedAt = getPerfMs();
      checkpointSnapshot = serializeTaggedJson({
        ...persistedSnapshot,
        ...(runtimeStateHash ? { runtimeStateHash } : {}),
      });
      snapshotSerializeMs = getPerfMs() - snapshotSerializeStartedAt;
      snapshotBytes = Buffer.byteLength(checkpointSnapshot);
    } else if (checkpointBlockedByPendingAccountState) {
      console.warn(
        `[PERSIST] checkpoint skipped at frame=${env.height} due to pending bilateral account state; keeping previous safe checkpoint`,
      );
    }

    const opsBuildStartedAt = getPerfMs();
    const ops = buildPersistedFrameWriteOps({
      namespace: dbNamespace,
      schemaVersion: persistenceSchemaVersion,
      height: env.height,
      frameJournal,
      checkpointSnapshot,
    });
    opsBuildMs = getPerfMs() - opsBuildStartedAt;

    if (state.persistencePaused) return;
    const writeStartedAt = getPerfMs();
    try {
      await writePersistedWalOps(db, ops);
    } catch (batchError) {
      if ((state.persistencePaused || ensureRuntimeState(env).db !== db) && isDbUnavailableError(batchError)) {
        console.warn(`⚠️ DB batch write aborted during reset/pause: frame ${env.height}`);
        return;
      }
      throw batchError;
    }
    writeMs = getPerfMs() - writeStartedAt;

    let verifySkipped = false;
    if (state.persistencePaused || ensureRuntimeState(env).db !== db) {
      verifySkipped = true;
    }
    if (!verifySkipped) {
      const verifyStartedAt = getPerfMs();
      try {
        const latestHeight = await verifyPersistedFrameWrite(db, dbNamespace, env.height);
        if (!Number.isFinite(latestHeight) || latestHeight !== env.height) {
          throw new Error(
            `PERSISTENCE_FATAL: latest_height mismatch after write: expected=${env.height} actual=${String(latestHeight)}`,
          );
        }
      } catch (verifyError) {
        if ((state.persistencePaused || ensureRuntimeState(env).db !== db) && isDbUnavailableError(verifyError)) {
          console.warn(`⚠️ DB verify aborted during reset/pause: frame ${env.height}`);
          return;
        }
        throw new Error(`PERSISTENCE_FATAL: write verification failed at frame ${env.height}: ${String(verifyError)}`);
      }
      verifyMs = getPerfMs() - verifyStartedAt;
    }

    const totalMs = getPerfMs() - persistStartedAt;
    console.log(
      `[PERSIST] frame=${env.height} checkpoint=${shouldCheckpoint ? 1 : 0} ` +
        `logs=${committedFrameLogs.length} ops=${ops.length} ` +
        `bytes(frame=${frameJournalBytes},snapshot=${snapshotBytes}) ` +
        `ms(open=${formatPerfMs(openMs)},logs=${formatPerfMs(logsCloneMs)},contracts=${formatPerfMs(contractConfigMs)},` +
        `checkpointBuild=${formatPerfMs(checkpointBuildMs)},stateHash=${formatPerfMs(stateHashMs)},frame=${formatPerfMs(frameSerializeMs)},` +
        `snapshot=${formatPerfMs(snapshotSerializeMs)},ops=${formatPerfMs(opsBuildMs)},write=${formatPerfMs(writeMs)},` +
        `verify=${verifySkipped ? 'skip' : formatPerfMs(verifyMs)},total=${formatPerfMs(totalMs)})`,
    );
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (state.persistencePaused && isDbUnavailableError(err)) {
      console.warn(`⚠️ DB save aborted during reset/pause: ${reason}`);
      return;
    }
    console.error('❌ Failed to save to LevelDB:', err);
    throw new Error(`PERSISTENCE_FATAL: ${reason}`);
  }
};

export type LoadRuntimeEnvFromWalOptions = {
  runtimeId?: string | null;
  runtimeSeed?: string | null;
  fromSnapshotHeight?: number;
  persistenceSchemaVersion: number;
  createEmptyEnv: (seed?: Uint8Array | string | null) => Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeWalDb;
  resolveDbNamespace: (options: { runtimeId?: string | null; runtimeSeed?: string | null; env: Env }) => string;
  isDbNotFound: (error: unknown) => boolean;
  replayDeps: ReplaySnapshotDeps;
};

export const loadRuntimeEnvFromWal = async (options: LoadRuntimeEnvFromWalOptions): Promise<Env | null> => {
  const {
    runtimeId,
    runtimeSeed,
    fromSnapshotHeight,
    persistenceSchemaVersion,
    createEmptyEnv,
    tryOpenDb,
    getRuntimeDb,
    resolveDbNamespace,
    isDbNotFound,
    replayDeps,
  } = options;

  const tempEnv = createEmptyEnv(runtimeSeed ?? null);
  if (runtimeId) {
    tempEnv.runtimeId = runtimeId;
    tempEnv.dbNamespace = runtimeId;
  }
  const dbReady = await tryOpenDb(tempEnv);
  if (!dbReady) return null;

  const dbNamespace = resolveDbNamespace({ runtimeId, runtimeSeed, env: tempEnv });
  const db = getRuntimeDb(tempEnv);
  let latestHeight = 0;

  try {
    const schemaVersion = await readPersistedSchemaVersion(db, dbNamespace);
    if (!Number.isFinite(schemaVersion) || schemaVersion !== persistenceSchemaVersion) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=n/a latest=n/a restored=n/a reason=Unsupported persistence schema (${schemaVersion})`,
      );
    }
    latestHeight = await readPersistedLatestHeight(db, dbNamespace);
  } catch (error) {
    if (isDbNotFound(error)) return null;
    throw error;
  }

  let checkpointHeight = 0;
  try {
    checkpointHeight = await readPersistedCheckpointHeight(db, dbNamespace);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=n/a latest=${latestHeight} restored=n/a reason=Missing latest_checkpoint_height pointer (${message})`,
    );
  }
  if (!Number.isFinite(checkpointHeight) || checkpointHeight < 0 || checkpointHeight > latestHeight) {
    throw new Error(
      `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=${String(checkpointHeight)} latest=${latestHeight} restored=n/a reason=Invalid checkpoint pointer`,
    );
  }
  if (latestHeight > 0 && checkpointHeight < 1) {
    throw new Error(
      `REPLAY_INVARIANT_FAILED: frame=n/a checkpoint=${String(checkpointHeight)} latest=${latestHeight} restored=n/a reason=Missing durable checkpoint`,
    );
  }

  console.log(`[loadEnvFromDB] namespace=${dbNamespace} latest=${latestHeight} checkpoint=${checkpointHeight}`);
  let checkpointBuffer: Buffer;
  try {
    checkpointBuffer = await readPersistedSnapshotBuffer(db, dbNamespace, checkpointHeight);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `REPLAY_INVARIANT_FAILED: frame=${checkpointHeight} checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing checkpoint snapshot (${message})`,
    );
  }

  const replayFromSnapshot = async (
    selectedSnapshotHeight: number,
    selectedSnapshotLabel: string,
    snapshotBuffer: Buffer,
  ): Promise<Env> => {
    return replayFromSnapshotBuffer({
      db,
      dbNamespace,
      tempEnv,
      latestHeight,
      checkpointHeight,
      selectedSnapshotHeight,
      selectedSnapshotLabel,
      snapshotBuffer,
      deps: replayDeps,
    });
  };

  const replayStart = selectReplayStart(checkpointHeight, fromSnapshotHeight);
  if (replayStart.snapshotHeight !== checkpointHeight) {
    let selectedSnapshotBuffer: Buffer;
    try {
      selectedSnapshotBuffer = await readPersistedSnapshotBuffer(db, dbNamespace, replayStart.snapshotHeight);
    } catch (selectedSnapshotError) {
      const message =
        selectedSnapshotError instanceof Error
          ? `${selectedSnapshotError.name}: ${selectedSnapshotError.message}`
          : String(selectedSnapshotError);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=${replayStart.snapshotHeight} checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing selected snapshot (${message})`,
      );
    }
    return replayFromSnapshot(replayStart.snapshotHeight, replayStart.snapshotLabel, selectedSnapshotBuffer);
  }

  return replayFromSnapshot(replayStart.snapshotHeight, replayStart.snapshotLabel, checkpointBuffer);
};

export const listPersistedCheckpointHeights = async (
  env: Env,
  options: {
    tryOpenDb: (env: Env) => Promise<boolean>;
    getRuntimeDb: (env: Env) => RuntimeWalDb;
    resolveDbNamespace: (options: { env: Env }) => string;
    isDbUnavailableError: (error: unknown) => boolean;
    isDbNotFound: (error: unknown) => boolean;
  },
): Promise<number[]> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return [];
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  const latestHeight = await getPersistedLatestHeightFromDb(db, dbNamespace, options.isDbUnavailableError);
  if (latestHeight <= 0) return [];
  return listPersistedSnapshotHeightsFromDb(db, dbNamespace, latestHeight, options.isDbNotFound);
};

export type VerifyRuntimeChainResult = {
  ok: true;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  restoredHeight: number;
  expectedStateHash: string;
  actualStateHash: string;
};

export const verifyRuntimeChainFromWal = async (
  options: LoadRuntimeEnvFromWalOptions & {
    fromSnapshotHeight?: number;
  },
): Promise<VerifyRuntimeChainResult> => {
  const env = await loadRuntimeEnvFromWal(options);
  if (!env) {
    throw new Error('REPLAY_INVARIANT_FAILED: no persisted runtime state');
  }

  const tempEnv = options.createEmptyEnv(options.runtimeSeed ?? null);
  if (options.runtimeId) {
    tempEnv.runtimeId = options.runtimeId;
    tempEnv.dbNamespace = options.runtimeId;
  }
  const dbReady = await options.tryOpenDb(tempEnv);
  if (!dbReady) {
    throw new Error('REPLAY_INVARIANT_FAILED: runtime DB unavailable');
  }

  const dbNamespace = options.resolveDbNamespace({
    runtimeId: options.runtimeId,
    runtimeSeed: options.runtimeSeed,
    env: tempEnv,
  });
  const db = options.getRuntimeDb(tempEnv);
  const latestHeight = await readPersistedLatestHeight(db, dbNamespace);
  const checkpointHeight = await readPersistedCheckpointHeight(db, dbNamespace);
  const latestFrame = await readPersistedFrameJournalFromDb(db, dbNamespace, latestHeight, options.isDbNotFound);
  const expectedStateHash = latestFrame?.runtimeStateHash ?? '';
  let actualStateHash = '';
  if (expectedStateHash) {
    actualStateHash = computePersistedEnvStateHash(buildRuntimeCheckpointSnapshot(env));
    if (actualStateHash !== expectedStateHash) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=${latestHeight} checkpoint=${checkpointHeight} latest=${latestHeight} restored=${env.height} reason=State hash mismatch expected=${expectedStateHash} actual=${actualStateHash}`,
      );
    }
  }

  return {
    ok: true,
    latestHeight,
    checkpointHeight,
    selectedSnapshotHeight: Number.isFinite(options.fromSnapshotHeight)
      ? Math.floor(Number(options.fromSnapshotHeight))
      : checkpointHeight,
    restoredHeight: env.height,
    expectedStateHash,
    actualStateHash,
  };
};

export const getPersistedLatestHeight = async (
  env: Env,
  options: {
    tryOpenDb: (env: Env) => Promise<boolean>;
    getRuntimeDb: (env: Env) => RuntimeWalDb;
    resolveDbNamespace: (options: { env: Env }) => string;
    isDbUnavailableError: (error: unknown) => boolean;
  },
): Promise<number> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return 0;
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  return getPersistedLatestHeightFromDb(db, dbNamespace, options.isDbUnavailableError);
};

export const readPersistedFrameJournal = async (
  env: Env,
  height: number,
  options: {
    tryOpenDb: (env: Env) => Promise<boolean>;
    getRuntimeDb: (env: Env) => RuntimeWalDb;
    resolveDbNamespace: (options: { env: Env }) => string;
    isDbUnavailableError: (error: unknown) => boolean;
  },
): Promise<PersistedFrameJournal | null> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return null;
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  return readPersistedFrameJournalFromDb(db, dbNamespace, height, options.isDbUnavailableError);
};

export const readPersistedFrameJournals = async (
  env: Env,
  frameOptions: {
    fromHeight?: number;
    toHeight?: number;
    limit?: number;
  } | undefined,
  options: {
    tryOpenDb: (env: Env) => Promise<boolean>;
    getRuntimeDb: (env: Env) => RuntimeWalDb;
    resolveDbNamespace: (options: { env: Env }) => string;
    isDbUnavailableError: (error: unknown) => boolean;
  },
): Promise<PersistedFrameJournal[]> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return [];
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  const latestHeight = await getPersistedLatestHeightFromDb(db, dbNamespace, options.isDbUnavailableError);
  if (latestHeight <= 0) return [];

  const fromHeight = Math.max(1, Math.floor(frameOptions?.fromHeight ?? 1));
  const boundedToHeight = Math.max(fromHeight, Math.floor(frameOptions?.toHeight ?? latestHeight));
  const toHeight = Math.min(latestHeight, boundedToHeight);
  const limit = Math.max(1, Math.min(1000, Math.floor(frameOptions?.limit ?? 200)));
  const startHeight = Math.max(fromHeight, toHeight - limit + 1);
  const receipts: PersistedFrameJournal[] = [];

  for (let height = startHeight; height <= toHeight; height += 1) {
    const receipt = await readPersistedFrameJournalFromDb(db, dbNamespace, height, options.isDbUnavailableError);
    if (receipt) receipts.push(receipt);
  }

  return receipts;
};
