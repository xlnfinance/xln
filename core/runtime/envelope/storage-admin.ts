import { createStructuredLogger } from '../../support/logger';
import type { createRuntimeLoopApi } from '../loop/loop.ts';
import { nodeProcess, runtimeIsBrowser } from '../../support/process/runtime-process';
import { dbRootPath } from '../replica/platform';
import type { RuntimeReplica } from '../types';

const runtimeLog = createStructuredLogger('runtime');

type RuntimeStorageAdminDeps = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  | 'closeRuntimeDb'
  | 'closeInfraDb'
  | 'tryOpenInfraDb'
  | 'tryOpenStorageDb'
  | 'tryOpenRuntimeWalDb'
  | 'getInfraDb'
  | 'getStorageDb'
  | 'getRuntimeWalDb'
>;

const clearNodeRuntimeDatabases = async (
  env: RuntimeReplica,
  deps: RuntimeStorageAdminDeps,
): Promise<void> => {
  await deps.closeRuntimeDb(env);
  await deps.closeInfraDb(env);
  const fs = await import('fs/promises');
  await fs.rm(dbRootPath, { recursive: true, force: true });
  await fs.mkdir(dbRootPath, { recursive: true });
  runtimeLog.info('db.clear_root_complete', { path: dbRootPath });
};

const clearBrowserRuntimeDatabases = async (
  env: RuntimeReplica,
  deps: RuntimeStorageAdminDeps,
): Promise<void> => {
  const infraReady = await deps.tryOpenInfraDb(env);
  const currentReady = await deps.tryOpenStorageDb(env, 'current');
  const previousReady = await deps.tryOpenStorageDb(env, 'previous');
  const frameReady = await deps.tryOpenRuntimeWalDb(env);
  if (infraReady) await deps.getInfraDb(env).clear();
  if (currentReady) await deps.getStorageDb(env, 'current').clear();
  if (previousReady) await deps.getStorageDb(env, 'previous').clear();
  if (frameReady) await deps.getRuntimeWalDb(env).clear();
  runtimeLog.info('db.clear_complete');
};

export const clearRuntimeDatabases = async (
  env: RuntimeReplica,
  deps: RuntimeStorageAdminDeps,
): Promise<void> => {
  try {
    if (!runtimeIsBrowser && nodeProcess) {
      await clearNodeRuntimeDatabases(env, deps);
      return;
    }
    if (runtimeIsBrowser) await clearBrowserRuntimeDatabases(env, deps);
  } catch (error) {
    runtimeLog.error('db.clear_failed', {
      ...(runtimeIsBrowser ? {} : { path: dbRootPath }),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
