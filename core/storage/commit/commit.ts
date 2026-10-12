/**
 * Serializes one Runtime commit under the writer lock and classifies crash outcomes.
 * Key paths: pre-commit rollback and post-WAL recovery-required failure handling.
 * Human-audit importance: 100/100 — mistakes can publish or replay the wrong head.
 */
import { runtimeIsBrowser } from '../../support/process/runtime-process';
import { getPerfMs } from '../../support/time';
import {
  dropOverlay,
} from '../../runtime/observability/env-events';
import { transitionRuntimeLifecycle } from '../../runtime/replica/lifecycle';
import { ensureRuntimeInfrastructure } from '../../runtime/envelope/replica-envelope';
import { readRuntimeMetadata } from '../../runtime/loop/loop-environment.ts';
import { safeStringify } from '../../protocol/serialization';
import type {
  RoutedEntityInput,
  RuntimeInput,
  RuntimeReplica,
} from '../../runtime/types';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { verifyPersistedFrameState } from '../recovery/verify';
import {
  computeStorageFrameHash,
  readStorageFrameRecord,
  readStorageHead,
  saveRuntimeFrameToStorage,
  type RuntimeFrame,
  type StorageAuthoritativeFrameIdentity,
} from '..';
import { withRetainedStorageWriterLock } from '../runtime-dbs';
import type { RuntimeFrameCommitStatus } from './commit-status';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import {
  getRuntimeProcessGlobal,
  RuntimeStorageWriteTimeoutError,
  waitForRuntimeProcessingIdle,
  withStorageWriteDeadline,
} from './commit-deadline';

export type { RuntimeFrameCommitStatus } from './commit-status';
export {
  shouldRequireCanonicalStorageAudit,
} from './commit-deadline';

const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const formatPerfMs = (value: number): string => value.toFixed(2);

type StorageOuterPerfMarks = {
  startedAt: number;
  preparedAt: number;
  lockStartedAt: number;
  lockAcquiredAt: number;
  coreDoneAt: number;
  lockReleasedAt: number;
};

const buildStorageOuterPerf = (
  marks: StorageOuterPerfMarks,
  finishedAt: number,
): { outerStages: Record<string, number>; outerTotal: number } => ({
  outerStages: {
    prepare: marks.preparedAt - marks.startedAt,
    deadlineSetup: marks.lockStartedAt - marks.preparedAt,
    writerLockAcquire: marks.lockAcquiredAt - marks.lockStartedAt,
    storageCore: marks.coreDoneAt - marks.lockAcquiredAt,
    writerLockRelease: marks.lockReleasedAt - marks.coreDoneAt,
    finalize: finishedAt - marks.lockReleasedAt,
  },
  outerTotal: finishedAt - marks.startedAt,
});

class RuntimeFrameStorageError extends Error {
  readonly operationStillRunning: boolean;

