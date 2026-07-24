import { describe, expect, test } from 'bun:test';

import {
  validateStorageBookDocValue,
  validateStorageEntityCoreDocValue,
} from '../storage/authoritative-schema';
import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';
import { prepareStorageStateHashes } from '../storage/hashes';
import {
  KEY_HEAD,
  KEY_REBRANCH_NODE,
  STORAGE_SCHEMA_VERSION,
  keyLiveAccount,
  keyLiveAccountField,
  keyLiveBook,
  keyLiveEntity,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
} from '../storage/keys';
import {
  readAccountStorageLayout,
  STORAGE_ACCOUNT_FIELD_TAG,
} from '../storage/account-layout';
import {
  createSnapshot,
  maybeRotateSnapshots,
  readSnapshotDocs,
  seedFreshStorageEpoch,
} from '../storage/lifecycle';
import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withRebranchedValues,
} from '../storage/rebranched-db';
import type {
  RuntimeDbLike,
  StorageDoc,
  StorageDocRef,
  StorageHead,
} from '../storage/types';
import { MemoryRuntimeDb } from './fixtures/memory-runtime-db';
import {
  entityDocWithEncodedSize,
  oversizedAccount,
  oversizedBook,
  storageCounterpartyId as counterpartyId,
  storageEntityId as entityId,
  storagePairId as pairId,
} from './fixtures/oversized-storage-docs';

const physicalPrefix = (logicalKey: Buffer): string => Buffer.concat([
  Buffer.from([KEY_REBRANCH_NODE]),
  Buffer.from([(logicalKey.byteLength >>> 8) & 0xff, logicalKey.byteLength & 0xff]),
  logicalKey,
]).toString('hex');

const physicalKeysFor = (raw: MemoryRuntimeDb, logicalKey: Buffer): string[] => {
  const prefix = physicalPrefix(logicalKey);
  return Array.from(raw.rows.keys()).filter(key => key.startsWith(prefix)).sort();
};

const applyPrepared = async (
  db: RuntimeDbLike,
  puts: StorageDoc[],
  dels: StorageDocRef[],
): Promise<void> => {
  const prepared = await prepareStorageStateHashes({ db, puts, dels });
  const putKeys = new Set([
    ...prepared.docPuts,
    ...prepared.merklePuts,
  ].map(item => item.key.toString('hex')));
  const delKeys = [
    ...prepared.docDels,
    ...prepared.merkleDels,
  ].map(key => key.toString('hex'));
  expect(delKeys.some(key => putKeys.has(key))).toBeFalse();

  const batch = db.batch();
  for (const key of prepared.docDels) batch.del?.(key);
  for (const item of prepared.docPuts) batch.put(item.key, item.value);
  for (const key of prepared.merkleDels) batch.del?.(key);
  for (const item of prepared.merklePuts) batch.put(item.key, item.value);
  await batch.write();
};

const storageHead = (
  latestHeight: number,
  latestSnapshotHeight: number,
): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight,
  latestMaterializedHeight: latestHeight,
  latestSnapshotHeight,
  snapshotPeriodFrames: 1,
  retainSnapshots: 1,
  epochMaxBytes: 1_000_000,
  accountMerkleRadix: 16,
  epochReplayBytes: 0,
  retainedHistoryBytes: 0,
});

const putHead = async (db: RuntimeDbLike, head: StorageHead): Promise<void> => {
  const batch = db.batch();
  batch.put(KEY_HEAD, encodeBuffer(head));
  await batch.write();
};

const snapshotBookKey = (height: number): Buffer => Buffer.concat([
  keySnapshotBookPrefix(height),
  keyLiveBook(entityId, pairId).subarray(1),
]);

const snapshotAccountKey = (height: number): Buffer => Buffer.concat([
  keySnapshotAccountPrefix(height),
  keyLiveAccount(entityId, counterpartyId).subarray(1),
]);

