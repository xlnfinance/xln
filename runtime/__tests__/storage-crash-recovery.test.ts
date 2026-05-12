import { describe, expect, test } from 'bun:test';

import {
  recoverStorageDbFromHistory,
} from '../storage';
import {
  buildFrameDbPuts,
  prepareFrameDbCommit,
  putFrameDbCommit,
  readFrameDbHead,
  readFrameDbRuntimeActivity,
} from '../storage/frame-db';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { liveKeyForDoc } from '../storage/doc-refs';
import { prepareStorageStateHashes } from '../storage/hashes';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyDiff,
} from '../storage/keys';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDiffRecord,
  StorageDoc,
  StorageEntityCoreDoc,
  StorageHead,
  StorageRuntimeConfig,
} from '../storage/types';

const entityId = `0x${'11'.repeat(32)}`;
type PreparedStorageHashes = Awaited<ReturnType<typeof prepareStorageStateHashes>>;

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 1_000_000,
  frameDbMaxBytes: 1_000_000,
  frameDbRetainFrames: 128,
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

const entityDoc = (height: number): StorageEntityCoreDoc => ({
  entityId,
  height,
  timestamp: height,
  messages: [],
  nonces: new Map(),
  proposals: new Map(),
  config: { validators: [entityId] } as StorageEntityCoreDoc['config'],
  reserves: new Map([[1, BigInt(height)]]),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: '',
  entityEncPrivKey: '',
  profile: { name: `entity-${height}` } as StorageEntityCoreDoc['profile'],
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const entityDiff = (height: number): StorageDiffRecord => {
  const doc: StorageDoc = { family: 'entity', entityId, value: entityDoc(height) };
  return { height, puts: [doc], dels: [] };
};

const accountId = (prefix: string): string => `0x${prefix.padEnd(64, '0')}`;

const accountDoc = (counterpartyId: string, version: number): StorageAccountDoc => ({
  rightEntity: counterpartyId,
  currentHeight: version,
} as unknown as StorageAccountDoc);

const accountPut = (counterpartyId: string, version: number): StorageDoc => ({
  family: 'account',
  entityId,
  counterpartyId,
  value: accountDoc(counterpartyId, version),
});

const merkleEntries = (prepared: PreparedStorageHashes): Array<[Buffer, Buffer]> =>
  prepared.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]);

const applyMerkleDiff = (
  entries: Array<[Buffer, Buffer]>,
  prepared: PreparedStorageHashes,
): Array<[Buffer, Buffer]> => {
  const rows = new Map<string, [Buffer, Buffer]>();
  for (const [key, value] of entries) rows.set(key.toString('hex'), [Buffer.from(key), Buffer.from(value)]);
  for (const key of prepared.merkleDels) rows.delete(key.toString('hex'));
  for (const put of prepared.merklePuts) rows.set(put.key.toString('hex'), [Buffer.from(put.key), Buffer.from(put.value)]);
  return Array.from(rows.values()).sort(([left], [right]) => Buffer.compare(left, right));
};

const entityHash = (prepared: PreparedStorageHashes): string =>
  prepared.entityHashDocs.get(entityId)?.hash ?? '';

const expectNoMerklePutDeleteOverlap = (prepared: PreparedStorageHashes): void => {
  const putKeys = new Set(prepared.merklePuts.map((item) => item.key.toString('hex')));
  expect(prepared.merkleDels.some((key) => putKeys.has(key.toString('hex')))).toBe(false);
};

const head = (latestHeight: number, latestMaterializedHeight: number): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight,
  latestMaterializedHeight,
  latestSnapshotHeight: latestMaterializedHeight,
  snapshotPeriodFrames: config.snapshotPeriodFrames,
  retainSnapshots: config.retainSnapshots,
  epochMaxBytes: config.epochMaxBytes,
  accountMerkleRadix: config.accountMerkleRadix,
  retainedHistoryBytes: 0,
});

