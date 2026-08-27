/**
 * Serializes one Runtime commit under the writer lock and classifies crash outcomes.
 * Key paths: pre-commit rollback and post-WAL recovery-required failure handling.
 * Human-audit importance: 100/100 — mistakes can publish or replay the wrong head.
 */
import { runtimeIsBrowser } from '../../support/process/runtime-process';
import { getPerfMs } from '../../support/time';
import {
  dropOverlay,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
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
  AccountAuthorityWalCommitError,
  AccountAuthorityPreWalError,
  computeStorageFrameHash,
  readStorageFrameRecord,
  readStorageHead,
  saveRuntimeFrameToStorage,
  type RuntimeFrame,
  type StorageAuthoritativeFrameIdentity,
  type StorageFrameSaveOptions,
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
  historyPreparedAt: number;
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
    historyPrepare: marks.historyPreparedAt - marks.startedAt,
    deadlineSetup: marks.lockStartedAt - marks.historyPreparedAt,
    writerLockAcquire: marks.lockAcquiredAt - marks.lockStartedAt,
    storageCore: marks.coreDoneAt - marks.lockAcquiredAt,
    writerLockRelease: marks.lockReleasedAt - marks.coreDoneAt,
    finalize: finishedAt - marks.lockReleasedAt,
  },
  outerTotal: finishedAt - marks.startedAt,
});

class RuntimeFrameStorageError extends Error {
  readonly publicationBlocked: boolean;
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
    this.publicationBlocked = cause instanceof AccountAuthorityWalCommitError;
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
  const checkpointMatches =
    safeStringify(frame.accountAuthorityCheckpoints ?? []) ===
    safeStringify(expected.accountAuthorityCheckpoints);
  return storedHashMatches && plannedHashMatches && inputMatches &&
    stateMatches && checkpointMatches
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

type AccountAuthoritySave = NonNullable<
  StorageFrameSaveOptions['accountAuthority']
>;

type RuntimeStorageSaveResult = Awaited<
  ReturnType<typeof saveRuntimeFrameToStorage>
>;

type RuntimeStorageSaveOutcome = {
  staleWriterStopped: boolean;
  persistencePerfMs?: RuntimeStorageSaveResult['persistencePerfMs'];
};

type AuthoritySaveState = {
  identity?: StorageAuthoritativeFrameIdentity;
  completion?: Promise<void>;
};

const createStorageOuterPerfMarks = (
  startedAt: number,
): StorageOuterPerfMarks => ({
  startedAt,
  historyPreparedAt: getPerfMs(),
  lockStartedAt: 0,
  lockAcquiredAt: 0,
  coreDoneAt: 0,
  lockReleasedAt: 0,
});

const completeAccountAuthorityOnce = (
  accountAuthority: AccountAuthoritySave | undefined,
  authorityState: AuthoritySaveState,
): Promise<void> => {
  if (!accountAuthority) return Promise.resolve();
  authorityState.completion ??= Promise.resolve()
    .then(() => accountAuthority.afterWalCommit());
  return authorityState.completion;
};

const recordAuthoritativeFrameIdentity = (
  authorityState: AuthoritySaveState,
  identity: StorageAuthoritativeFrameIdentity,
): void => {
  if (authorityState.identity) {
    throw new Error('STORAGE_AUTHORITATIVE_FRAME_PREPARED_TWICE');
  }
  authorityState.identity = identity;
};

type PersistRuntimeEnvironmentOptions = {
  deps: RuntimeStorageApiDeps;
  env: RuntimeReplica;
  currentFrameInput: RuntimeInput | undefined;
  currentFrameOutputs: RoutedEntityInput[] | undefined;
  entityContexts: Map<string, EntityInfraContext>;
  pendingHistoryRecords: ReturnType<typeof peekPendingHistoryRecords>;
  outerMarks: StorageOuterPerfMarks;
  authorityState: AuthoritySaveState;
  accountAuthority: AccountAuthoritySave | undefined;
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
    pendingHistoryRecords,
    outerMarks,
    authorityState,
    accountAuthority,
  } = options;
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
        tryOpenHistoryViewDb: deps.tryOpenHistoryViewDb,
        getHistoryViewDb: deps.getHistoryViewDb,
        rotateEpochDb: deps.rotateStorageEpochDb,
        getPerfMs,
        formatPerfMs,
        historyRecords: pendingHistoryRecords,
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
          recordAuthoritativeFrameIdentity(authorityState, identity),
        ...(accountAuthority
          ? {
              accountAuthority: {
                prepareCheckpoint: accountAuthority.prepareCheckpoint,
                validateCheckpointMaterialization:
                  accountAuthority.validateCheckpointMaterialization,
                afterWalCommit: () =>
                  completeAccountAuthorityOnce(accountAuthority, authorityState),
              },
            }
          : {}),
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

const completeAuthorityAfterProvenCommit = async (
  error: unknown,
  accountAuthority: AccountAuthoritySave,
  authorityState: AuthoritySaveState,
): Promise<void> => {
  try {
    await completeAccountAuthorityOnce(accountAuthority, authorityState);
  } catch (authorityError) {
    const writeFailure = asError(error);
    const completionFailure = asError(authorityError);
    throw new RuntimeFrameStorageError(
      'committed',
      new AccountAuthorityWalCommitError(new AggregateError(
        [writeFailure, completionFailure],
        `STORAGE_WAL_COMMITTED_BUT_AUTHORITY_COMPLETION_FAILED:` +
          `write=${writeFailure.name}:${writeFailure.message}:` +
          `authority=${completionFailure.name}:${completionFailure.message}`,
      )),
    );
  }
};

const throwRuntimeStorageFailure = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  error: unknown,
  authorityState: AuthoritySaveState,
  accountAuthority: AccountAuthoritySave | undefined,
): Promise<never> => {
  if (error instanceof AccountAuthorityWalCommitError) {
    throw new RuntimeFrameStorageError('committed', error);
  }
  if (error instanceof AccountAuthorityPreWalError) {
    throw new RuntimeFrameStorageError('not-committed', error);
  }
  const commitStatus = await resolveCommitStatusAfterFailure(
    deps,
    env,
    authorityState.identity,
    error,
  );
  if (
    commitStatus === 'committed' &&
    accountAuthority &&
    authorityState.completion === undefined
  ) {
    await completeAuthorityAfterProvenCommit(
      error,
      accountAuthority,
      authorityState,
    );
  }
  throw new RuntimeFrameStorageError(commitStatus, error);
};

