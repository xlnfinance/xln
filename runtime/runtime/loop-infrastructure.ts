import { Level } from 'level';
import {
  clearRuntimeCleanLogs,
  copyRuntimeCleanLogs,
  getRuntimeCleanLogs,
} from './clean-logs';
import { createStructuredLogger } from '../infra/logger';
import {
  enqueueRuntimeInputsWithDeps,
  requestRuntimeLoopWake,
  type RuntimeInputQueueOptions,
} from './input-queue';
import { ensureRuntimeInfrastructure } from './runtime-infrastructure';
import {
  getRuntimeWalDb,
  getHistoryViewDb,
  getInfraDb,
  getStorageDb,
  rotateStorageEpochDb,
  tryOpenRuntimeWalDb,
  tryOpenHistoryViewDb,
  tryOpenStorageDb,
  type StorageDbRole,
} from '../storage/runtime-dbs';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica, ReliableDeliveryReceipt, RuntimeTx } from './types';
import type { JInput } from '../jurisdiction/machine/input';

const infrastructureLog = createStructuredLogger('runtime.infrastructure');
const storageDeps = { ensureRuntimeInfrastructure };
const cleanLogDeps = { ensureRuntimeInfrastructure };
const inputQueueDeps = { ensureRuntimeInfrastructure, requestRuntimeLoopWake };

export const getRuntimeStorageDb = (
  env: RuntimeReplica,
  role: StorageDbRole = 'current',
): Level<Buffer, Buffer> => getStorageDb(env, storageDeps, role);

export const getRuntimeInfraDb = (env: RuntimeReplica): Level<Buffer, Buffer> =>
  getInfraDb(env, storageDeps);

export const getRuntimeHistoryView = (env: RuntimeReplica): Level<Buffer, Buffer> =>
  getRuntimeWalDb(env, storageDeps);

export const getRuntimeHistoryViewDb = (env: RuntimeReplica): Level<Buffer, Buffer> =>
  getHistoryViewDb(env, storageDeps);

export const tryOpenRuntimeStorageDb = (
  env: RuntimeReplica,
  role: StorageDbRole = 'current',
): Promise<boolean> => tryOpenStorageDb(env, storageDeps, role);

export const rotateRuntimeStorageEpochDb = (
  env: RuntimeReplica,
  snapshotHeight: number,
  timestamp = env.state.timestamp,
): Promise<boolean> =>
  rotateStorageEpochDb(env, storageDeps, snapshotHeight, timestamp);

export const tryOpenRuntimeHistoryView = (env: RuntimeReplica): Promise<boolean> =>
  tryOpenRuntimeWalDb(env, storageDeps);

export const tryOpenRuntimeHistoryViewDb = (env: RuntimeReplica): Promise<boolean> =>
  tryOpenHistoryViewDb(env, storageDeps);

export const waitForRuntimeLoopWake = async (env: RuntimeReplica): Promise<void> => {
  const state = ensureRuntimeInfrastructure(env);
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return;
  }
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.wakeLoop === wake) state.wakeLoop = null;
      resolve();
    };
    const wake = () => {
      state.wakeRequested = false;
      finish();
    };
    state.wakeLoop = wake;
  });
};

export const waitForRuntimeLoopWakeOrTimeout = async (
  env: RuntimeReplica,
  timeoutMs: number,
): Promise<'wake' | 'timeout'> => {
  const state = ensureRuntimeInfrastructure(env);
  if (timeoutMs <= 0) {
    if (state.wakeRequested) state.wakeRequested = false;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return 'timeout';
  }
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return 'wake';
  }
  return await new Promise<'wake' | 'timeout'>(resolve => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let result: 'wake' | 'timeout' = 'timeout';
    const finish = () => {
      if (timeoutId === null) return;
      clearTimeout(timeoutId);
      timeoutId = null;
      if (state.wakeLoop === wake) state.wakeLoop = null;
      resolve(result);
    };
    const wake = () => {
      state.wakeRequested = false;
      result = 'wake';
      finish();
    };
    state.wakeLoop = wake;
    timeoutId = setTimeout(finish, timeoutMs);
  });
};

export const getCleanLogs = (env: RuntimeReplica): string =>
  getRuntimeCleanLogs(env, cleanLogDeps);

export const clearCleanLogs = (env: RuntimeReplica): void =>
  clearRuntimeCleanLogs(env, cleanLogDeps);

export const copyCleanLogs = (env: RuntimeReplica): Promise<string> =>
  copyRuntimeCleanLogs(env, cleanLogDeps);

export const enqueueRuntimeInputs = (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
  options: RuntimeInputQueueOptions = {},
): void => {
  enqueueRuntimeInputsWithDeps(
    env,
    inputQueueDeps,
    inputs,
    runtimeTxs,
    jInputs,
    explicitTimestamp,
    reliableReceipts,
    options,
  );
};

export const enqueueRuntimeContinuation = (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
): void => enqueueRuntimeInputs(
  env,
  inputs,
  runtimeTxs,
  jInputs,
  explicitTimestamp,
  reliableReceipts,
  { acceptedBeforeQuiesce: true },
);

export const tryOpenRuntimeInfraDb = async (env: RuntimeReplica): Promise<boolean> => {
  const state = ensureRuntimeInfrastructure(env);
  if (state.infraDbClosing) return false;
  state.infraDbOpenPromise ??= getRuntimeInfraDb(env).open().then(
    () => true,
    error => {
      const blocked = error instanceof Error && (
        error.message.includes('blocked') ||
        error.name === 'SecurityError' ||
        error.name === 'InvalidStateError'
      );
      if (blocked) {
        infrastructureLog.warn('infra_db.blocked_in_memory', { error: error.message });
        return false;
      }
      state.infraDbOpenPromise = null;
      throw error;
    },
  );
  try {
    return await state.infraDbOpenPromise;
  } catch (error) {
    infrastructureLog.error('infra_db.open_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const infraGossipDbAccess = {
  tryOpenInfraDb: tryOpenRuntimeInfraDb,
  getInfraDb: getRuntimeInfraDb,
};

export const trackInfraDbWrite = (env: RuntimeReplica, promise: Promise<void>): void => {
  const state = ensureRuntimeInfrastructure(env);
  state.infraDbPendingWrites ??= new Set();
  const tracked = promise.finally(() => state.infraDbPendingWrites?.delete(tracked));
  state.infraDbPendingWrites.add(tracked);
};

export const drainInfraDbWrites = async (env: RuntimeReplica): Promise<void> => {
  const state = ensureRuntimeInfrastructure(env);
  while (state.infraDbPendingWrites && state.infraDbPendingWrites.size > 0) {
    await Promise.allSettled([...state.infraDbPendingWrites]);
  }
};