describe('typed Entity and Book physical rebranch matrix', () => {
  test('uses the exact 9,999/10,000 boundary and reclaims every typed tree', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const entityKey = keyLiveEntity(entityId);
    const bookKey = keyLiveBook(entityId, pairId);
    const inlineEntity = entityDocWithEncodedSize(9_999);
    const splitEntity = entityDocWithEncodedSize(10_000);
    const book = oversizedBook();

    await applyPrepared(db, [{
      family: 'entity',
      entityId,
      value: inlineEntity,
    }], []);
    expect(physicalKeysFor(raw, entityKey)).toEqual([]);
    expect(decodeValidatedBuffer(
      await db.get(entityKey),
      validateStorageEntityCoreDocValue,
    )).toEqual(inlineEntity);

    await applyPrepared(db, [
      { family: 'entity', entityId, value: splitEntity },
      { family: 'book', entityId, pairId, value: book },
    ], []);
    expect(physicalKeysFor(raw, entityKey).length).toBeGreaterThan(0);
    expect(physicalKeysFor(raw, bookKey).length).toBeGreaterThan(0);
    expect(Math.max(...Array.from(raw.rows.values(), value => value.byteLength)))
      .toBeLessThan(STORAGE_MAX_PHYSICAL_VALUE_BYTES);
    expect(decodeValidatedBuffer(
      await db.get(entityKey),
      validateStorageEntityCoreDocValue,
    )).toEqual(splitEntity);
    expect(await db.get(bookKey)).toEqual(encodeBuffer(book));
    const restoredBook = decodeValidatedBuffer(
      await db.get(bookKey),
      validateStorageBookDocValue,
    );
    expect(restoredBook.orders.size).toBe(book.orders.size);
    expect(restoredBook.bidBucketIdsDesc).toEqual(book.bidBucketIdsDesc);

    await applyPrepared(db, [], [
      { family: 'book', entityId, pairId },
      { family: 'entity', entityId },
    ]);
    expect(physicalKeysFor(raw, entityKey)).toEqual([]);
    expect(physicalKeysFor(raw, bookKey)).toEqual([]);
    await expect(db.get(entityKey)).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });
    await expect(db.get(bookKey)).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });
  });

  test('fails closed when an oversized typed Book page is corrupted', async () => {
    const raw = new MemoryRuntimeDb();
    const db = withRebranchedValues(raw);
    const bookKey = keyLiveBook(entityId, pairId);
    await applyPrepared(db, [{
      family: 'book',
      entityId,
      pairId,
      value: oversizedBook(),
    }], []);

    const pageKey = physicalKeysFor(raw, bookKey)[0];
    if (!pageKey) throw new Error('TEST_BOOK_PAGE_MISSING');
    raw.rows.get(pageKey)![0] ^= 0xff;

    await expect(db.get(bookKey)).rejects.toThrow('STORAGE_REBRANCH_');
  });

  test('survives snapshot and epoch copy, prunes old pages, and rejects snapshot corruption', async () => {
    const sourceRaw = new MemoryRuntimeDb();
    const historyRaw = new MemoryRuntimeDb();
    const epochRaw = new MemoryRuntimeDb();
    const source = withRebranchedValues(sourceRaw);
    const history = withRebranchedValues(historyRaw);
    const epoch = withRebranchedValues(epochRaw);
    const entity = entityDocWithEncodedSize(10_000);
    const account = oversizedAccount();
    const book = oversizedBook();
    const docs: StorageDoc[] = [
      { family: 'entity', entityId, value: entity },
      { family: 'account', entityId, counterpartyId, value: account },
      { family: 'book', entityId, pairId, value: book },
    ];

    await applyPrepared(source, docs, []);
    expect(physicalKeysFor(
      sourceRaw,
      keyLiveAccountField(
        entityId,
        counterpartyId,
        STORAGE_ACCOUNT_FIELD_TAG.hankoSignature,
      ),
    ).length).toBeGreaterThan(0);
    await putHead(source, storageHead(1, 0));
    await putHead(history, storageHead(1, 0));
    await createSnapshot(source, history, 1, 1_000);
    await putHead(history, storageHead(1, 1));
    const firstSnapshotAccountKey = snapshotAccountKey(1);
    const firstSnapshotBookKey = snapshotBookKey(1);
    expect(physicalKeysFor(historyRaw, firstSnapshotAccountKey).length).toBeGreaterThan(0);
    expect(physicalKeysFor(historyRaw, firstSnapshotBookKey).length).toBeGreaterThan(0);

    await putHead(source, storageHead(2, 1));
    await putHead(history, storageHead(2, 1));
    await createSnapshot(source, history, 2, 2_000);
    await putHead(history, storageHead(2, 2));
    await maybeRotateSnapshots(history, 1);
    expect(physicalKeysFor(historyRaw, firstSnapshotAccountKey)).toEqual([]);
    expect(physicalKeysFor(historyRaw, firstSnapshotBookKey)).toEqual([]);

    const restoredSnapshot = await readSnapshotDocs(history, 2);
    expect(restoredSnapshot).toHaveLength(3);
    expect(restoredSnapshot.find(doc => doc.family === 'entity')?.value).toEqual(entity);
    const snapshotAccount = restoredSnapshot.find(
      (doc): doc is Extract<StorageDoc, { family: 'account' }> => doc.family === 'account',
    );
    expect(snapshotAccount?.value.hankoSignature).toBe(account.hankoSignature);
    const snapshotBook = restoredSnapshot.find(
      (doc): doc is Extract<StorageDoc, { family: 'book' }> => doc.family === 'book',
    );
    expect(snapshotBook?.value.orders.size).toBe(book.orders.size);

    await putHead(source, storageHead(2, 2));
    const copied = await seedFreshStorageEpoch({
      sourceDb: source,
      targetDb: epoch,
      snapshotHeight: 2,
    });
    expect(copied.docCount).toBeGreaterThanOrEqual(2);
    expect(decodeValidatedBuffer(
      await epoch.get(keyLiveEntity(entityId)),
      validateStorageEntityCoreDocValue,
    )).toEqual(entity);
    expect((await readAccountStorageLayout(
      epoch,
      entityId,
      counterpartyId,
      keyLiveAccount(entityId, counterpartyId),
    ))?.doc.hankoSignature).toBe(account.hankoSignature);
    expect(decodeValidatedBuffer(
      await epoch.get(keyLiveBook(entityId, pairId)),
      validateStorageBookDocValue,
    ).orders.size).toBe(book.orders.size);
    expect(Math.max(...Array.from(epochRaw.rows.values(), value => value.byteLength)))
      .toBeLessThan(STORAGE_MAX_PHYSICAL_VALUE_BYTES);

    const latestSnapshotBookKey = snapshotBookKey(2);
    const pageKey = physicalKeysFor(historyRaw, latestSnapshotBookKey)[0];
    if (!pageKey) throw new Error('TEST_SNAPSHOT_BOOK_PAGE_MISSING');
    historyRaw.rows.get(pageKey)![0] ^= 0xff;
    await expect(readSnapshotDocs(history, 2)).rejects.toThrow('STORAGE_REBRANCH_');
  });
});
