import { describe, expect, test } from 'bun:test';

import { encodeBuffer } from '../storage/codec';
import { readFrameDbHead } from '../storage/frame-db';
import { inspectStorage } from '../storage/inspect';
import { recoverStorageDbFromHistory } from '../storage/index';
import { KEY_FRAME_DB_HEAD, KEY_HEAD, STORAGE_SCHEMA_VERSION } from '../storage/keys';
import { seedFreshStorageEpoch } from '../storage/lifecycle';
import { readStorageHead } from '../storage/read';
import type { RuntimeDbLike, StorageFrameDbHead, StorageHead, StorageRuntimeConfig } from '../storage/types';
import { verifyStorageTailIntegrity } from '../storage/verify';
import type { Env } from '../types';

const currentHead = (schemaVersion: number): StorageHead => ({
  schemaVersion,
  latestHeight: 7,
  latestMaterializedHeight: 7,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 256 * 1024 * 1024,
  accountMerkleRadix: 16,
  retainedHistoryBytes: 1_024,
});

const storageConfig: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 256 * 1024 * 1024,
  frameDbMaxBytes: 256 * 1024 * 1024,
  frameDbRetainFrames: 100_000,
  materializePeriodFrames: 64,
  accountMerkleRadix: 16,
};

const memoryDb = (entries: Array<[Buffer, unknown]> = []): RuntimeDbLike => {
  const values = new Map(entries.map(([key, value]) => [key.toString('hex'), encodeBuffer(value)]));
  return {
    get: async (key: Buffer) => {
      const value = values.get(key.toString('hex'));
      if (value) return Buffer.from(value);
      const error = new Error('NotFound') as Error & { code?: string };
      error.code = 'LEVEL_NOT_FOUND';
      throw error;
    },
    batch: () => ({
      put: (key: Buffer, value: Buffer) => values.set(key.toString('hex'), Buffer.from(value)),
      del: (key: Buffer) => values.delete(key.toString('hex')),
      write: async () => {},
    }),
    keys: async function* () {
      for (const key of Array.from(values.keys()).sort()) yield Buffer.from(key, 'hex');
    },
  };
};

const memoryDbWithHead = (head: StorageHead): RuntimeDbLike => memoryDb([[KEY_HEAD, head]]);

describe('storage schema boundary', () => {
  test('rejects legacy command and incomplete-checkpoint schemas before hydrating entity state', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(2)))).rejects.toThrow(
      'STORAGE_SCHEMA_MISMATCH:stored=2:current=5',
    );
    await expect(readStorageHead(memoryDbWithHead(currentHead(3)))).rejects.toThrow(
      'STORAGE_SCHEMA_MISMATCH:stored=3:current=5',
    );
    await expect(readStorageHead(memoryDbWithHead(currentHead(4)))).rejects.toThrow(
      'STORAGE_SCHEMA_MISMATCH:stored=4:current=5',
    );
    expect(STORAGE_SCHEMA_VERSION).toBe(5);
  });

  test('accepts only the current schema and preserves an empty database', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(STORAGE_SCHEMA_VERSION)))).resolves.toEqual(
      currentHead(STORAGE_SCHEMA_VERSION),
    );
    await expect(readStorageHead(memoryDb())).resolves.toBeNull();
  });

  test('rejects future and malformed storage heads fail-closed', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(STORAGE_SCHEMA_VERSION + 1)))).rejects.toThrow(
      'STORAGE_SCHEMA_MISMATCH:stored=6:current=5',
    );
    await expect(
      readStorageHead(memoryDb([[KEY_HEAD, { ...currentHead(5), schemaVersion: '5' }]])),
    ).rejects.toThrow(
      'STORAGE_SCHEMA_INVALID:stored=5:current=5',
    );
  });

  test('rejects legacy frame-journal heads instead of relabelling them current', async () => {
    const legacy: StorageFrameDbHead = {
      schemaVersion: 2,
      latestHeight: 7,
      latestPrunedRuntimeHeight: 0,
      retainedBytes: 1_024,
      maxBytes: storageConfig.frameDbMaxBytes,
      retainFrames: storageConfig.frameDbRetainFrames,
    };
    await expect(readFrameDbHead(memoryDb([[KEY_FRAME_DB_HEAD, legacy]]), storageConfig)).rejects.toThrow(
      'STORAGE_SCHEMA_MISMATCH:stored=2:current=5:boundary=frame-db-head',
    );
  });

  test('rejects legacy heads at recovery, verification, rotation, and inspection boundaries', async () => {
    const legacyDb = memoryDbWithHead(currentHead(2));
    await expect(
      recoverStorageDbFromHistory({
        db: memoryDb(),
        historyDb: legacyDb,
        config: storageConfig,
      }),
    ).rejects.toThrow('STORAGE_SCHEMA_MISMATCH:stored=2:current=5');
    await expect(verifyStorageTailIntegrity(legacyDb)).rejects.toThrow('STORAGE_SCHEMA_MISMATCH:stored=2:current=5');
    await expect(
      seedFreshStorageEpoch({
        sourceDb: legacyDb,
        targetDb: memoryDb(),
        snapshotHeight: 7,
      }),
    ).rejects.toThrow('STORAGE_SCHEMA_MISMATCH:stored=2:current=5');
    await expect(
      inspectStorage({
        env: {} as Env,
        tryOpenDb: async () => true,
        getRuntimeDb: () => legacyDb,
      }),
    ).rejects.toThrow('STORAGE_SCHEMA_MISMATCH:stored=2:current=5');
  });
});
