import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { createCheckpointBarrierRuntimeTx } from '../../../runtime/checkpoint/barrier';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  processRuntime,
  readPersistedRuntimeActivityJournal,
  readPersistedRuntimeActivityPage,
  saveEnvToDB,
} from '../../../runtime';
import {
  readRuntimeActivityViewStatus,
  resetRuntimeActivityViewAtFloor,
} from '../../../storage/history/runtime-activity-view';
import { readStorageFrameRecord } from '../../../storage';

const cleanup = (runtimeId: string): void => {
  const root = process.env['XLN_DB_PATH'] || 'db-tmp/runtime';
  const namespace = join(root, runtimeId);
  for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-infra']) {
    rmSync(`${namespace}${suffix}`, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
};

const createStoredRuntime = async (name: string) => {
  const seed = `${name} ${Date.now()} alpha beta gamma`;
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  cleanup(runtimeId);
  const env = createEmptyEnv(seed);
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...(env.runtimeConfig ?? {}),
    storage: {
      ...(env.runtimeConfig?.storage ?? {}),
      materializePeriodFrames: 1,
      snapshotPeriodFrames: 100,
      canonicalHashPeriodFrames: 1,
    },
  };
  env.state.height = 1;
  env.state.timestamp = 1_000;
  await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, [], new Map());
  return { env, runtimeId, seed };
};

const commitRuntimeTick = async (env: ReturnType<typeof createEmptyEnv>): Promise<void> => {
  env.warn('system', 'local asynchronous warning', { excluded: true });
  enqueueRuntimeInput(env, {
    runtimeTxs: [createCheckpointBarrierRuntimeTx()],
    entityInputs: [],
  });
  await processRuntime(env, []);
};

describe('disposable Runtime activity view', () => {
  test('keeps v5 frames log-free and restores deterministic activity after reopen', async () => {
    const { env, runtimeId, seed } = await createStoredRuntime('activity-reopen');
    await commitRuntimeTick(env);
    const frame = await readStorageFrameRecord(getRuntimeWalDb(env), 2);
    expect(frame).not.toHaveProperty('logs');
    await closeRuntimeDb(env);
    await closeInfraDb(env);

    const reopened = createEmptyEnv(seed);
    reopened.runtimeId = runtimeId;
    reopened.dbNamespace = runtimeId;
    const journal = await readPersistedRuntimeActivityJournal(reopened, 2);
    expect(journal?.logs.map(log => log.message)).toEqual(['RuntimeTick']);
    expect(journal?.logs[0]).toMatchObject({
      id: 0,
      level: 'info',
      category: 'system',
    });
    await closeRuntimeDb(reopened);
    await closeInfraDb(reopened);
    cleanup(runtimeId);
  });

  test('repairs a post-WAL gap from H-1 once and rejects an unavailable floor', async () => {
    const { env, runtimeId } = await createStoredRuntime('activity-repair');
    await commitRuntimeTick(env);
    const live = await readPersistedRuntimeActivityJournal(env, 2);
    expect(live?.logs.map(log => log.message)).toEqual(['RuntimeTick']);

    await resetRuntimeActivityViewAtFloor(env, 1);
    await expect(readPersistedRuntimeActivityJournal(env, 1)).rejects.toThrow(
      'RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=1:through=1',
    );
    const repaired = await readPersistedRuntimeActivityJournal(env, 2);
    const repairedAgain = await readPersistedRuntimeActivityJournal(env, 2);
    expect(repaired).toEqual(live);
    expect(repairedAgain).toEqual(repaired);
    expect(await readRuntimeActivityViewStatus(env)).toEqual({
      schemaVersion: 1,
      latestHeight: 2,
      availableFromHeight: 2,
      unavailableThroughHeight: 1,
    });
    await resetRuntimeActivityViewAtFloor(env, 2);
    await expect(readPersistedRuntimeActivityPage(env)).rejects.toThrow(
      'RUNTIME_ACTIVITY_VIEW_UNAVAILABLE:height=2:through=2',
    );
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanup(runtimeId);
  });

  test('keeps a skipped disposable write visible until verified repair', async () => {
    const { env, runtimeId } = await createStoredRuntime('activity-visible-gap');
    await resetRuntimeActivityViewAtFloor(env, 0);
    await commitRuntimeTick(env);
    await readRuntimeActivityViewStatus(env);
    expect(env.infrastructure?.runtimeActivityViewFailure).toEqual({
      height: 2,
      message: 'RUNTIME_ACTIVITY_VIEW_GAP:height=2',
    });
    expect((await readPersistedRuntimeActivityJournal(env, 2))?.logs.map(log => log.message))
      .toEqual(['RuntimeTick']);
    expect(env.infrastructure?.runtimeActivityViewFailure).toBeUndefined();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanup(runtimeId);
  });
});
