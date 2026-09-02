import { describe, expect, test } from 'bun:test';

import { encodeBuffer } from '../../../storage/codec/codec';
import { inspectStorage } from '../../../storage/read/inspect';
import { recoverStorageDbFromWal } from '../../../storage/index';
import {
  KEY_HEAD,
  STORAGE_FRAME_FORMAT,
  STORAGE_SCHEMA_VERSION,
} from '../../../storage/keys';
import { seedFreshStorageEpoch } from '../../../storage/database/lifecycle';
import { readStorageHead } from '../../../storage/read/read';
import type { RuntimeDbLike, StorageHead, StorageRuntimeConfig } from '../../../storage/types';
import { verifyStorageTailIntegrity } from '../../../storage/read/verify';
import type { RuntimeReplica } from '../../../runtime/types';

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
  retainedWalBytes: 1_024,
});

const storageConfig: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 256 * 1024 * 1024,
  materializePeriodFrames: 64,
  canonicalHashPeriodFrames: 0,
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
  test('rejects retired command and incomplete-checkpoint schemas before hydrating entity state', async () => {
    await expect(readStorageHead(memoryDbWithHead(currentHead(1)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=1:current=${STORAGE_SCHEMA_VERSION}`,
    );
    // Version 2 is the retired format that persisted the Runtime mempool as
    // `pendingRuntimeInput`; it is rejected, never migrated.
    await expect(readStorageHead(memoryDbWithHead(currentHead(2)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`,
    );
    // Version 3 used the misleading `retainedHistoryBytes` field for the
    // bounded Runtime WAL. Later schemas reject it instead of keeping an alias.
    await expect(readStorageHead(memoryDbWithHead(currentHead(3)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=3:current=${STORAGE_SCHEMA_VERSION}`,
    );
    // Version 4 used the retired canonical Runtime hash preimage and
    // height-scoped Runtime-machine physical keys. It is rejected, never read
    // through a compatibility layout.
    await expect(readStorageHead(memoryDbWithHead(currentHead(4)))).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=4:current=${STORAGE_SCHEMA_VERSION}:boundary=storage-head`,
    );
    expect(STORAGE_SCHEMA_VERSION).toBe(5);
  });

  test('pins the one current frame format as one inseparable descriptor', () => {
    expect(STORAGE_FRAME_FORMAT).toEqual({
      schemaVersion: 5,
      domain: 'xln.storage.frame',
      postStateDomain: 'xln.storage.postState',
      algorithmId: 'sha256',
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

  test('rejects retired heads at recovery, verification, rotation, and inspection boundaries', async () => {
    const obsoleteDb = memoryDbWithHead(currentHead(2));
    await expect(
      recoverStorageDbFromWal({
        db: memoryDb(),
        walDb: obsoleteDb,
        config: storageConfig,
      }),
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
    await expect(verifyStorageTailIntegrity(obsoleteDb)).rejects.toThrow(
      `STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`,
    );
    await expect(
      seedFreshStorageEpoch({
        sourceDb: obsoleteDb,
        targetDb: memoryDb(),
        snapshotHeight: 7,
      }),
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
    await expect(
      inspectStorage({
        env: {} as RuntimeReplica,
        tryOpenDb: async () => true,
        getRuntimeDb: () => obsoleteDb,
      }),
    ).rejects.toThrow(`STORAGE_SCHEMA_MISMATCH:stored=2:current=${STORAGE_SCHEMA_VERSION}`);
  });
});
