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
    undefined,
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

const saveSecondFrameWithAuthority = async (
  env: RuntimeReplica,
  afterWalCommit: () => Promise<void>,
): Promise<unknown> => {
  env.state.height = 2;
  env.state.timestamp = 2_000;
  try {
    await saveEnvToDB(
      env,
      { runtimeTxs: [], entityInputs: [] },
      [],
      undefined,
      new Map(),
      {
        prepareCheckpoint: async () => [],
        validateCheckpointMaterialization: async () => {},
        afterWalCommit,
      },
    );
  } catch (error) {
    return error;
  }
  return null;
};

afterEach(async () => {
  for (const env of opened.splice(0)) {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    if (env.runtimeId) removeRuntimeStorage(env.runtimeId);
  }
});

describe('Rust authority at an ambiguous WAL write boundary', () => {
  test('proves an apply-then-reject frame without Rust from exact identity', async () => {
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
        undefined,
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

  test('completes Rust exactly once when the WAL applies then rejects', async () => {
    const env = await createSavedRuntime('authority apply then reject');
    let commits = 0;
    const restoreBatch = installNextWalWriteFault(env, 'apply-then-reject');
    const failure = await saveSecondFrameWithAuthority(env, async () => {
      commits += 1;
    });
    restoreBatch();

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('TEST_EXPECTED_STORAGE_FAILURE');
    expect(failure.message).toContain('RUNTIME_FRAME_STORAGE_COMMITTED');
    expect(failure).toHaveProperty('commitStatus', 'committed');
    expect(failure).toHaveProperty('publicationBlocked', false);
    expect(commits).toBe(1);
    expect(await readStorageFrameRecord(getRuntimeWalDb(env), 2)).not.toBeNull();
    expect((await readStorageHead(getRuntimeWalDb(env)))?.latestHeight).toBe(2);
  });

  test('does not complete Rust when the WAL rejects before applying', async () => {
    const env = await createSavedRuntime('authority reject before apply');
    let commits = 0;
    const restoreBatch = installNextWalWriteFault(env, 'reject-before-apply');
    const failure = await saveSecondFrameWithAuthority(env, async () => {
      commits += 1;
    });
    restoreBatch();

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('TEST_EXPECTED_STORAGE_FAILURE');
    expect(failure.message).toContain('RUNTIME_FRAME_STORAGE_NOT-COMMITTED');
    expect(failure).toHaveProperty('commitStatus', 'not-committed');
    expect(failure).toHaveProperty('publicationBlocked', false);
    expect(commits).toBe(0);
    expect(await readStorageFrameRecord(getRuntimeWalDb(env), 2)).toBeNull();
    expect((await readStorageHead(getRuntimeWalDb(env)))?.latestHeight).toBe(1);
  });

  test('blocks publication when Rust completion fails after proven WAL commit', async () => {
    const env = await createSavedRuntime('authority completion rejects');
    let commits = 0;
    const restoreBatch = installNextWalWriteFault(env, 'apply-then-reject');
    const failure = await saveSecondFrameWithAuthority(env, async () => {
      commits += 1;
      throw new Error('TEST_RUST_COMMIT_REJECTED');
    });
    restoreBatch();

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('TEST_EXPECTED_STORAGE_FAILURE');
    expect(failure.message).toContain(
      'RUNTIME_FRAME_STORAGE_COMMITTED:RSCORE_AUTHORITY_AFTER_WAL_FAILED',
    );
    expect(failure.message).toContain('TEST_WAL_APPLY_THEN_REJECT');
    expect(failure.message).toContain('TEST_RUST_COMMIT_REJECTED');
    expect(failure).toHaveProperty('commitStatus', 'committed');
    expect(failure).toHaveProperty('publicationBlocked', true);
    expect(commits).toBe(1);
    expect(await readStorageFrameRecord(getRuntimeWalDb(env), 2)).not.toBeNull();
  });
});
