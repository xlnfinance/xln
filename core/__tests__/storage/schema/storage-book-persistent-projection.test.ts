import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { applyCommand, commitBookOverlay, createBook, reduceBookOrderQuantity } from '../../../orderbook';
import { hydrateBookPricePageTree } from '../../../orderbook/pages/page';
import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { prepareStorageBookGraphWrite } from '../../../storage/commit/book-graph';
import { readStorageBookGraph } from '../../../storage/read/book-graph';
import {
  branchRecordFromStorage,
  decodeStorageBookHeader,
  hydrateStorageBook,
  leafRecordFromStorage,
  projectStorageBookGraphChanges,
  projectStorageBookGraphRows,
  projectStorageBookHeader,
} from '../../../storage/schema/book-graph-codec';
import {
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  parseLiveBookBranchKey,
  parseLiveBookLeafKey,
} from '../../../storage/keys';

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('Book snapshot is the exact bounded Patricia graph and relinks without a flat Map', () => {
  const entityId = `0x${'11'.repeat(32)}`;
  const pairId = '1/2';
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  for (let index = 0; index < 40; index += 1) {
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: entityId,
      orderId: `ask-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 120n + BigInt(index % 2),
      qtyLots: 4n,
    }).state);
  }

  const header = decodeValidatedBuffer(
    encodeBuffer(projectStorageBookHeader(book)),
    decodeStorageBookHeader,
  );
  const bidRecords = [];
  const askRecords = [];
  for (const row of projectStorageBookGraphRows(entityId, pairId, book)) {
    expect(row.value.byteLength).toBeLessThan(10_000);
    if (row.key[0] === KEY_LIVE_BOOK_BRANCH) {
      const parsed = parseLiveBookBranchKey(row.key);
      const rawBranch = decodeValidatedBuffer(row.value, value => value);
      expect(rawBranch).not.toHaveProperty('hash');
      const record = branchRecordFromStorage(row.key, rawBranch);
      (parsed.side === 0 ? bidRecords : askRecords).push(record);
    } else if (row.key[0] === KEY_LIVE_BOOK_LEAF) {
      const parsed = parseLiveBookLeafKey(row.key);
      const record = leafRecordFromStorage(row.key, decodeValidatedBuffer(row.value, value => value));
      (parsed.side === 0 ? bidRecords : askRecords).push(record);
    } else throw new Error('TEST_BOOK_ROW_TAG_INVALID');
  }

  const restored = hydrateStorageBook(
    header,
    hydrateBookPricePageTree(bidRecords),
    hydrateBookPricePageTree(askRecords),
  );
  expect(restored.commitmentHash).toBe(book.commitmentHash);
  expect(restored.orders.size).toBe(40);
  expect(restored.orders.get('ask-39')?.qtyLots).toBe(4n);

  const next = commitBookOverlay(applyCommand(book, {
    kind: 2,
    ownerId: entityId,
    orderId: 'ask-17',
    newPriceTicks: null,
    qtyDeltaLots: -1n,
  }).state);
  const changes = projectStorageBookGraphChanges(entityId, pairId, next, book);
  expect(changes.puts.length).toBeLessThan(20);
  expect(changes.dels.length).toBeLessThan(20);
  const puts = new Set(changes.puts.map(row => row.key.toString('hex')));
  expect(changes.dels.every(key => !puts.has(key.toString('hex')))).toBe(true);
});

test('one Book update writes only dirty graph paths and survives reopen', async () => {
  const entityId = `0x${'22'.repeat(32)}`;
  const pairId = '1/2';
  const path = mkdtempSync(join(tmpdir(), 'xln-book-graph-'));
  paths.push(path);
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  book = commitBookOverlay(applyCommand(book, {
    kind: 0,
    ownerId: entityId,
    orderId: 'maker',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 120n,
    qtyLots: 4n,
  }).state);
  let db = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  const initial = await prepareStorageBookGraphWrite({ db, entityId, pairId, next: book });
  let batch = db.batch();
  for (const key of initial.dels) batch.del(key);
  for (const row of initial.puts) batch.put(row.key, row.value);
  await batch.write({ sync: true });
  await db.close();

  db = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();
  const restored = await readStorageBookGraph(db, entityId, pairId);
  expect(restored?.orders.get('maker')?.qtyLots).toBe(4n);
  const next = commitBookOverlay(reduceBookOrderQuantity(restored!, 'maker', 3n));
  const update = await prepareStorageBookGraphWrite({
    db,
    entityId,
    pairId,
    next,
    previous: restored!,
  });
  expect(update.puts.length + update.dels.length).toBeLessThan(20);
  batch = db.batch();
  for (const key of update.dels) batch.del(key);
  for (const row of update.puts) batch.put(row.key, row.value);
  await batch.write({ sync: true });
  const final = await readStorageBookGraph(db, entityId, pairId);
  expect(final?.orders.get('maker')?.qtyLots).toBe(3n);
  await db.close();
});
