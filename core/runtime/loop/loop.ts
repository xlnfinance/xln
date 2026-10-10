import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope.ts';
import type { RuntimeReplica, RuntimeInput } from '../types.ts';
import {
  closeRuntimeWalDb,
  closeInfraDb,
  closeStorageDb,
  releaseRetainedStorageWriterLock,
} from '../../storage/runtime-dbs.ts';
import { closeRuntimeActivityViewDb } from '../../storage/history/runtime-activity-view.ts';
import {
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  ensureRuntimeConfig,
  failfastAssert,
  readRuntimeMetadata,
  registerRuntimePublishedCallback,
  registerRecoveryBackupBarrier,
  registerRuntimeFrameCommitCallback,
  writeRuntimeMetadata,
} from './loop-environment.ts';
import {
  drainInfraDbWrites,
  enqueueRuntimeContinuation,
  enqueueRuntimeInputs,
  getRuntimeWal,
  getRuntimeInfraDb,
  getRuntimeStorageDb,
  infraGossipDbAccess,
  rotateRuntimeStorageEpochDb,
  trackInfraDbWrite,
  tryOpenRuntimeWal,
  tryOpenRuntimeInfraDb,
  tryOpenRuntimeStorageDb,
} from './loop-envelope.ts';
import {
  applyEntityInputFrameCap,
  applyEntityTxFrameCap,
  collectReplicaMempoolWakeInputs,
  generateHookPings,
  isRuntimeFrameReady,
  prioritizeJEventFrame,
  resolveNextWallClockWakeTimestamp,
  resolveRuntimeWorkReason,
  type RuntimeWorkDeps,
} from './loop-work.ts';
import {
  discardRejectedEntityInput,
  RuntimeInputDiscardedError,
} from '../frame/intake/discard.ts';
import { createRuntimeRoutingApi } from './loop-routing.ts';
import {
  createRuntimeLifecycleApi,
} from './loop-lifecycle.ts';
import { waitForPromiseBeforeTimeout } from './loop-drain.ts';

type RuntimeModule = typeof import('../../runtime.ts');

export type RuntimeLoopApiDeps = {
  notifyEnvChange(env: RuntimeReplica): void;
  processRuntime: RuntimeModule['processRuntime'];
  waitForRuntimeProcessingIdle: RuntimeModule['waitForRuntimeProcessingIdle'];
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

type RuntimeLifecycleApi = ReturnType<typeof createRuntimeLifecycleApi>;
type RuntimeRoutingApi = ReturnType<typeof createRuntimeRoutingApi>;

const createRuntimeDbCloser = (
  lifecycle: RuntimeLifecycleApi,
  routing: RuntimeRoutingApi,
) => async (env: RuntimeReplica): Promise<void> => {
  // A read-only replay env borrows the live WAL handle. Closing it must not
  // stop the live loop or drop the namespace writer lock; those belong to
  // the source Runtime that still owns the durable lease.
  const borrowedWal = env.infrastructure?.runtimeWalDbBorrowed === true;
  if (!borrowedWal) {
    await lifecycle.stopJurisdictionWatchersAndWait(env);
    const shutdown = await Promise.allSettled([
      lifecycle.stopRuntimeLoopAndWait(env, 10_000).then(stopped => {
        if (!stopped) throw new Error('RUNTIME_DB_CLOSE_LOOP_DRAIN_TIMEOUT');
      }),
      routing.stopP2PAndWait(env, 10_000),
    ]);
    throwSettledErrors(shutdown, 'RUNTIME_DB_CLOSE_QUIESCE_FAILED');
    await env.accountAuthorityEntityStageProvider?.close?.();
    delete env.accountAuthorityEntityStageProvider;
    delete env.accountAuthorityExecutionMode;
    lifecycle.detachRuntimeEnv(env);
  }
  const closed = await Promise.allSettled([
    closeStorageDb(env, 'current'),
    closeStorageDb(env, 'previous'),
    closeRuntimeWalDb(env),
    ...(!borrowedWal ? [closeRuntimeActivityViewDb(env)] : []),
  ]);
  throwSettledErrors(closed, 'RUNTIME_DB_CLOSE_FAILED');
  if (!borrowedWal) await releaseRetainedStorageWriterLock(env);
};

const closeManagedInfraDb = async (env: RuntimeReplica): Promise<void> => {
  ensureRuntimeInfrastructure(env).infraDbClosing = true;
  await drainInfraDbWrites(env);
  await closeInfraDb(env);
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
  };
  const getRuntimeWorkReason = (env: RuntimeReplica): string | null =>
    resolveRuntimeWorkReason(env, workDeps);
  const hasRuntimeWork = (env: RuntimeReplica): boolean => getRuntimeWorkReason(env) !== null;
  const lifecycle = createRuntimeLifecycleApi({
    processRuntime: deps.processRuntime,
    waitForRuntimeProcessingIdle: deps.waitForRuntimeProcessingIdle,
    hasRuntimeWork,
    getNextWallClockWakeTimestamp: env =>
      resolveNextWallClockWakeTimestamp(env),
  });

  const closeRuntimeDb = createRuntimeDbCloser(lifecycle, routing);

  return {
    registerRuntimePublishedCallback,
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
    getRuntimeWalDb: getRuntimeWal,
    tryOpenStorageDb: tryOpenRuntimeStorageDb,
    rotateStorageEpochDb: rotateRuntimeStorageEpochDb,
    tryOpenRuntimeWalDb: tryOpenRuntimeWal,
    closeRuntimeDb,
    closeInfraDb: closeManagedInfraDb,
    enqueueRuntimeInputs,
    enqueueRuntimeContinuation,
    tryOpenInfraDb: tryOpenRuntimeInfraDb,
    infraGossipDbAccess,
    trackInfraDbWrite,
    hasRuntimeWork,
    getRuntimeWorkReason,
    collectReplicaMempoolWakeInputs,
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
  };
};
