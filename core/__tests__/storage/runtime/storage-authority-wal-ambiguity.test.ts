import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeWalDb,
  saveEnvToDB,
} from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { dbRootPath } from '../../../runtime/replica/platform';
import { readStorageFrameRecord, readStorageHead } from '../../../storage';

type WalFault = 'apply-then-reject' | 'reject-before-apply';

const opened: RuntimeReplica[] = [];

const removeRuntimeStorage = (runtimeId: string): void => {
  const base = join(dbRootPath, runtimeId);
  for (const suffix of [
    '',
    '-storage-current',
    '-storage-previous',
    '-wal',
    '-history-views',
    '-events',
    '-infra',
  ]) {
    rmSync(`${base}${suffix}`, { recursive: true, force: true });
  }
};

const createSavedRuntime = async (label: string): Promise<RuntimeReplica> => {
  const seed = `${label} ${process.pid} ${Date.now()} deterministic seed`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  removeRuntimeStorage(runtimeId);
  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.state.height = 1;
  env.state.timestamp = 1_000;
  await saveEnvToDB(
    env,
    { runtimeTxs: [], entityInputs: [] },
    [],
    new Map(),
  );
  opened.push(env);
  return env;
};

const installNextWalWriteFault = (
  env: RuntimeReplica,
  fault: WalFault,
): (() => void) => {
  const db = getRuntimeWalDb(env);
  const originalBatch = db.batch.bind(db);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    Object.defineProperty(db, 'batch', {
      configurable: true,
      value: originalBatch,
    });
  };
  Object.defineProperty(db, 'batch', {
    configurable: true,
    value: () => {
      const batch = originalBatch();
      const originalWrite = batch.write.bind(batch);
      Object.defineProperty(batch, 'write', {
        configurable: true,
        value: async (options?: { sync?: boolean }): Promise<void> => {
          restore();
          if (fault === 'apply-then-reject') await originalWrite(options);
          else await batch.close();
          throw new Error(`TEST_WAL_${fault.toUpperCase().replaceAll('-', '_')}`);
        },
      });
      return batch;
    },
  });
  return restore;
};

afterEach(async () => {
  for (const env of opened.splice(0)) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    if (env.runtimeId) removeRuntimeStorage(env.runtimeId);
  }
});

describe('Runtime identity at an ambiguous WAL write boundary', () => {
  test('proves an apply-then-reject frame from exact identity', async () => {
    const env = await createSavedRuntime('plain apply then reject');
    env.state.height = 2;
    env.state.timestamp = 2_000;
    const restoreBatch = installNextWalWriteFault(env, 'apply-then-reject');
    let failure: unknown;
    try {
      await saveEnvToDB(
        env,
        { runtimeTxs: [], entityInputs: [] },
        [],
        new Map(),
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreBatch();
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('TEST_EXPECTED_STORAGE_FAILURE');
    expect(failure).toHaveProperty('commitStatus', 'committed');
    expect(failure.message).toContain('TEST_WAL_APPLY_THEN_REJECT');
    expect((await readStorageHead(getRuntimeWalDb(env)))?.latestHeight).toBe(2);
  });

  test('proves a rejected write did not commit from the unchanged WAL head', async () => {
    const env = await createSavedRuntime('reject before apply');
    env.state.height = 2;
    env.state.timestamp = 2_000;
    const restoreBatch = installNextWalWriteFault(env, 'reject-before-apply');
    try {
      await expect(saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map()))
        .rejects.toMatchObject({ commitStatus: 'not-committed' });
      expect(await readStorageFrameRecord(getRuntimeWalDb(env), 2)).toBeNull();
      expect((await readStorageHead(getRuntimeWalDb(env)))?.latestHeight).toBe(1);
    } finally {
      restoreBatch();
    }
  });
});
