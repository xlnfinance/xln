import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  loadEnvFromDB,
  persistRestoredEnvToDB,
  restoreEnvFromCheckpointSnapshot,
  saveEnvToDB,
} from '../../../runtime';
import { dbRootPath } from '../../../runtime/replica/platform';
import { buildRuntimeCheckpointSnapshot } from '../../../storage/wal/snapshot';

const previousAuthority = process.env['XLN_RSCORE_AUTHORITY'];
const cleanupRuntimeIds: string[] = [];

const removeRuntimeStorage = (runtimeId: string): void => {
  const base = join(dbRootPath, runtimeId);
  for (const suffix of [
    '', '-storage-current', '-storage-previous', '-wal', '-history-views',
    '-events', '-infra',
  ]) rmSync(`${base}${suffix}`, { recursive: true, force: true });
};

beforeEach(() => {
  process.env['XLN_RSCORE_AUTHORITY'] = '1';
});

afterEach(() => {
  for (const runtimeId of cleanupRuntimeIds.splice(0)) {
    removeRuntimeStorage(runtimeId);
  }
  if (previousAuthority === undefined) delete process.env['XLN_RSCORE_AUTHORITY'];
  else process.env['XLN_RSCORE_AUTHORITY'] = previousAuthority;
});

describe('Rust exact-recovery policy', () => {
  test('rejects a portable live restore before decoding untrusted bytes', async () => {
    await expect(restoreEnvFromCheckpointSnapshot({}, {}))
      .rejects.toThrow('RSCORE_PORTABLE_RESTORE_EXACT_CHECKPOINT_REQUIRED');
  });

  test('allows portable inspection only with Account authority suppressed', async () => {
    const source = createEmptyEnv('rscore portable read only source');
    const restored = await restoreEnvFromCheckpointSnapshot(
      buildRuntimeCheckpointSnapshot(source),
      { readOnly: true },
    );
    try {
      expect(restored.accountAuthoritySuppressed).toBe(true);
    } finally {
      await closeRuntimeDb(restored);
      await closeInfraDb(restored);
    }
  });

  test('rejects portable persistence even when that Runtime is suppressed', async () => {
    const env = createEmptyEnv('rscore portable persistence rejected');
    env.accountAuthoritySuppressed = true;
    await expect(persistRestoredEnvToDB(env))
      .rejects.toThrow('RSCORE_PORTABLE_PERSIST_EXACT_CHECKPOINT_REQUIRED');
  });

  test('rejects historical live restore but accepts the latest exact boundary', async () => {
    process.env['XLN_RSCORE_AUTHORITY'] = '0';
    const seed = `rscore latest-only restore ${process.pid} ${Date.now()}`;
    const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    cleanupRuntimeIds.push(runtimeId);
    removeRuntimeStorage(runtimeId);
    const env = createEmptyEnv(seed);
    env.runtimeId = runtimeId;
    env.dbNamespace = runtimeId;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: {
        ...env.runtimeConfig?.storage,
        materializePeriodFrames: 1,
      },
    };
    for (const height of [1, 2]) {
      env.state.height = height;
      env.state.timestamp = height * 1_000;
      await saveEnvToDB(
        env,
        { runtimeTxs: [], entityInputs: [] },
        [],
        new Map(),
      );
    }
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    process.env['XLN_RSCORE_AUTHORITY'] = '1';
    await expect(loadEnvFromDB(runtimeId, seed, { fromSnapshotHeight: 1 }))
      .rejects.toThrow('RSCORE_HISTORICAL_LIVE_RESTORE_UNSUPPORTED');
    const latest = await loadEnvFromDB(runtimeId, seed);
    if (!latest) throw new Error('TEST_LATEST_RSCORE_RESTORE_MISSING');
    try {
      expect(latest.state.height).toBe(2);
      expect(latest.accountAuthoritySuppressed).not.toBe(true);
    } finally {
      await closeRuntimeDb(latest);
      await closeInfraDb(latest);
    }
  });
});
