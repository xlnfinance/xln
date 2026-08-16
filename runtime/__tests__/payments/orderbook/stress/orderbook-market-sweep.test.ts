import { expect, test } from 'bun:test';

import {
  applyCommand,
  commitBookOverlay,
  computeBookCommitmentHash,
  createBook,
  forkBookState,
  getBestAsk,
  validateBookStructure,
} from '../../../../orderbook';
import { getPerfMs } from '../../../../infra/time';

test('one marketable order sweeps 1024 FIFO makers across prices and Patricia pages', () => {
  const orderCount = 1_024;
  const priceLevels = 32;
  const committed = createBook({ bucketWidthTicks: 1n, maxOrders: 2_048, stpPolicy: 1 });
  const frame = forkBookState(committed);
  const inserted: Array<{ orderId: string; priceTicks: bigint; seq: number }> = [];

  for (let index = 0; index < orderCount; index += 1) {
    const priceTicks = 1_000n + BigInt(index % priceLevels);
    const orderId = `maker-${index}`;
    const child = applyCommand(frame, {
      kind: 0,
      ownerId: orderId,
      orderId,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks,
      qtyLots: 1n,
    }).state;
    commitBookOverlay(child);
    inserted.push({ orderId, priceTicks, seq: index + 1 });
  }
  const book = commitBookOverlay(frame);
  const beforeRoot = computeBookCommitmentHash(book);
  const expected = inserted
    .sort((left, right) => left.priceTicks === right.priceTicks
      ? left.seq - right.seq
      : left.priceTicks < right.priceTicks ? -1 : 1)
    .map(entry => entry.orderId);

  const startedAt = getPerfMs();
  const result = applyCommand(book, {
    kind: 0,
    ownerId: 'market-taker',
    orderId: 'market-taker',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 1_031n,
    qtyLots: BigInt(orderCount),
  });
  const settled = commitBookOverlay(result.state);
  const elapsedMs = getPerfMs() - startedAt;
  const trades = result.events.filter(event => event.type === 'TRADE');

  expect(trades.map(event => event.makerOrderId)).toEqual(expected);
  expect(trades.reduce((sum, event) => sum + event.qty, 0n)).toBe(BigInt(orderCount));
  expect(settled.orders.size).toBe(0);
  expect(settled.askPages.size).toBe(0);
  expect(getBestAsk(settled)).toBeNull();
  expect(computeBookCommitmentHash(settled)).not.toBe(beforeRoot);
  expect(validateBookStructure(settled).ok).toBe(true);
  expect(elapsedMs).toBeLessThan(1_000);

  console.log(JSON.stringify({
    benchmark: 'orderbook-market-sweep',
    makers: orderCount,
    priceLevels,
    pages: priceLevels * 2,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    tradesPerSecond: Math.round(orderCount * 1_000 / elapsedMs),
  }));
});

test('bid traversal is highest-price FIFO without materializing the Patricia tree', () => {
  const count = 256;
  const frame = forkBookState(createBook({ bucketWidthTicks: 1n, maxOrders: 512, stpPolicy: 1 }));
  const expected: Array<{ orderId: string; price: bigint; seq: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const price = 2_000n + BigInt(index % 8);
    const orderId = `bid-${index}`;
    commitBookOverlay(applyCommand(frame, {
      kind: 0, ownerId: orderId, orderId, side: 0, tif: 0, postOnly: true,
      priceTicks: price, qtyLots: 1n,
    }).state);
    expected.push({ orderId, price, seq: index + 1 });
  }
  const book = commitBookOverlay(frame);
  const result = applyCommand(book, {
    kind: 0, ownerId: 'seller', orderId: 'seller', side: 1, tif: 1, postOnly: false,
    priceTicks: 2_000n, qtyLots: BigInt(count),
  });
  expect(result.events.filter(event => event.type === 'TRADE').map(event => event.makerOrderId)).toEqual(
    expected.sort((left, right) => left.price === right.price
      ? left.seq - right.seq
      : left.price > right.price ? -1 : 1).map(entry => entry.orderId),
  );
});

test('suspended cross-j makers are skipped lazily without changing price-time order', () => {
  const count = 1_024;
  const suspendedCount = 1_000;
  const frame = forkBookState(createBook({ bucketWidthTicks: 1n, maxOrders: 2_048, stpPolicy: 1 }));
  for (let index = 0; index < count; index += 1) {
    commitBookOverlay(applyCommand(frame, {
      kind: 0, ownerId: `maker-${index}`, orderId: `maker-${index}`,
      side: 1, tif: 0, postOnly: true, priceTicks: 3_000n + BigInt(index % 4), qtyLots: 1n,
    }).state);
  }
  const book = commitBookOverlay(frame);
  const suspendedOrderIds = new Set(
    Array.from({ length: suspendedCount }, (_, index) => `maker-${index}`),
  );
  const expected = Array.from(book.orders.values())
    .filter(order => !suspendedOrderIds.has(order.orderId))
    .sort((left, right) => left.priceTicks === right.priceTicks
      ? left.seq - right.seq
      : left.priceTicks < right.priceTicks ? -1 : 1)
    .map(order => order.orderId);
  const result = applyCommand(book, {
    kind: 0, ownerId: 'cross-taker', orderId: 'cross-taker', side: 0,
    tif: 1, postOnly: false, priceTicks: 3_003n, qtyLots: BigInt(expected.length),
  }, { suspendedOrderIds });
  expect(result.events.filter(event => event.type === 'TRADE').map(event => event.makerOrderId)).toEqual(expected);
  expect(book.orders.size).toBe(count);
});

test('lazy maker authority cancels only the consulted stale row and preserves the published book', () => {
  const frame = forkBookState(createBook({ bucketWidthTicks: 1n, maxOrders: 32, stpPolicy: 1 }));
  for (const orderId of ['stale-first', 'live-second', 'untouched-third']) {
    commitBookOverlay(applyCommand(frame, {
      kind: 0, ownerId: orderId, orderId, side: 1, tif: 0, postOnly: true,
      priceTicks: orderId === 'untouched-third' ? 2_001n : 2_000n,
      qtyLots: 1n,
    }).state);
  }
  const published = commitBookOverlay(frame);
  const consulted: string[] = [];
  const result = applyCommand(published, {
    kind: 0, ownerId: 'buyer', orderId: 'buyer', side: 0, tif: 1, postOnly: false,
    priceTicks: 2_000n, qtyLots: 1n,
  }, {
    makerDisposition: maker => {
      consulted.push(maker.orderId);
      return maker.orderId === 'stale-first' ? 'cancel' : 'eligible';
    },
  });
  const settled = commitBookOverlay(result.state);

  expect(consulted).toEqual(['stale-first', 'live-second']);
  expect(result.events.filter(event => event.type === 'TRADE').map(event => event.makerOrderId))
    .toEqual(['live-second']);
  expect(settled.orders.has('stale-first')).toBe(false);
  expect(settled.orders.has('untouched-third')).toBe(true);
  expect(published.orders.size).toBe(3);
  expect(validateBookStructure(settled).ok).toBe(true);
});