describe('storage crash recovery', () => {
  test('replays materialized diffs into current DB and catches up head from history DB', async () => {
    const diff1 = entityDiff(1);
    const diff2 = entityDiff(2);
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(3, 2))],
      [keyDiff(1), encodeBuffer(diff1)],
      [keyDiff(2), encodeBuffer(diff2)],
    ]);

    const result = await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    expect(result.recovered).toBe(true);

    const recoveredHead = decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD));
    expect(recoveredHead.latestHeight).toBe(3);
    expect(recoveredHead.latestMaterializedHeight).toBe(2);

    const recoveredDoc = decodeBuffer<StorageEntityCoreDoc>(await currentDb.get(liveKeyForDoc(diff2.puts[0]!)));
    expect(recoveredDoc.height).toBe(2);
    expect(recoveredDoc.profile.name).toBe('entity-2');
  });

  test('rejects current DB state that is ahead of authoritative history DB', async () => {
    const currentDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(4, 4))]]);
    const historyDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(3, 3))]]);

    await expect(recoverStorageDbFromHistory({ db: currentDb, historyDb, config }))
      .rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');
  });

  test('frame DB activity rows and head can be committed by the caller batch', async () => {
    const historyDb = makeMemoryDb();
    const puts = buildFrameDbPuts({
      height: 7,
      timestamp: 700,
      logs: [{ id: 1, category: 'system', level: 'info', message: 'durable', timestamp: 700 }],
      touchedEntities: [entityId],
      touchedAccounts: [],
      touchedBookEntities: [],
      frameDbRecords: [],
    });
    const plan = await prepareFrameDbCommit({ db: historyDb, height: 7, puts, config });
    const batch = historyDb.batch();
    putFrameDbCommit(batch, plan);
    await batch.write();

    const activity = await readFrameDbRuntimeActivity(historyDb, 7);
    expect(activity?.logs[0]?.message).toBe('durable');

    const frameHead = await readFrameDbHead(historyDb, config);
    expect(frameHead.latestHeight).toBe(7);
    expect(frameHead.retainedBytes).toBe(plan.writtenBytes);
  });

  test('storage hash preparation remains usable on recovered live docs', async () => {
    const diff1 = entityDiff(1);
    const diff2 = entityDiff(2);
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(2, 2))],
      [keyDiff(1), encodeBuffer(diff1)],
      [keyDiff(2), encodeBuffer(diff2)],
    ]);

    const result = await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    const diff3 = entityDiff(3);
    const prepared = await prepareStorageStateHashes({
      db: currentDb,
      puts: diff3.puts,
      dels: [],
      ...(result.entityHashDocs ? { entityHashDocs: result.entityHashDocs } : {}),
    });

    expect(prepared.entityHashes).toHaveLength(1);
    expect(prepared.entityHashes[0]?.entityId).toBe(entityId);
  });

  test('merkle flush diff cancels split then collapse in one frame', async () => {
    const left = accountId('1');
    const right = accountId('2');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(left, 1)],
      dels: [],
    });

    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(right, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: right }],
    });

    expect(entityHash(prepared)).toBe(entityHash(initial));
    expect(prepared.entityHashDocs.get(entityId)?.cellCount).toBe(1);
    expect(prepared.merkleDels).toHaveLength(0);
    expectNoMerklePutDeleteOverlap(prepared);
  });

  test('merkle flush diff handles collapse then split without deleting surviving leaves', async () => {
    const survivor = accountId('1');
    const removed = accountId('2');
    const addedUnderSurvivorPrefix = accountId('12');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(survivor, 1), accountPut(removed, 1)],
      dels: [],
    });

    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(addedUnderSurvivorPrefix, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: removed }],
    });
    const reference = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(survivor, 1), accountPut(addedUnderSurvivorPrefix, 1)],
      dels: [],
    });

    expect(entityHash(prepared)).toBe(entityHash(reference));
    expect(prepared.entityHashDocs.get(entityId)?.cellCount).toBe(2);
    expect(prepared.merkleDels.length).toBeGreaterThan(0);
    expectNoMerklePutDeleteOverlap(prepared);
  });

  test('merkle editor can flush, reload from db, and continue to the same root', async () => {
    const a = accountId('1');
    const b = accountId('2');
    const c = accountId('3');
    const d = accountId('31');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(a, 1), accountPut(b, 1), accountPut(c, 1)],
      dels: [],
    });
    const first = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(a, 2)],
      dels: [{ family: 'account', entityId, counterpartyId: b }],
    });
    const afterFirstEntries = applyMerkleDiff(merkleEntries(initial), first);

    const second = await prepareStorageStateHashes({
      db: makeMemoryDb(afterFirstEntries),
      puts: [accountPut(c, 2), accountPut(d, 1)],
      dels: [],
    });
    const reference = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(a, 2), accountPut(c, 2), accountPut(d, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: b }],
    });

    expect(entityHash(second)).toBe(entityHash(reference));
    expect(second.entityHashDocs.get(entityId)?.cellCount).toBe(3);
    expectNoMerklePutDeleteOverlap(first);
    expectNoMerklePutDeleteOverlap(second);
  });
});
