import { describe, expect, test } from 'bun:test';

import { encodeBuffer } from '../storage/codec';
import { readFrameDbHead } from '../storage/frame-db';
import { inspectStorage } from '../storage/inspect';
import { recoverStorageDbFromHistory } from '../storage/index';
import {
  KEY_FRAME_DB_HEAD,
  KEY_HEAD,
  STORAGE_FRAME_FORMAT,
  STORAGE_SCHEMA_VERSION,
} from '../storage/keys';
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
  epochReplayBytes: 1_024,
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
      `STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(readStorageHead(memoryDbWithHead(currentHead(3)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=3:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(readStorageHead(memoryDbWithHead(currentHead(4)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=4:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(readStorageHead(memoryDbWithHead(currentHead(6)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=6:current=${STORAGE_SCHEMA_VERSION}:boundary=storage-head`,
    );
    expect(STORAGE_SCHEMA_VERSION).toBe(9);
  });

  test('pins the one current frame format as one inseparable descriptor', () => {
    expect(STORAGE_FRAME_FORMAT).toEqual({
      schemaVersion: 9,
      domain: 'xln.storage.frame',
      postStateDomain: 'xln.storage.postState',
      algorithmId: 'sha256',
      hashMode: 'storage-merkle-v1',
    });
    expect(Object.isFrozen(STORAGE_FRAME_FORMAT)).toBe(true);
  });

  test('accepts only the current schema and preserves an empty database', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(STORAGE_SCHEMA_VERSION)))).resolves.toEqual(
      currentHead(STORAGE_SCHEMA_VERSION),
    );
    await expect(readStorageHead(memoryDb())).resolves.toBeNull();
  });

  test('rejects future and malformed storage heads fail-closed', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(STORAGE_SCHEMA_VERSION + 1)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=${STORAGE_SCHEMA_VERSION + 1}:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(
      readStorageHead(memoryDb([[KEY_HEAD, {
        ...currentHead(STORAGE_SCHEMA_VERSION),
        schemaVersion: String(STORAGE_SCHEMA_VERSION),
      }]])),
    ).rejects.toThrow(
      `STORAGE_SCHEMA_INVALID:stored=${STORAGE_SCHEMA_VERSION}:current=${STORAGE_SCHEMA_VERSION}`,
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
      `STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}:boundary=frame-db-head`,
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
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
    await expect(verifyStorageTailIntegrity(legacyDb)).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(
      seedFreshStorageEpoch({
        sourceDb: legacyDb,
        targetDb: memoryDb(),
        snapshotHeight: 7,
      }),
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
    await expect(
      inspectStorage({
        env: {} as Env,
        tryOpenDb: async () => true,
        getRuntimeDb: () => legacyDb,
      }),
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
  });
});
