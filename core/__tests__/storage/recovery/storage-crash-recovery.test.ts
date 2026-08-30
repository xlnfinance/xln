import { describe, expect, test } from 'bun:test';

import { recoverStorageDbFromWal } from '../../../storage';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { liveKeyForDoc } from '../../../storage/schema/doc-refs';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
} from '../../../storage/keys';
import { preparePathKeyedAuxiliaryRows } from '../../../storage/schema/nodes/path-keyed-auxiliary-nodes';
import { validatePersistedCertifiedBoardPathNode } from '../../../storage/schema/authoritative-schema';
import type {
  RuntimeDbLike,
  StorageHead,
  StorageRuntimeConfig,
} from '../../../storage/types';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';

const entityId = `0x${'11'.repeat(32)}`;

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 1_000_000,
  materializePeriodFrames: 1,
  accountMerkleRadix: 16,
};

const makeMemoryDb = (entries: Array<[Buffer, Buffer]> = []): RuntimeDbLike => {
  const store = new Map<string, { key: Buffer; value: Buffer }>();
  for (const [key, value] of entries) {
    store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
  }
  return {
    get: async (key: Buffer) => {
      const item = store.get(key.toString('hex'));
      if (!item) {
        const error = new Error('NotFound') as Error & { code?: string; notFound?: boolean };
        error.code = 'LEVEL_NOT_FOUND';
        error.notFound = true;
        throw error;
      }
      return Buffer.from(item.value);
    },
    batch: () => ({
      put: (key: Buffer, value: Buffer) => {
        store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
      },
      del: (key: Buffer) => {
        store.delete(key.toString('hex'));
      },
      write: async () => {},
    }),
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) {
      const ordered = Array.from(store.values()).map((item) => item.key).sort(Buffer.compare);
      if (options?.reverse) ordered.reverse();
      for (const key of ordered) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

const head = (latestHeight: number, latestMaterializedHeight: number): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight,
  latestMaterializedHeight,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: config.snapshotPeriodFrames,
  retainSnapshots: config.retainSnapshots,
  epochMaxBytes: config.epochMaxBytes,
  accountMerkleRadix: config.accountMerkleRadix,
  epochReplayBytes: 0,
  retainedWalBytes: 0,
});

describe('storage crash recovery', () => {
  test('copies path-keyed certified-board nodes before publishing recovered current head', async () => {
    const stackKey = getCertifiedBoardStackKey({
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
    });
    const update = putCertifiedBoardRecord(new Map(), EMPTY_CERTIFIED_BOARD_ROOT, {
      stackKey,
      entityId,
      boardHash: `0x${'33'.repeat(32)}`,
      boardEpoch: 0,
      previousBoardHash: `0x${'00'.repeat(32)}`,
      previousBoardValidUntil: 0,
      activatedAtJHeight: 1,
      logIndex: 0,
      blockHash: `0x${'44'.repeat(32)}`,
      transactionHash: `0x${'55'.repeat(32)}`,
      source: 'EntityRegistered',
    });
    const boardStore = new Map(update.newNodes);
    const [row] = preparePathKeyedAuxiliaryRows({
      owners: [{ entityId, certifiedBoardRoot: update.root, accounts: [] }],
      certifiedBoardStore: boardStore,
      accountJClaimStore: new Map(),
    }).certifiedBoardNodes;
    if (!row) throw new Error('expected board path row');
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(1, 0))],
      [row.key, row.value],
    ]);
    await recoverStorageDbFromWal({ db: currentDb, walDb: historyDb, config });
    expect(validatePersistedCertifiedBoardPathNode(
      decodeBuffer(await currentDb.get(row.key)),
    ).node).toEqual([...boardStore.values()][0]);
    expect(decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD)).latestHeight).toBe(1);
  });

  test('rejects current DB state that is ahead of the authoritative Runtime WAL', async () => {
    const currentDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(4, 4))]]);
    const historyDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(3, 3))]]);

    await expect(recoverStorageDbFromWal({ db: currentDb, walDb: historyDb, config }))
      .rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_WAL');
  });

});
