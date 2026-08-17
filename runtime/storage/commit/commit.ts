/**
 * Serializes one Runtime commit under the writer lock and classifies crash outcomes.
 * Key paths: pre-commit rollback and post-WAL recovery-required failure handling.
 * Human-audit importance: 100/100 — mistakes can publish or replay the wrong head.
 */
import { runtimeIsBrowser } from '../../infra/process/runtime-process';
import { getPerfMs } from '../../infra/time';
import {
  dropOverlay,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
} from '../../runtime/observability/env-events';
import { transitionRuntimeLifecycle } from '../../runtime/lifecycle';
import { ensureRuntimeInfrastructure } from '../../runtime/infrastructure/runtime-infrastructure';
import { readRuntimeMetadata } from '../../runtime/loop/loop-environment.ts';
import { safeStringify } from '../../protocol/serialization';
import type {
  RoutedEntityInput,
  RuntimeInput,
  RuntimeReplica,
} from '../../runtime/types';
import { verifyPersistedFrameState } from '../recovery/verify';
import {
  readStorageFrameRecord,
  readStorageHead,
  saveRuntimeFrameToStorage,
  type RuntimeFrame,
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
  constructor(
    readonly commitStatus: RuntimeFrameCommitStatus,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`RUNTIME_FRAME_STORAGE_${commitStatus.toUpperCase()}:${message}`, {
      cause,
    });
    this.name = 'RuntimeFrameStorageError';
    if (cause instanceof Error && cause.stack && this.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

type RuntimeFrameCommitProof = Pick<RuntimeFrame, 'runtimeInput'> &
  Partial<Pick<RuntimeFrame, 'postStateHash'>>;

export const classifyRuntimeFrameCommitProof = (
  frame: RuntimeFrameCommitProof,
  expectedInput: RuntimeInput,
  expectedPostStateHash: string,
): RuntimeFrameCommitStatus => {
  if (!frame.postStateHash) return 'unknown';
  const inputMatches = safeStringify(frame.runtimeInput) === safeStringify(expectedInput);
  const stateMatches = frame.postStateHash === expectedPostStateHash;
  return inputMatches && stateMatches ? 'committed' : 'conflict';
};

const resolveAuthoritativeFrameCommitStatus = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  expectedInput: RuntimeInput | undefined,
  currentFrameOutputs: RoutedEntityInput[] | undefined,
  pendingRuntimeInput: RuntimeInput | undefined,
): Promise<RuntimeFrameCommitStatus> => {
  if (!(await deps.tryOpenRuntimeWalDb(env))) return 'unknown';
  const walDb = deps.getRuntimeWalDb(env);
  const head = await readStorageHead(walDb);
  const frame = await readStorageFrameRecord(walDb, env.state.height);
  if (frame) {
    const expectedInputValue = expectedInput ?? {
      runtimeTxs: [],
      entityInputs: [],
    };
    void currentFrameOutputs;
    void pendingRuntimeInput;
    const expectedPostStateHash = verifyPersistedFrameState(
      env,
      frame,
    ).actualStateHash;
    return classifyRuntimeFrameCommitProof(
      frame,
      expectedInputValue,
      expectedPostStateHash,
    );
  }
  if (!head) return 'unknown';
  if (head.latestHeight >= env.state.height) return 'conflict';
  if (head.latestHeight === env.state.height - 1) return 'not-committed';
  return 'unknown';
};

const saveRuntimeEnvironment = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  currentFrameInput: RuntimeInput | undefined,
  currentFrameOutputs: RoutedEntityInput[] | undefined,
  pendingRuntimeInput: RuntimeInput | undefined,
  entityContexts: Map<string, import('../../types/entity/infra-context').EntityInfraContext>,
): Promise<{
  staleWriterStopped: boolean;
  persistencePerfMs?: Awaited<
    ReturnType<typeof saveRuntimeFrameToStorage>
  >['persistencePerfMs'];
}> => {
  const outerStartedAt = getPerfMs();
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingHistoryRecords = peekPendingHistoryRecords(
    env,
    env.state.height,
    env.state.timestamp,
  );
  const outerMarks: StorageOuterPerfMarks = {
    startedAt: outerStartedAt,
    historyPreparedAt: getPerfMs(),
    lockStartedAt: 0,
    lockAcquiredAt: 0,
    coreDoneAt: 0,
    lockReleasedAt: 0,
  };
  let saveResult: Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>;
  try {
    saveResult = await withStorageWriteDeadline(env, markStorageProgress => {
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
          stopStaleWriterOnHeadAhead: runtimeIsBrowser && !env.scenarioMode,
          ...(currentFrameInput === undefined ? {} : { currentFrameInput }),
          ...(currentFrameOutputs === undefined
            ? {}
            : { currentFrameOutputs }),
          ...(pendingRuntimeInput === undefined
            ? {}
            : { pendingRuntimeInput }),
          onPersistenceProgress: markStorageProgress,
          onPersistenceBoundary: boundary =>
            markStorageProgress(`boundary:${boundary}`),
        });
        outerMarks.coreDoneAt = getPerfMs();
        return result;
      }).then(result => {
        outerMarks.lockReleasedAt = getPerfMs();
        return result;
      });
    });
  } catch (error) {
    let commitStatus: RuntimeFrameCommitStatus = 'unknown';
    if (!(error instanceof RuntimeStorageWriteTimeoutError)) {
      try {
        commitStatus = await resolveAuthoritativeFrameCommitStatus(
          deps,
          env,
          currentFrameInput,
          currentFrameOutputs,
          pendingRuntimeInput,
        );
      } catch (probeError) {
        const writeFailure =
          error instanceof Error ? error : new Error(String(error));
        const probeFailure =
          probeError instanceof Error
            ? probeError
            : new Error(String(probeError));
        const combined = new AggregateError(
          [writeFailure, probeFailure],
          `STORAGE_WRITE_AND_AUTHORITATIVE_PROBE_FAILED:` +
            `write=${writeFailure.name}:${writeFailure.message}:` +
            `probe=${probeFailure.name}:${probeFailure.message}`,
        );
        throw new RuntimeFrameStorageError('unknown', combined);
      }
    }
    throw new RuntimeFrameStorageError(commitStatus, error);
  }
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
    pendingRuntimeInput: RuntimeInput | undefined,
    entityContexts: Map<string, import('../../types/entity/infra-context').EntityInfraContext>,
  ) =>
    saveRuntimeEnvironment(
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      pendingRuntimeInput,
      entityContexts,
    ),
});
