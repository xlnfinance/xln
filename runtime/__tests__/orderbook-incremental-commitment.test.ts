import { expect, test } from 'bun:test';

import {
  clearBookCommitmentCache,
  computeBookCommitmentHash,
  verifyAndWarmBookCommitment,
} from '../orderbook/commitment';
import { applyCommand, createBook } from '../orderbook/core';
import { getPerfMs } from '../utils';
import { computeIntegrityChecksum, computeIntegrityDigest } from '../infra/integrity-checksum';

const buildFatBook = (orderCount: number) => {
  const book = createBook({ bucketWidthTicks: 10n, maxOrders: orderCount + 1, stpPolicy: 1 });
  for (let index = 0; index < orderCount; index += 1) {
    applyCommand(book, {
      kind: 0,
      ownerId: `maker-${index}`,
      orderId: `order-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 1_000n + BigInt(index % 100),
      qtyLots: 1n,
    });
  }
  return book;
};

test('integrity checksum matches the portable SHA-256 golden prefix', () => {
  expect(computeIntegrityChecksum(new TextEncoder().encode('abc')))
    .toBe('0xba7816bf8f01cfea414140de5dae2223');
  expect(computeIntegrityDigest(new TextEncoder().encode('abc')))
    .toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('10k-order book rehashes only the dirty order ancestry', () => {
  const book = buildFatBook(10_000);

  const coldStartedAt = getPerfMs();
  const initialRoot = computeBookCommitmentHash(book);
  const coldMs = getPerfMs() - coldStartedAt;
  const targetBucket = book.askBuckets.get('100')!;
  const untouchedBucket = book.askBuckets.get('109')!;
  const untouchedBucketHash = untouchedBucket.commitmentHash;
  const untouchedLevelHash = untouchedBucket.levels.get('1099')!.commitmentHash;
  const untouchedOrderHash = book.orders.get('order-9999')!.commitmentHash;

  const cachedStartedAt = getPerfMs();
  for (let index = 0; index < 1_000; index += 1) {
    expect(computeBookCommitmentHash(book)).toBe(initialRoot);
  }
  const cachedReadsMs = getPerfMs() - cachedStartedAt;

  applyCommand(book, { kind: 1, ownerId: 'maker-0', orderId: 'order-0' });
  expect(book.commitmentHash).toBeUndefined();
  expect(targetBucket.commitmentHash).toBeUndefined();
  expect(untouchedBucket.commitmentHash).toBe(untouchedBucketHash);
  expect(untouchedBucket.levels.get('1099')!.commitmentHash).toBe(untouchedLevelHash);
  expect(book.orders.get('order-9999')!.commitmentHash).toBe(untouchedOrderHash);

  const incrementalStartedAt = getPerfMs();
  const incrementalRoot = computeBookCommitmentHash(book);
  const incrementalMs = getPerfMs() - incrementalStartedAt;
  expect(incrementalRoot).not.toBe(initialRoot);

  const coldClone = structuredClone(book);
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
  const book = createBook({ bucketWidthTicks: 10n, maxOrders: 200, stpPolicy: 1 });
  const assertColdParity = () => {
    const incremental = computeBookCommitmentHash(book);
    const cold = structuredClone(book);
    clearBookCommitmentCache(cold);
    expect(computeBookCommitmentHash(cold)).toBe(incremental);
  };

  for (let index = 0; index < 40; index += 1) {
    applyCommand(book, {
      kind: 0,
      ownerId: `maker-${index}`,
      orderId: `maker-order-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 1_000n + BigInt(index % 4),
      qtyLots: 3n,
    });
    assertColdParity();
  }

  applyCommand(book, {
    kind: 0,
    ownerId: 'taker-partial',
    orderId: 'taker-partial',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 1_003n,
    qtyLots: 5n,
  });
  assertColdParity();

  applyCommand(book, {
    kind: 0,
    ownerId: 'taker-full',
    orderId: 'taker-full',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 1_003n,
    qtyLots: 7n,
  });
  assertColdParity();

  applyCommand(book, { kind: 1, ownerId: 'maker-10', orderId: 'maker-order-10' });
  assertColdParity();
});
