import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
} from './input-validation';
import { ensureRuntimeState } from './runtime-state';
import type { Env, RuntimeInput } from '../types';
import { closeFrameDb, closeInfraDb, closeStorageDb } from '../storage/runtime-dbs';
import {
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  ensureRuntimeConfig,
  envRecord,
  failfastAssert,
  registerEnvChangeCallback,
  registerRecoveryBackupBarrier,
  registerRuntimeFrameCommitCallback,
} from './loop-environment';
import {
  clearCleanLogs,
  copyCleanLogs,
  drainInfraDbWrites,
  enqueueRuntimeContinuation,
  enqueueRuntimeInputs,
  getCleanLogs,
  getRuntimeFrameDb,
  getRuntimeInfraDb,
  getRuntimeStorageDb,
  infraGossipDbAccess,
  rotateRuntimeStorageEpochDb,
  trackInfraDbWrite,
  tryOpenRuntimeFrameDb,
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
  quarantineLiveRuntimeInput,
  RuntimeInputQuarantinedError,
} from './input-quarantine';
import { createRuntimeRoutingApi } from './loop-routing';
import {
  createRuntimeLifecycleApi,
} from './loop-lifecycle';
import { waitForPromiseBeforeTimeout } from './loop-drain';

type RuntimeModule = typeof import('../runtime');

export type RuntimeLoopApiDeps = {
  notifyEnvChange(env: Env): void;
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
  const getRuntimeWorkReason = (env: Env): string | null =>
    resolveRuntimeWorkReason(env, workDeps);
  const hasRuntimeWork = (env: Env): boolean => getRuntimeWorkReason(env) !== null;
  const lifecycle = createRuntimeLifecycleApi({
    processRuntime: deps.processRuntime,
    waitForRuntimeProcessingIdle: deps.waitForRuntimeProcessingIdle,
    getRuntimeProcessGlobal: deps.getRuntimeProcessGlobal,
    hasRuntimeWork,
    getNextWallClockWakeTimestamp: env =>
      resolveNextWallClockWakeTimestamp(env, workDeps),
  });

  const closeRuntimeDb = async (env: Env): Promise<void> => {
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
      closeFrameDb(env),
    ]);
    throwSettledErrors(closed, 'RUNTIME_DB_CLOSE_FAILED');
  };

  const closeManagedInfraDb = async (env: Env): Promise<void> => {
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
    envRecord,
    failfastAssert,
    ensureRuntimeConfig,
    getRuntimeStorageDb,
    getStorageDb: getRuntimeStorageDb,
    getInfraDb: getRuntimeInfraDb,
    getFrameDb: getRuntimeFrameDb,
    tryOpenStorageDb: tryOpenRuntimeStorageDb,
    rotateStorageEpochDb: rotateRuntimeStorageEpochDb,
    tryOpenFrameDb: tryOpenRuntimeFrameDb,
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
    quarantineLiveRuntimeInput,
    RuntimeInputQuarantinedError,
    waitForPromiseBeforeTimeout,
    ...lifecycle,
    ...routing,
    MAX_RUNTIME_J_INPUTS,
    MAX_RUNTIME_J_TXS,
    MAX_RUNTIME_J_TXS_PER_JURISDICTION,
    MAX_RUNTIME_J_INPUT_BYTES,
  };
};
