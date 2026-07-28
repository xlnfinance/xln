import { runtimeIsBrowser } from '../runtime/platform';
import { getPerfMs } from '../utils';
import {
  dropOverlay,
  dropPendingHistoryRecords,
  peekPendingHistoryRecords,
} from '../runtime/env-events';
import { transitionRuntimeLifecycle } from '../runtime/lifecycle';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { envRecord } from '../runtime/loop-environment';
import { safeStringify } from '../protocol/serialization';
import type {
  RoutedEntityInput,
  RuntimeInput,
  RuntimeState,
} from '../types';
import { buildDurableRuntimeMachineSnapshot } from './wal/snapshot';
import { computeCanonicalStateHashFromEnv } from './canonical-hash';
import { evaluateStorageProgressDeadline } from './progress-deadline';
import {
  readStorageFrameRecord,
  readStorageHead,
  saveRuntimeFrameToStorage,
} from '.';
import { withStorageWriterLock } from './runtime-dbs';
import type { RuntimeFrameCommitStatus } from './commit-status';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';

export type { RuntimeFrameCommitStatus } from './commit-status';

const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const formatPerfMs = (value: number): string => value.toFixed(2);

export type RuntimeProcessGlobal = {
  env?: Record<string, string | undefined>;
  exit?: (code?: number) => never;
};

export class RuntimeStorageWriteTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly frameHeight: number,
    readonly runtimeId: string,
    readonly step: string,
  ) {
    super(
      `STORAGE_WRITE_TIMEOUT:frame=${frameHeight}:runtime=${runtimeId}:` +
      `timeoutMs=${timeoutMs}:step=${step}`,
    );
    this.name = 'RuntimeStorageWriteTimeoutError';
  }
}

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

export const getRuntimeProcessGlobal = (): RuntimeProcessGlobal | null => {
  const candidate = (
    globalThis as typeof globalThis & { process?: RuntimeProcessGlobal }
  ).process;
  return candidate && typeof candidate === 'object' ? candidate : null;
};

export const shouldRequireCanonicalStorageAudit = (
  runtimeProcess = getRuntimeProcessGlobal(),
): boolean => {
  const raw = String(
    runtimeProcess?.env?.['XLN_STORAGE_VERIFY_CANONICAL'] || '',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const resolveStorageWriteTimeoutMs = (): number => {
  const raw = String(
    getRuntimeProcessGlobal()?.env?.['XLN_STORAGE_WRITE_TIMEOUT_MS'] || '',
  ).trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

export const waitForRuntimeProcessingIdle = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeState,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const startedAt = Date.now();
  while (true) {
    const pending = env.runtimeState?.processingPromise;
    if (!pending) return true;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    const completed = await deps.waitForPromiseBeforeTimeout(
      pending,
      remaining,
    );
    if (!completed) return false;
  }
};

const withStorageWriteTimeout = async <T>(
  env: RuntimeState,
  operation: (markProgress: (step: string) => void) => Promise<T>,
): Promise<T> => {
  const timeoutMs = resolveStorageWriteTimeoutMs();
  const markRuntimeProgress = (step: string): void => {
    env.activeProcessProgressAt = Date.now();
    env.activeProcessProgressStep = `storage:${step}`;
  };
  if (timeoutMs <= 0) return await operation(markRuntimeProgress);

  return await new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let lastProgressAtMs = Date.now();
    let lastProgressStep = 'start';

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delayMs: number): void => {
      clearTimer();
      timer = setTimeout(() => {
        if (settled) return;
        let deadline: ReturnType<typeof evaluateStorageProgressDeadline>;
        try {
          deadline = evaluateStorageProgressDeadline(
            lastProgressAtMs,
            Date.now(),
            timeoutMs,
          );
        } catch (error) {
          settled = true;
          reject(error);
          return;
        }
        if (!deadline.stalled) {
          schedule(deadline.remainingMs);
          return;
        }
        settled = true;
        reject(
          new RuntimeStorageWriteTimeoutError(
            timeoutMs,
            env.height,
            String(env.runtimeId || ''),
            lastProgressStep,
          ),
        );
      }, delayMs);
    };
    const markProgress = (step: string): void => {
      if (settled) return;
      markRuntimeProgress(step);
      lastProgressAtMs = Date.now();
      lastProgressStep = step;
      schedule(timeoutMs);
    };

    schedule(timeoutMs);
    Promise.resolve()
      .then(() => operation(markProgress))
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimer();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(error);
        },
      );
  });
};

const resolveAuthoritativeFrameCommitStatus = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeState,
  expectedInput: RuntimeInput | undefined,
): Promise<RuntimeFrameCommitStatus> => {
  if (!(await deps.tryOpenRuntimeWalDb(env))) return 'unknown';
  const walDb = deps.getRuntimeWalDb(env);
  const head = await readStorageHead(walDb);
  const frame = await readStorageFrameRecord(walDb, env.height);
  if (frame) {
    const expectedInputValue = expectedInput ?? {
      runtimeTxs: [],
      entityInputs: [],
    };
    const inputMatches =
      safeStringify(frame.runtimeInput) === safeStringify(expectedInputValue);
    const runtimeMachineMatches =
      !frame.runtimeMachine ||
      safeStringify(frame.runtimeMachine) ===
        safeStringify(
          buildDurableRuntimeMachineSnapshot(env, {
            pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
            excludePersistedHistoryRecords: true,
          }),
        );
    const stateMatches =
      !frame.runtimeStateHash ||
      frame.runtimeStateHash === computeCanonicalStateHashFromEnv(env);
    return inputMatches && runtimeMachineMatches && stateMatches
      ? 'committed'
      : 'conflict';
  }
  if (!head) return 'unknown';
  if (head.latestHeight >= env.height) return 'conflict';
  if (head.latestHeight === env.height - 1) return 'not-committed';
  return 'unknown';
};

export const saveRuntimeEnvironment = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeState,
  currentFrameInput?: RuntimeInput,
  currentFrameOutputs?: RoutedEntityInput[],
): Promise<{
  staleWriterStopped: boolean;
  persistencePerfMs?: Awaited<
    ReturnType<typeof saveRuntimeFrameToStorage>
  >['persistencePerfMs'];
}> => {
  if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingHistoryRecords = peekPendingHistoryRecords(
    env,
    env.height,
    env.timestamp,
  );
  let saveResult: Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>;
  try {
    saveResult = await withStorageWriteTimeout(env, markStorageProgress =>
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
        `STORAGE_AUTHORITATIVE_FRAME_NOT_COMMITTED:height=${env.height}`,
      ),
    );
  }
  if (saveResult.staleWriterStopped) {
    const state = ensureRuntimeState(env);
    transitionRuntimeLifecycle(state, 'halted');
    state.fatalDebugPayload = {
      message:
        `STALE_RUNTIME_WRITER_STOPPED: frame=${env.height} runtime=` +
        String(env.runtimeId || '').slice(0, 12),
      height: Math.max(0, env.height ?? 0),
      timestamp: Math.max(0, env.timestamp ?? 0),
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
    env: RuntimeState,
    timeoutMs = 5_000,
  ): Promise<boolean> => waitForRuntimeProcessingIdle(deps, env, timeoutMs),
  getRuntimeProcessGlobal,
  RuntimeStorageWriteTimeoutError,
  RuntimeFrameStorageError,
  saveEnvToDB: (
    env: RuntimeState,
    currentFrameInput?: RuntimeInput,
    currentFrameOutputs?: RoutedEntityInput[],
  ) =>
    saveRuntimeEnvironment(
      deps,
      env,
      currentFrameInput,
      currentFrameOutputs,
    ),
});
