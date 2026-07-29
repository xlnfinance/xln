import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
} from './input-validation';
import { ensureRuntimeState } from './runtime-state';
import type { RuntimeState, RuntimeInput } from '../types';
import { closeRuntimeWalDb, closeHistoryViewDb, closeInfraDb, closeStorageDb } from '../storage/runtime-dbs';
import {
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  ensureRuntimeConfig,
  failfastAssert,
  readRuntimeMetadata,
  registerEnvChangeCallback,
  registerRecoveryBackupBarrier,
  registerRuntimeFrameCommitCallback,
  writeRuntimeMetadata,
} from './loop-environment';
import {
  clearCleanLogs,
  copyCleanLogs,
  drainInfraDbWrites,
  enqueueRuntimeContinuation,
  enqueueRuntimeInputs,
  getCleanLogs,
  getRuntimeHistoryView,
  getRuntimeHistoryViewDb,
  getRuntimeInfraDb,
  getRuntimeStorageDb,
  infraGossipDbAccess,
  rotateRuntimeStorageEpochDb,
  trackInfraDbWrite,
  tryOpenRuntimeHistoryView,
  tryOpenRuntimeHistoryViewDb,
  tryOpenRuntimeInfraDb,
  tryOpenRuntimeStorageDb,
} from './loop-infrastructure';
import {
  applyEntityInputFrameCap,
  applyEntityTxFrameCap,
  collectAccountMempoolWakeInputs,
  collectEntityMempoolWakeInputs,
  generateHookPings,
  isRuntimeFrameReady,
  prioritizeJEventFrame,
  resolveNextWallClockWakeTimestamp,
  resolveRuntimeWorkReason,
  type RuntimeWorkDeps,
} from './loop-work';
import {
  discardRejectedEntityInput,
  RuntimeInputDiscardedError,
} from './frame/input-discard';
import { createRuntimeRoutingApi } from './loop-routing';
import {
  createRuntimeLifecycleApi,
} from './loop-lifecycle';
import { waitForPromiseBeforeTimeout } from './loop-drain';

type RuntimeModule = typeof import('../runtime');

export type RuntimeLoopApiDeps = {
  notifyEnvChange(env: RuntimeState): void;
  processRuntime: RuntimeModule['processRuntime'];
  waitForRuntimeProcessingIdle: RuntimeModule['waitForRuntimeProcessingIdle'];
  getRuntimeProcessGlobal(): { exit?: (code: number) => unknown } | null;
  runtimeInputHasQueuedWork(input: RuntimeInput): boolean;
};

const throwSettledErrors = (
  results: PromiseSettledResult<unknown>[],
  code: string,
): void => {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, code);
};

/**
 * Runtime's public composition root. Consensus, transport, lifecycle and
 * persistence keep their own modules; this file only wires their dependencies
 * and publishes the stable API consumed by runtime.ts.
 */
export const createRuntimeLoopApi = (deps: RuntimeLoopApiDeps) => {
  const routing = createRuntimeRoutingApi({ notifyEnvChange: deps.notifyEnvChange });
  const workDeps: RuntimeWorkDeps = {
    runtimeInputHasQueuedWork: deps.runtimeInputHasQueuedWork,
    getOutputRoutingDeps: routing.getRuntimeOutputRoutingDeps,
  };
  const getRuntimeWorkReason = (env: RuntimeState): string | null =>
    resolveRuntimeWorkReason(env, workDeps);
  const hasRuntimeWork = (env: RuntimeState): boolean => getRuntimeWorkReason(env) !== null;
  const lifecycle = createRuntimeLifecycleApi({
    processRuntime: deps.processRuntime,
    waitForRuntimeProcessingIdle: deps.waitForRuntimeProcessingIdle,
    getRuntimeProcessGlobal: deps.getRuntimeProcessGlobal,
    hasRuntimeWork,
    getNextWallClockWakeTimestamp: env =>
      resolveNextWallClockWakeTimestamp(env, workDeps),
  });

  const closeRuntimeDb = async (env: RuntimeState): Promise<void> => {
    await lifecycle.stopJurisdictionWatchersAndWait(env);
    const shutdown = await Promise.allSettled([
      lifecycle.stopRuntimeLoopAndWait(env, 10_000).then(stopped => {
        if (!stopped) throw new Error('RUNTIME_DB_CLOSE_LOOP_DRAIN_TIMEOUT');
      }),
      routing.stopP2PAndWait(env, 10_000),
    ]);
    throwSettledErrors(shutdown, 'RUNTIME_DB_CLOSE_QUIESCE_FAILED');
    lifecycle.detachRuntimeEnv(env);
    const closed = await Promise.allSettled([
      closeStorageDb(env, 'current'),
      closeStorageDb(env, 'previous'),
      closeRuntimeWalDb(env),
      closeHistoryViewDb(env),
    ]);
    throwSettledErrors(closed, 'RUNTIME_DB_CLOSE_FAILED');
  };

  const closeManagedInfraDb = async (env: RuntimeState): Promise<void> => {
    ensureRuntimeState(env).infraDbClosing = true;
    await drainInfraDbWrites(env);
    await closeInfraDb(env);
  };

  return {
    registerEnvChangeCallback,
    registerRuntimeFrameCommitCallback,
    registerRecoveryBackupBarrier,
    ENV_APPLY_ALLOWED_KEY,
    ENV_REPLAY_MODE_KEY,
    readRuntimeMetadata,
    writeRuntimeMetadata,
    failfastAssert,
    ensureRuntimeConfig,
    getRuntimeStorageDb,
    getStorageDb: getRuntimeStorageDb,
    getInfraDb: getRuntimeInfraDb,
    getRuntimeWalDb: getRuntimeHistoryView,
    getHistoryViewDb: getRuntimeHistoryViewDb,
    tryOpenStorageDb: tryOpenRuntimeStorageDb,
    rotateStorageEpochDb: rotateRuntimeStorageEpochDb,
    tryOpenRuntimeWalDb: tryOpenRuntimeHistoryView,
    tryOpenHistoryViewDb: tryOpenRuntimeHistoryViewDb,
    closeRuntimeDb,
    closeInfraDb: closeManagedInfraDb,
    getCleanLogs,
    clearCleanLogs,
    copyCleanLogs,
    enqueueRuntimeInputs,
    enqueueRuntimeContinuation,
    tryOpenInfraDb: tryOpenRuntimeInfraDb,
    infraGossipDbAccess,
    trackInfraDbWrite,
    hasRuntimeWork,
    getRuntimeWorkReason,
    collectAccountMempoolWakeInputs,
    collectEntityMempoolWakeInputs,
    prioritizeJEventFrame,
    applyEntityInputFrameCap,
    applyEntityTxFrameCap,
    generateHookPings,
    isRuntimeFrameReady,
    discardRejectedEntityInput,
    RuntimeInputDiscardedError,
    waitForPromiseBeforeTimeout,
    ...lifecycle,
    ...routing,
    MAX_RUNTIME_J_INPUTS,
    MAX_RUNTIME_J_TXS,
    MAX_RUNTIME_J_TXS_PER_JURISDICTION,
    MAX_RUNTIME_J_INPUT_BYTES,
  };
};
