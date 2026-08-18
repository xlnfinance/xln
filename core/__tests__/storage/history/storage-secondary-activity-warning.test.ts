import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';

import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  getRuntimeWalDb,
  getHistoryViewDb,
  readPersistedRuntimeActivityJournal,
} from '../../../runtime';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { encodeBuffer } from '../../../storage/codec/codec';
import { computeStorageFrameHash } from '../../../storage/hashes';
import { computeStorageReplicaMetaDigest } from '../../../storage/replica/replica-meta-digest';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyFrame,
  keyHistoryViewRuntimeActivity,
  ZERO_FRAME_HASH,
} from '../../../storage/keys';
import { resolveDbPath } from '../../../storage/runtime-dbs';
import type { RuntimeFrame } from '../../../storage/types';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const base = cleanupPaths.pop()!;
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-events', '-infra']) {
      rmSync(`${base}${suffix}`, { recursive: true, force: true });
    }
  }
});

describe('secondary storage error severity', () => {
  test('fails activity journal reads loudly when persisted activity is corrupt', async () => {
    const seed = `secondary activity warning ${process.pid} deterministic seed`;
    const env = createEmptyEnv(seed);
    env.runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
    env.dbNamespace = env.runtimeId;
    cleanupPaths.push(resolveDbPath(env, 'core'));
    const historyView = getRuntimeWalDb(env);
    await historyView.open();
    const frameBase: RuntimeFrame = {
      height: 1,
      timestamp: 1_234,
      prevFrameHash: ZERO_FRAME_HASH,
      replicaMetaDigest: computeStorageReplicaMetaDigest([]),
      replicaMetaCheckpoint: false,
      replicaMetaStateMode: 'live-head',
      postStateHash: ZERO_FRAME_HASH,
      materializedState: false,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };
    const frame: RuntimeFrame = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };
    await historyView.put(
      KEY_HEAD,
      encodeBuffer({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 1,
        latestMaterializedHeight: 1,
        latestSnapshotHeight: 0,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 268_435_456,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      { sync: true },
    );
    await historyView.put(keyFrame(1), encodeBuffer(frame), { sync: true });
    const historyViewDb = getHistoryViewDb(env);
    await historyViewDb.open();
    await historyViewDb.put(keyHistoryViewRuntimeActivity(1), Buffer.from([0xc1]), { sync: true });
    try {
      await expect(readPersistedRuntimeActivityJournal(env, 1)).rejects.toThrow(
        'STORAGE_ACTIVITY_JOURNAL_READ_FAILED',
      );
    } finally {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
  });
});
