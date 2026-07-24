import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';

import { closeInfraDb, closeRuntimeDb, createEmptyEnv, getFrameDb, readPersistedFrameJournal } from '../runtime';
import { deriveSignerAddressSync } from '../account/crypto';
import { encodeBuffer } from '../storage/codec';
import { computeStorageFrameHash, computeStorageReplicaMetaDigest } from '../storage/hashes';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyFrame,
  keyFrameDbRuntimeActivity,
  ZERO_FRAME_HASH,
} from '../storage/keys';
import { resolveDbPath } from '../storage/runtime-dbs';
import type { StorageFrameRecord } from '../storage/types';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const base = cleanupPaths.pop()!;
    for (const suffix of ['', '-storage-current', '-storage-previous', '-frames', '-events', '-infra']) {
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
    const frameDb = getFrameDb(env);
    await frameDb.open();
    const frameBase: StorageFrameRecord = {
      height: 1,
      timestamp: 1_234,
      prevFrameHash: ZERO_FRAME_HASH,
      replicaMetaDigest: computeStorageReplicaMetaDigest([]),
      replicaMetaCheckpoint: false,
      replicaMetaStateMode: 'live-head',
      postStateHash: ZERO_FRAME_HASH,
      stateHash: ZERO_FRAME_HASH,
      hashMode: 'storage-merkle-v1',
      materializedState: true,
      entityHashes: [],
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };
    const frame: StorageFrameRecord = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };
    await frameDb.put(
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
    await frameDb.put(keyFrame(1), encodeBuffer(frame), { sync: true });
    await frameDb.put(keyFrameDbRuntimeActivity(1), Buffer.from([0xc1]), { sync: true });
    try {
      await expect(readPersistedFrameJournal(env, 1)).rejects.toThrow();
    } finally {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
  });
});
