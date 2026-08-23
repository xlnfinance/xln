import { expect, test } from 'bun:test';

import {
  clearBookCommitmentCache,
  computeBookCommitmentHash,
  verifyAndWarmBookCommitment,
} from '../../../orderbook/commitment';
import { applyCommand, createBook, type BookState } from '../../../orderbook/core';
import { commitBookOverlay } from '../../../orderbook/book-overlay';
import { getPerfMs } from '../../../support/time';
import { computeIntegrityChecksum, computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import {
  decodeBookPricePageTree,
  projectBookPricePageTree,
} from '../../../orderbook/pages/page';

const buildFatBook = (orderCount: number) => {
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: orderCount + 1, stpPolicy: 1 });
  for (let index = 0; index < orderCount; index += 1) {
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: `maker-${index}`,
      orderId: `order-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 1_000n + BigInt(index % 100),
      qtyLots: 1n,
    }).state);
  }
  return book;
};

const coldBookProjection = (book: BookState): BookState => ({
  ...book,
  orders: new Map([...book.orders].map(([key, order]) => [key, { ...order }])),
  bidPages: decodeBookPricePageTree(projectBookPricePageTree(book.bidPages), 'TEST_BIDS'),
  askPages: decodeBookPricePageTree(projectBookPricePageTree(book.askPages), 'TEST_ASKS'),
});

test('integrity checksum matches the portable SHA-256 golden prefix', () => {
  expect(computeIntegrityChecksum(new TextEncoder().encode('abc')))
    .toBe('0xba7816bf8f01cfea414140de5dae2223');
  expect(computeIntegrityDigest(new TextEncoder().encode('abc')))
    .toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('10k-order book rehashes only the dirty order ancestry', () => {
  let book = buildFatBook(10_000);

  const coldStartedAt = getPerfMs();
  const initialRoot = computeBookCommitmentHash(book);
  const coldMs = getPerfMs() - coldStartedAt;
  const untouchedPage = book.askPages.get({ priceTicks: 1_099n, pageSequence: 0 })!;
  const untouchedOrder = book.orders.get('order-9999')!;

  const cachedStartedAt = getPerfMs();
  for (let index = 0; index < 1_000; index += 1) {
    expect(computeBookCommitmentHash(book)).toBe(initialRoot);
  }
  const cachedReadsMs = getPerfMs() - cachedStartedAt;

  const previousBook = book;
  book = commitBookOverlay(applyCommand(book, {
    kind: 1,
    ownerId: 'maker-0',
    orderId: 'order-0',
  }).state);
  expect(previousBook.askPages.get({ priceTicks: 1_000n, pageSequence: 0 })?.slots[0]?.orderId)
    .toBe('order-0');
  expect(book.orders.has('order-0')).toBe(false);
  expect(book.askPages.get({ priceTicks: 1_099n, pageSequence: 0 })).toBe(untouchedPage);
  expect(book.orders.get('order-9999')).toBe(untouchedOrder);

  const incrementalStartedAt = getPerfMs();
  const incrementalRoot = computeBookCommitmentHash(book);
  const incrementalMs = getPerfMs() - incrementalStartedAt;
  expect(incrementalRoot).not.toBe(initialRoot);

  const coldClone = coldBookProjection(book);
  clearBookCommitmentCache(coldClone);
  const rebuiltRoot = computeBookCommitmentHash(coldClone);
  expect(rebuiltRoot).toBe(incrementalRoot);

  console.log(JSON.stringify({
    benchmark: 'orderbook-incremental-commitment',
    orders: 10_000,
    coldMs: Number(coldMs.toFixed(3)),
    cachedReadsMs: Number(cachedReadsMs.toFixed(3)),
    incrementalMs: Number(incrementalMs.toFixed(3)),
  }));
  expect(cachedReadsMs).toBeLessThan(5);
  expect(incrementalMs).toBeLessThan(2);
  expect(incrementalMs * 5).toBeLessThan(coldMs);
});

test('persisted book commitment is cold-verified before its cache is trusted', () => {
  const book = buildFatBook(100);
  computeBookCommitmentHash(book);
  book.commitmentHash = `0x${'ff'.repeat(16)}`;
  expect(() => verifyAndWarmBookCommitment(book, 'RESTORE_BOOK'))
    .toThrow('RESTORE_BOOK_MISMATCH');
});

test('incremental root equals a cold rebuild after every add, partial fill, full fill, and cancel', () => {
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: 200, stpPolicy: 1 });
  const assertColdParity = () => {
    const incremental = computeBookCommitmentHash(book);
    const cold = coldBookProjection(book);
    clearBookCommitmentCache(cold);
    expect(computeBookCommitmentHash(cold)).toBe(incremental);
  };

  for (let index = 0; index < 40; index += 1) {
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: `maker-${index}`,
      orderId: `maker-order-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 1_000n + BigInt(index % 4),
      qtyLots: 3n,
    }).state);
    assertColdParity();
  }

  book = commitBookOverlay(applyCommand(book, {
    kind: 0,
    ownerId: 'taker-partial',
    orderId: 'taker-partial',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 1_003n,
    qtyLots: 5n,
  }).state);
  assertColdParity();

  book = commitBookOverlay(applyCommand(book, {
    kind: 0,
    ownerId: 'taker-full',
    orderId: 'taker-full',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 1_003n,
    qtyLots: 7n,
  }).state);
  assertColdParity();

  book = commitBookOverlay(applyCommand(book, {
    kind: 1,
    ownerId: 'maker-10',
    orderId: 'maker-order-10',
  }).state);
  assertColdParity();
});