  constructor(
    readonly commitStatus: RuntimeFrameCommitStatus,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`RUNTIME_FRAME_STORAGE_${commitStatus.toUpperCase()}:${message}`, {
      cause,
    });
    this.name = 'RuntimeFrameStorageError';
    this.operationStillRunning = cause instanceof RuntimeStorageWriteTimeoutError;
    if (cause instanceof Error && cause.stack && this.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export const classifyRuntimeFrameCommitProof = (
  frame: RuntimeFrame,
  expected: StorageAuthoritativeFrameIdentity,
): RuntimeFrameCommitStatus => {
  if (!frame.frameHash || !frame.postStateHash) return 'unknown';
  const storedHashMatches = computeStorageFrameHash(frame) === frame.frameHash;
  const plannedHashMatches = frame.frameHash === expected.frameHash;
  const inputMatches =
    safeStringify(frame.runtimeInput) === safeStringify(expected.runtimeInput);
  const stateMatches = frame.postStateHash === expected.postStateHash;
  return storedHashMatches && plannedHashMatches && inputMatches && stateMatches
    ? 'committed'
    : 'conflict';
};

const resolveAuthoritativeFrameCommitStatus = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  expected: StorageAuthoritativeFrameIdentity | undefined,
): Promise<RuntimeFrameCommitStatus> => {
  if (!(await deps.tryOpenRuntimeWalDb(env))) return 'unknown';
  const walDb = deps.getRuntimeWalDb(env);
  const head = await readStorageHead(walDb);
  const frame = await readStorageFrameRecord(walDb, env.state.height);
  if (frame) {
    if (!expected) return 'conflict';
    const actualPostStateHash = verifyPersistedFrameState(
      env,
      frame,
    ).actualStateHash;
    if (actualPostStateHash !== expected.postStateHash) return 'conflict';
    return classifyRuntimeFrameCommitProof(frame, expected);
  }
  if (!head) return 'unknown';
  if (head.latestHeight >= env.state.height) return 'conflict';
  if (head.latestHeight === env.state.height - 1) return 'not-committed';
  return 'unknown';
};

type RuntimeStorageSaveResult = Awaited<
  ReturnType<typeof saveRuntimeFrameToStorage>
>;

type RuntimeStorageSaveOutcome = {
  staleWriterStopped: boolean;
  persistencePerfMs?: RuntimeStorageSaveResult['persistencePerfMs'];
};

type FrameSaveState = {
  identity?: StorageAuthoritativeFrameIdentity;
};

const createStorageOuterPerfMarks = (
  startedAt: number,
): StorageOuterPerfMarks => ({
  startedAt,
  preparedAt: getPerfMs(),
  lockStartedAt: 0,
  lockAcquiredAt: 0,
  coreDoneAt: 0,
  lockReleasedAt: 0,
});

const recordAuthoritativeFrameIdentity = (
  frameState: FrameSaveState,
  identity: StorageAuthoritativeFrameIdentity,
): void => {
  if (frameState.identity) {
    throw new Error('STORAGE_AUTHORITATIVE_FRAME_PREPARED_TWICE');
  }
  frameState.identity = identity;
};

type PersistRuntimeEnvironmentOptions = {
  deps: RuntimeStorageApiDeps;
  env: RuntimeReplica;
  currentFrameInput: RuntimeInput | undefined;
  currentFrameOutputs: RoutedEntityInput[] | undefined;
  entityContexts: Map<string, EntityInfraContext>;
  outerMarks: StorageOuterPerfMarks;
  frameState: FrameSaveState;
};

const persistRuntimeEnvironment = async (
  options: PersistRuntimeEnvironmentOptions,
): Promise<RuntimeStorageSaveResult> => {
  const {
    deps,
    env,
    currentFrameInput,
    currentFrameOutputs,
    entityContexts,
    outerMarks,
    frameState,
  } = options;
  // An ephemeral Runtime has no storage namespace to serialize. Bypass the
  // durable writer lock as well as LevelDB; otherwise each RAM-only HLT user
  // creates writer-lock release files despite correctly skipping state/WAL.
  if (env.runtimeConfig?.storage?.enabled === false) {
    return { materialized: false, materializedOverlayKeys: [] };
  }
  return withStorageWriteDeadline(env, markStorageProgress => {
    outerMarks.lockStartedAt = getPerfMs();
    return withRetainedStorageWriterLock(env, async () => {
      outerMarks.lockAcquiredAt = getPerfMs();
      const result = await saveRuntimeFrameToStorage({
        env,
        tryOpenDb: targetEnv =>
          deps.tryOpenStorageDb(targetEnv, 'current'),
        getRuntimeDb: targetEnv =>
          deps.getStorageDb(targetEnv, 'current'),
        tryOpenRuntimeWalDb: deps.tryOpenRuntimeWalDb,
        getRuntimeWalDb: deps.getRuntimeWalDb,
        rotateEpochDb: deps.rotateStorageEpochDb,
        getPerfMs,
        formatPerfMs,
        entityContexts,
        inProcessInfraValidated: true,
        stopStaleWriterOnHeadAhead: runtimeIsBrowser && !env.scenarioMode,
        ...(currentFrameInput === undefined ? {} : { currentFrameInput }),
        ...(currentFrameOutputs === undefined
          ? {}
          : { currentFrameOutputs }),
        onPersistenceProgress: markStorageProgress,
        onPersistenceBoundary: boundary =>
          markStorageProgress(`boundary:${boundary}`),
        onAuthoritativeFramePrepared: identity =>
          recordAuthoritativeFrameIdentity(frameState, identity),
      });
      outerMarks.coreDoneAt = getPerfMs();
      return result;
    }).then(result => {
      outerMarks.lockReleasedAt = getPerfMs();
      return result;
    });
  });
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const resolveCommitStatusAfterFailure = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  identity: StorageAuthoritativeFrameIdentity | undefined,
  error: unknown,
): Promise<RuntimeFrameCommitStatus> => {
  if (error instanceof RuntimeStorageWriteTimeoutError) return 'unknown';
  try {
    return await resolveAuthoritativeFrameCommitStatus(deps, env, identity);
  } catch (probeError) {
    const writeFailure = asError(error);
    const probeFailure = asError(probeError);
    const combined = new AggregateError(
      [writeFailure, probeFailure],
      `STORAGE_WRITE_AND_AUTHORITATIVE_PROBE_FAILED:` +
        `write=${writeFailure.name}:${writeFailure.message}:` +
        `probe=${probeFailure.name}:${probeFailure.message}`,
    );
    throw new RuntimeFrameStorageError('unknown', combined);
  }
};

const throwRuntimeStorageFailure = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  error: unknown,
  frameState: FrameSaveState,
): Promise<never> => {
  const commitStatus = await resolveCommitStatusAfterFailure(
    deps,
    env,
    frameState.identity,
    error,
  );
  throw new RuntimeFrameStorageError(commitStatus, error);
};

