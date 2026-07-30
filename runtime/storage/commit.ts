import { runtimeIsBrowser } from '../infra/runtime-process';
import { getPerfMs } from '../infra/time';
import {
  dropOverlay,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
} from '../runtime/env-events';
import { transitionRuntimeLifecycle } from '../runtime/lifecycle';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { readRuntimeMetadata } from '../runtime/loop-environment';
import { safeStringify } from '../protocol/serialization';
import type {
  RoutedEntityInput,
  RuntimeInput,
  RuntimeReplica,
} from '../runtime/types';
import { buildDurableRuntimeMachineSnapshot } from './wal/snapshot';
import { computeCanonicalStateHashFromEnv } from './canonical-hash';
import {
  readStorageFrameRecord,
  readStorageHead,
  saveRuntimeFrameToStorage,
  type StorageFrameRecord,
} from '.';
import { withStorageWriterLock } from './runtime-dbs';
import type { RuntimeFrameCommitStatus } from './commit-status';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';
import {
  getRuntimeProcessGlobal,
  RuntimeStorageWriteTimeoutError,
  waitForRuntimeProcessingIdle,
  withStorageWriteDeadline,
} from './commit-deadline';

export type { RuntimeFrameCommitStatus } from './commit-status';
export {
  getRuntimeProcessGlobal,
  RuntimeStorageWriteTimeoutError,
  shouldRequireCanonicalStorageAudit,
} from './commit-deadline';

const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const formatPerfMs = (value: number): string => value.toFixed(2);

export class RuntimeFrameStorageError extends Error {
  constructor(
    readonly commitStatus: RuntimeFrameCommitStatus,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`RUNTIME_FRAME_STORAGE_${commitStatus.toUpperCase()}:${message}`, {
      cause,
    });
    this.name = 'RuntimeFrameStorageError';
  }
}

type RuntimeFrameCommitProof = Pick<
  StorageFrameRecord,
  'runtimeInput' | 'runtimeMachine' | 'runtimeStateHash'
>;

export const classifyRuntimeFrameCommitProof = (
  frame: RuntimeFrameCommitProof,
  expectedInput: RuntimeInput,
  expectedRuntimeMachine: ReturnType<typeof buildDurableRuntimeMachineSnapshot>,
  expectedRuntimeStateHash: string,
): RuntimeFrameCommitStatus => {
  if (!frame.runtimeMachine || !frame.runtimeStateHash) return 'unknown';
  const inputMatches = safeStringify(frame.runtimeInput) === safeStringify(expectedInput);
  const runtimeMachineMatches =
    safeStringify(frame.runtimeMachine) === safeStringify(expectedRuntimeMachine);
  const stateMatches = frame.runtimeStateHash === expectedRuntimeStateHash;
  return inputMatches && runtimeMachineMatches && stateMatches ? 'committed' : 'conflict';
};

const resolveAuthoritativeFrameCommitStatus = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  expectedInput: RuntimeInput | undefined,
  pendingRuntimeInput: RuntimeInput | undefined,
): Promise<RuntimeFrameCommitStatus> => {
  if (!(await deps.tryOpenRuntimeWalDb(env))) return 'unknown';
  const walDb = deps.getRuntimeWalDb(env);
  const head = await readStorageHead(walDb);
  const frame = await readStorageFrameRecord(walDb, env.state.height);
  if (frame) {
    // A frame body without its committed Runtime snapshot and hash can prove
    // neither success nor conflict. Treating absent proof fields as wildcards
    // could install an unproven candidate after a timed-out WAL write.
    const expectedInputValue = expectedInput ?? {
      runtimeTxs: [],
      entityInputs: [],
    };
    return classifyRuntimeFrameCommitProof(
      frame,
      expectedInputValue,
      buildDurableRuntimeMachineSnapshot(env, {
        pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
        ...(pendingRuntimeInput ? { runtimeInput: pendingRuntimeInput } : {}),
        excludePersistedHistoryRecords: true,
      }),
      computeCanonicalStateHashFromEnv(env, pendingRuntimeInput),
    );
  }
  if (!head) return 'unknown';
  if (head.latestHeight >= env.state.height) return 'conflict';
  if (head.latestHeight === env.state.height - 1) return 'not-committed';
  return 'unknown';
};

export const saveRuntimeEnvironment = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  currentFrameInput?: RuntimeInput,
  currentFrameOutputs?: RoutedEntityInput[],
  pendingRuntimeInput?: RuntimeInput,
): Promise<{
  staleWriterStopped: boolean;
  persistencePerfMs?: Awaited<
    ReturnType<typeof saveRuntimeFrameToStorage>
  >['persistencePerfMs'];
}> => {
  if (readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingHistoryRecords = peekPendingHistoryRecords(
    env,
    env.state.height,
    env.state.timestamp,
  );
  let saveResult: Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>;
  try {
    saveResult = await withStorageWriteDeadline(env, markStorageProgress =>
      withStorageWriterLock(env, () =>
        saveRuntimeFrameToStorage({
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
        }),
      ),
    );
  } catch (error) {
    let commitStatus: RuntimeFrameCommitStatus = 'unknown';
    if (!(error instanceof RuntimeStorageWriteTimeoutError)) {
      try {
        commitStatus = await resolveAuthoritativeFrameCommitStatus(
          deps,
          env,
          currentFrameInput,
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
    const state = ensureRuntimeState(env);
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
    dropOverlay(env, saveResult.materializedOverlayRecords);
  }
  return {
    staleWriterStopped: false,
    ...(saveResult.persistencePerfMs
      ? { persistencePerfMs: saveResult.persistencePerfMs }
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
    currentFrameInput?: RuntimeInput,
    currentFrameOutputs?: RoutedEntityInput[],
    pendingRuntimeInput?: RuntimeInput,
  ) =>
    saveRuntimeEnvironment(
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
      pendingRuntimeInput,
    ),
});
