import { describe, expect, spyOn, test } from 'bun:test';
import { createActivityPageReader } from '../../../../ui/src/runtime/financial/activity-reader';
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
  getRuntimeStorageDb,
  getPersistedLatestHeight,
  listPersistedCheckpointHeights,
  loadEnvFromStorageByReplay,
  readPersistedStorageFrameRecord,
  readPersistedStorageFramePayloads,
  replayRecoveryFrameJournals,
  restoreEnvFromRecoveryBundles,
  tryOpenStorageDb,
  tryOpenRuntimeWalDb,
  processRuntime,
  readPersistedRuntimeActivityJournal,
  readPersistedRuntimeActivityJournals,
  readPersistedRuntimeActivityPage,
  saveEnvToDB,
} from '../../../runtime';
import {
  appendRuntimeActivityViewFrame,
  readRuntimeActivityViewStatus,
  resetRuntimeActivityViewAtFloor,
} from '../../../storage/history/runtime-activity-view';
import { readStorageFrameRecord, recoverStorageDbFromWal, resolveStorageRuntimeConfig } from '../../../storage';
import { encodeBuffer } from '../../../storage/codec/codec';
import { KEY_LIVE_ENTITY, keyFrame } from '../../../storage/keys';
import { getStorageDb, withStorageConsistentRead } from '../../../storage/runtime-dbs';
import { ensureRuntimeActivityView } from '../../../storage/history/runtime-activity-repair';
import { buildRecoveryJournalFromStorageFrame } from '../../../storage/queries/history';
import type { PersistenceQueryDeps } from '../../../storage/queries/deps';
import { resolveRuntimeAdapterRead } from '../../../api/runtime-adapter/resolve';
import { readRuntimeFrameReceipts } from '../../../api/runtime-adapter/frame-receipts';
import type { RuntimeAdapterFrameReceiptResponse, RuntimeAdapterReadQuery } from '../../../api/runtime-adapter/types';