const finalizeRuntimeStorageSave = (
  env: RuntimeReplica,
  outerMarks: StorageOuterPerfMarks,
  saveResult: RuntimeStorageSaveResult,
): RuntimeStorageSaveOutcome => {
  if (saveResult.staleWriterStopped) {
    const state = ensureRuntimeInfrastructure(env);
    transitionRuntimeLifecycle(state, 'halted');
    state.fatalDebugPayload = {
      message:
        `STALE_RUNTIME_WRITER_STOPPED: frame=${env.state.height} runtime=` +
        String(env.runtimeId || '').slice(0, 12),
      height: Math.max(0, env.state.height ?? 0),
      timestamp: Math.max(0, env.state.timestamp ?? 0),
    };
    state.stopLoop?.();
    return { staleWriterStopped: true };
  }
  if (saveResult.materialized) {
    dropOverlay(env, saveResult.materializedOverlayKeys);
  }
  const outerPerf = buildStorageOuterPerf(outerMarks, getPerfMs());
  return {
    staleWriterStopped: false,
    ...(saveResult.persistencePerfMs
      ? { persistencePerfMs: { ...saveResult.persistencePerfMs, ...outerPerf } }
      : {}),
  };
};

const saveRuntimeEnvironment = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  currentFrameInput: RuntimeInput | undefined,
  currentFrameOutputs: RoutedEntityInput[] | undefined,
  entityContexts: Map<string, EntityInfraContext>,
): Promise<RuntimeStorageSaveOutcome> => {
  const outerStartedAt = getPerfMs();
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const outerMarks = createStorageOuterPerfMarks(outerStartedAt);
  const frameState: FrameSaveState = {};
  let saveResult: RuntimeStorageSaveResult;
  try {
    saveResult = await persistRuntimeEnvironment({
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      entityContexts,
      outerMarks,
      frameState,
    });
  } catch (error) {
    return await throwRuntimeStorageFailure(
      deps,
      env,
      error,
      frameState,
    );
  }
  return finalizeRuntimeStorageSave(
    env,
    outerMarks,
    saveResult,
  );
};

export const createRuntimeStorageCommitApi = (
  deps: RuntimeStorageApiDeps,
) => ({
  waitForRuntimeProcessingIdle: (
    env: RuntimeReplica,
    timeoutMs = 5_000,
  ): Promise<boolean> => waitForRuntimeProcessingIdle(deps, env, timeoutMs),
  getRuntimeProcessGlobal,
  RuntimeStorageWriteTimeoutError,
  RuntimeFrameStorageError,
  saveEnvToDB: (
    env: RuntimeReplica,
    currentFrameInput: RuntimeInput | undefined,
    currentFrameOutputs: RoutedEntityInput[] | undefined,
    entityContexts: Map<string, EntityInfraContext>,
  ) =>
    saveRuntimeEnvironment(
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      entityContexts,
    ),
});