const finalizeRuntimeStorageSave = (
  env: RuntimeReplica,
  pendingHistoryRecords: ReturnType<typeof peekPendingHistoryRecords>,
  outerMarks: StorageOuterPerfMarks,
  saveResult: RuntimeStorageSaveResult,
): RuntimeStorageSaveOutcome => {
  if (!saveResult.historyViewsMaterialized && !saveResult.staleWriterStopped) {
    throw new RuntimeFrameStorageError(
      'not-committed',
      new Error(
        `STORAGE_AUTHORITATIVE_FRAME_NOT_COMMITTED:height=${env.state.height}`,
      ),
    );
  }
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
  if (saveResult.historyViewsMaterialized) {
    dropPendingHistoryRecords(env, pendingHistoryRecords.length);
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
  accountAuthority?: AccountAuthoritySave,
): Promise<RuntimeStorageSaveOutcome> => {
  const outerStartedAt = getPerfMs();
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingHistoryRecords = peekPendingHistoryRecords(
    env,
    env.state.height,
    env.state.timestamp,
  );
  const outerMarks = createStorageOuterPerfMarks(outerStartedAt);
  const authorityState: AuthoritySaveState = {};
  let saveResult: RuntimeStorageSaveResult;
  try {
    saveResult = await persistRuntimeEnvironment({
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      entityContexts,
      pendingHistoryRecords,
      outerMarks,
      authorityState,
      accountAuthority,
    });
  } catch (error) {
    return await throwRuntimeStorageFailure(
      deps,
      env,
      error,
      authorityState,
      accountAuthority,
    );
  }
  return finalizeRuntimeStorageSave(
    env,
    pendingHistoryRecords,
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
    accountAuthority?: AccountAuthoritySave,
  ) =>
    saveRuntimeEnvironment(
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      entityContexts,
      accountAuthority,
    ),
});