const barrier = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

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
  test('open WAL verification preserves current repair and rejects a damaged later head', async () => {
    const { env, runtimeId } = await createStoredRuntime('verified-open-wal-recovery');
    try {
      await commitRuntimeTick(env);
      await closeRuntimeDb(env);
      expect(env.infrastructure?.storageVerifiedWalHeight).toBeUndefined();
      await tryOpenStorageDb(env);
      await tryOpenRuntimeWalDb(env);
      const verifiedWalHeight = env.infrastructure?.storageVerifiedWalHeight;
      expect(verifiedWalHeight).toBe(2);
      if (verifiedWalHeight === undefined) throw new Error('Open WAL verification height missing');
      const db = getRuntimeStorageDb(env);
      const walDb = getRuntimeWalDb(env);
      const recoveryOptions = { db, walDb, config: resolveStorageRuntimeConfig(env), verifiedWalHeight };
      const intact = await recoverStorageDbFromWal(recoveryOptions);
      expect(intact.diagnostics.verifiedCurrent).toBe(true);
      expect(intact.recovered).toBe(false);

      // A verified authoritative WAL must never bless a damaged current copy.
      await db.put(Buffer.from([KEY_LIVE_ENTITY]), Buffer.from([0]));
      const repaired = await recoverStorageDbFromWal(recoveryOptions);
      expect(repaired.recovered).toBe(true);
      expect(repaired.diagnostics.headChanged).toBe(true);
      await commitRuntimeTick(env);
      const frame = await readStorageFrameRecord(walDb, 3);
      if (!frame) throw new Error('Recovery regression frame missing');
      await walDb.put(keyFrame(3), encodeBuffer({ ...frame, timestamp: frame.timestamp + 1 }));
      await expect(recoverStorageDbFromWal(recoveryOptions)).rejects.toThrow('STORAGE_VERIFY_CANONICAL_HASH_MISMATCH');
      await closeRuntimeDb(env);
      expect(env.infrastructure?.storageVerifiedWalHeight).toBeUndefined();
      await expect(tryOpenRuntimeWalDb(env)).rejects.toThrow('STORAGE_VERIFY_CANONICAL_HASH_MISMATCH');
    } finally {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      cleanup(runtimeId);
    }
  });

  test.each([2, 20])('live Activity refresh retains the exact bounded page at limit %i', async limit => {
    const { env, runtimeId } = await createStoredRuntime('activity-incremental-page');
    try {
      const queries: RuntimeAdapterReadQuery[] = [];
      const adapter = {
        read: <T>(path: string, query?: RuntimeAdapterReadQuery) => {
          queries.push(query ?? {});
          return resolveRuntimeAdapterRead<T>(
            {
              env,
              readActivityPage: opts => readPersistedRuntimeActivityPage(env, opts),
            },
            path,
            query,
          );
        },
      };
      const query = { limit, scanLimit: 3 };
      const read = createActivityPageReader(query);
      await commitRuntimeTick(env);
      const initial = await read(adapter, env.state.height);
      for (let i = 0; i < 4; i += 1) {
        await commitRuntimeTick(env);
        const updated = await read(adapter, env.state.height);
        const full = await readPersistedRuntimeActivityPage(env, query);
        expect(updated.events).toEqual(full.events);
        expect(updated.fromHeight).toBe(full.fromHeight);
        expect(updated.nextBeforeHeight).toBe(full.nextBeforeHeight);
      }
      expect(initial.toHeight).toBe(2);
      expect(queries.map(query => query.scanLimit)).toEqual([3, 1, 1, 1, 1]);
      await read(adapter, env.state.height);
      expect(queries).toHaveLength(5);
    } finally {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      cleanup(runtimeId);
    }
  });

  test('RAdapter receipt reads keep their captured storage head stable across a queued live commit', async () => {
    const { env, runtimeId } = await createStoredRuntime('receipt-read-live-commit');
    const captured = barrier<number>();
    const resume = barrier<void>();
    let writer: Promise<void> | undefined;
    try {
      await commitRuntimeTick(env);
      await commitRuntimeTick(env);
      await commitRuntimeTick(env);
      const read = resolveRuntimeAdapterRead<RuntimeAdapterFrameReceiptResponse>(
        {
          env,
          readFrameReceipts: query =>
            readRuntimeFrameReceipts(
              {
                latestHeight: async () => {
                  const height = await getPersistedLatestHeight(env);
                  captured.resolve(height);
                  await resume.promise;
                  return height;
                },
                journals: (from, to) => readPersistedRuntimeActivityJournals(env, from, to),
              },
              query,
            ),
        },
        'frame-receipts',
        { fromHeight: 2, toHeight: 5, eventNames: ['RuntimeTick'] },
      );
      expect(await captured.promise).toBe(4);
      writer = commitRuntimeTick(env);
      await Bun.sleep(10);
      expect(env.state.height).toBe(4);
      expect(env.infrastructure?.activeCommittedReaders).toBe(1);
      resume.resolve();
      const page = await read;
      expect(page.toHeight).toBe(4);
      expect(page.receipts.map(receipt => [receipt.height, receipt.logs.map(log => log.message)])).toEqual([
        [2, ['RuntimeTick']],
        [3, ['RuntimeTick']],
        [4, ['RuntimeTick']],
      ]);
      await writer;
      expect(await getPersistedLatestHeight(env)).toBe(5);
      expect(env.infrastructure?.activeCommittedReaders).toBe(0);
    } finally {
      resume.resolve();
      await writer;
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      cleanup(runtimeId);
    }
  });

  test('an activity read cannot rewind a newer committed view while awaiting WAL I/O', async () => {
    const { env, runtimeId } = await createStoredRuntime('activity-live-append-race');
    const captured = barrier<number>();
    const resume = barrier<void>();
    let repair: Promise<void> | null = null;
    try {
      await commitRuntimeTick(env);
      const original = await readRuntimeActivityViewStatus(env);
      expect(original?.latestHeight).toBe(2);
      const frameBefore = await readPersistedStorageFrameRecord(env, 2);
      const deps: PersistenceQueryDeps = {
        tryOpenStorageDb,
        getStorageDb,
        tryOpenRuntimeWalDb,
        getRuntimeWalDb,
        // Only the schedule is controlled: this is the real committed LevelDB HEAD.
        resolvePersistedLatestHeight: async source => {
          const height = await getPersistedLatestHeight(source);
          captured.resolve(height);
          await resume.promise;
          return height;
        },
        resolvePersistedCheckpointHeights: listPersistedCheckpointHeights,
        readPersistedStorageFrameRecord,
        readPersistedStorageFramePayloads,
        loadEnvFromStorageByReplay,
        replayRecoveryFrameJournals,
        closeRuntimeDb,
        closeInfraDb,
        restoreEnvFromRecoveryBundles,
        withStorageConsistentRead,
      };
      repair = ensureRuntimeActivityView(deps, env, buildRecoveryJournalFromStorageFrame);
      expect(await captured.promise).toBe(2);
      // WAL commit must remain independent of the disposable-view repair lock.
      await commitRuntimeTick(env);
      expect(await getPersistedLatestHeight(env)).toBe(3);
      const viewAfterAppend = readRuntimeActivityViewStatus(env);
      resume.resolve();
      await repair;
      expect(await viewAfterAppend).toEqual({ ...original, latestHeight: 3 });
      expect(await readRuntimeActivityViewStatus(env)).toEqual({ ...original, latestHeight: 3 });
      expect(await readPersistedStorageFrameRecord(env, 2)).toEqual(frameBefore);
      expect((await readPersistedRuntimeActivityJournal(env, 3))?.logs.map(log => log.message)).toEqual([
        'RuntimeTick',
      ]);
      await commitRuntimeTick(env);
      expect((await readRuntimeActivityViewStatus(env))?.latestHeight).toBe(4);
      expect(env.infrastructure?.runtimeActivityViewFailure).toBeUndefined();
    } finally {
      resume.resolve();
      await repair;
      await closeRuntimeDb(env);
      await closeInfraDb(env);
      cleanup(runtimeId);
    }
  });

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
    const warn = spyOn(console, 'warn');
    try {
      await commitRuntimeTick(env);
      await readRuntimeActivityViewStatus(env);
      // A view behind the WAL (the last append lost at restart) is repaired on
      // read; it is not a write failure, and the browser health gate fails on
      // every console warning.
      expect(warn.mock.calls.flat().join(' ')).not.toContain('activity_view.write_failed');
    } finally {
      warn.mockRestore();
    }
    expect(env.infrastructure?.runtimeActivityViewFailure).toEqual({
      height: 2,
      message: 'RUNTIME_ACTIVITY_VIEW_GAP:height=2',
    });
    expect((await readPersistedRuntimeActivityJournal(env, 2))?.logs.map(log => log.message)).toEqual(['RuntimeTick']);
    expect(env.infrastructure?.runtimeActivityViewFailure).toBeUndefined();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanup(runtimeId);
  });

  test('accepts an exact late append after the disposable view advanced', async () => {
    const { env, runtimeId } = await createStoredRuntime('activity-late-append');
    await commitRuntimeTick(env);
    const frame = await readStorageFrameRecord(getRuntimeWalDb(env), 2);
    if (!frame) throw new Error('TEST_RUNTIME_FRAME_MISSING:2');
    await commitRuntimeTick(env);
    expect((await readRuntimeActivityViewStatus(env))?.latestHeight).toBe(3);

    expect(await appendRuntimeActivityViewFrame(env, frame, [])).toBe('idempotent');
    expect((await readRuntimeActivityViewStatus(env))?.latestHeight).toBe(3);

    await closeRuntimeDb(env);
    await closeInfraDb(env);
    cleanup(runtimeId);
  });
});
