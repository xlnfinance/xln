import { serializeTaggedJson } from '../serialization-utils';
import type { Env, FrameLogEntry, RuntimeInput } from '../types';
import { computePersistedEnvStateHash } from './hash';
import { replayFromSnapshotBuffer, selectReplayRetryFromGenesis, selectReplayStart, type ReplaySnapshotDeps } from './replay';
import { buildRuntimeCheckpointSnapshot } from './snapshot';
import {
  buildPersistedFrameWriteOps,
  getPersistedLatestHeightFromDb,
  readPersistedCheckpointHeight,
  readPersistedLatestHeight,
  readPersistedSchemaVersion,
  readPersistedSnapshotBuffer,
  verifyPersistedFrameWrite,
  writePersistedWalOps,
  writePersistedWalOpsSequential,
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
    let frameJournalBytes = 0;
    let snapshotBytes = 0;

    const openStartedAt = getPerfMs();
    const dbReady = await tryOpenDb(env);
    openMs = getPerfMs() - openStartedAt;
    if (!dbReady) return;

    const dbNamespace = resolveDbNamespace({ env });
    const db = getRuntimeDb(env);
    const committedFrameLogs = Array.isArray(env.frameLogs)
      ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
      : [];

    assertPersistedContractConfigReady(env, `saveEnvToDB frame=${env.height}`);
    const persistedSnapshot = buildRuntimeCheckpointSnapshot(env);
    const runtimeStateHash = computePersistedEnvStateHash(persistedSnapshot);

    const frameSerializeStartedAt = getPerfMs();
    const frameJournal = serializeTaggedJson({
      height: env.height,
      timestamp: env.timestamp,
      runtimeInput: currentFrameInput ?? { runtimeTxs: [], entityInputs: [] },
      runtimeStateHash,
      logs: committedFrameLogs,
    } satisfies PersistedFrameJournal);
    frameSerializeMs = getPerfMs() - frameSerializeStartedAt;
    frameJournalBytes = Buffer.byteLength(frameJournal);

    const checkpointInterval = ensureRuntimeConfig(env).snapshotIntervalFrames ?? defaultSnapshotIntervalFrames;
    const checkpointDue = env.height <= 1 || env.height % checkpointInterval === 0;
    const checkpointBlockedByPendingAccountState = checkpointDue && hasUnsafePendingAccountStateForCheckpoint(env);
    const shouldCheckpoint = checkpointDue && !checkpointBlockedByPendingAccountState;
    let checkpointSnapshot: string | undefined;

    if (shouldCheckpoint) {
      const snapshotSerializeStartedAt = getPerfMs();
      checkpointSnapshot = serializeTaggedJson({
        ...persistedSnapshot,
        runtimeStateHash,
      });
      snapshotSerializeMs = getPerfMs() - snapshotSerializeStartedAt;
      snapshotBytes = Buffer.byteLength(checkpointSnapshot);
    } else if (checkpointBlockedByPendingAccountState) {
      console.warn(
        `[PERSIST] checkpoint skipped at frame=${env.height} due to pending bilateral account state; keeping previous safe checkpoint`,
      );
    }

    const ops = buildPersistedFrameWriteOps({
      namespace: dbNamespace,
      schemaVersion: persistenceSchemaVersion,
      height: env.height,
      frameJournal,
      checkpointSnapshot,
    });

    if (state.persistencePaused) return;
    const writeStartedAt = getPerfMs();
    let wrote = false;
    try {
      await writePersistedWalOps(db, ops);
      wrote = true;
    } catch (batchError) {
      console.warn('⚠️ db.batch().write() failed, falling back to sequential put:', batchError);
    }
    if (!wrote) {
      try {
        await writePersistedWalOpsSequential(db, ops);
      } catch (putError) {
        if ((state.persistencePaused || ensureRuntimeState(env).db !== db) && isDbUnavailableError(putError)) {
          console.warn(`⚠️ DB write aborted during reset/pause: frame ${env.height}`);
          return;
        }
        throw putError;
      }
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
        `ms(open=${formatPerfMs(openMs)},frame=${formatPerfMs(frameSerializeMs)},snapshot=${formatPerfMs(snapshotSerializeMs)},` +
        `write=${formatPerfMs(writeMs)},verify=${verifySkipped ? 'skip' : formatPerfMs(verifyMs)},total=${formatPerfMs(totalMs)})`,
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
  fromGenesis?: boolean;
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
    fromGenesis,
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
      requestedFromGenesis: fromGenesis === true,
      snapshotBuffer,
      deps: replayDeps,
    });
  };

  const replayStart = selectReplayStart(fromGenesis === true ? 'force-genesis' : 'default', checkpointHeight);
  if (replayStart.source === 'forced-genesis') {
    let genesisSnapshotBuffer: Buffer;
    try {
      genesisSnapshotBuffer = await readPersistedSnapshotBuffer(db, dbNamespace, 1);
    } catch (genesisError) {
      const message = genesisError instanceof Error ? `${genesisError.name}: ${genesisError.message}` : String(genesisError);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=1 checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing genesis snapshot (${message})`,
      );
    }
    const latestEnv = await replayFromSnapshot(replayStart.snapshotHeight, replayStart.snapshotLabel, genesisSnapshotBuffer);
    console.warn(
      `[loadEnvFromDB] forced genesis replay requested; ignored checkpoint=${checkpointHeight} latest=${latestHeight}`,
    );
    return latestEnv;
  }

  try {
    return await replayFromSnapshot(replayStart.snapshotHeight, replayStart.snapshotLabel, checkpointBuffer);
  } catch (checkpointReplayError) {
    const checkpointMessage =
      checkpointReplayError instanceof Error ? checkpointReplayError.message : String(checkpointReplayError);
    if (checkpointHeight <= 1) {
      throw checkpointReplayError;
    }
    console.warn(
      `[loadEnvFromDB] checkpoint replay failed at h=${checkpointHeight}; retrying from genesis snapshot. reason=${checkpointMessage}`,
    );
    let genesisSnapshotBuffer: Buffer;
    try {
      genesisSnapshotBuffer = await readPersistedSnapshotBuffer(db, dbNamespace, 1);
    } catch (genesisError) {
      const message = genesisError instanceof Error ? `${genesisError.name}: ${genesisError.message}` : String(genesisError);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: frame=1 checkpoint=${checkpointHeight} latest=${latestHeight} restored=n/a reason=Missing genesis snapshot (${message})`,
      );
    }
    const retryReplayStart = selectReplayRetryFromGenesis();
    try {
      return await replayFromSnapshot(
        retryReplayStart.snapshotHeight,
        retryReplayStart.snapshotLabel,
        genesisSnapshotBuffer,
      );
    } catch (genesisReplayError) {
      const genesisMessage =
        genesisReplayError instanceof Error ? genesisReplayError.message : String(genesisReplayError);
      throw new Error(
        `REPLAY_INVARIANT_FAILED: checkpoint_retry_failed checkpoint_reason=${checkpointMessage} genesis_reason=${genesisMessage}`,
      );
    }
  }
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
    readPersistedFrameJournalFromDb: (
      db: RuntimeWalDb,
      namespace: string,
      height: number,
      isDbUnavailableError: (error: unknown) => boolean,
    ) => Promise<PersistedFrameJournal | null>;
  },
): Promise<PersistedFrameJournal | null> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return null;
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  return options.readPersistedFrameJournalFromDb(db, dbNamespace, height, options.isDbUnavailableError);
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
    readPersistedFrameJournalsFromDb: (
      db: RuntimeWalDb,
      namespace: string,
      isDbUnavailableError: (error: unknown) => boolean,
      opts?: { fromHeight?: number; toHeight?: number; limit?: number },
    ) => Promise<PersistedFrameJournal[]>;
  },
): Promise<PersistedFrameJournal[]> => {
  const dbReady = await options.tryOpenDb(env);
  if (!dbReady) return [];
  const dbNamespace = options.resolveDbNamespace({ env });
  const db = options.getRuntimeDb(env);
  return options.readPersistedFrameJournalsFromDb(db, dbNamespace, options.isDbUnavailableError, frameOptions);
};
