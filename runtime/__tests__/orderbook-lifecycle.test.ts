import { describe, expect, test } from 'bun:test';

import { applyCommand, createBook } from '../orderbook/core';

const activeOrderIds = (book: ReturnType<typeof createBook>): string[] => {
  const result: string[] = [];
  for (let index = 0; index < book.orderActive.length; index += 1) {
    if (!book.orderActive[index]) continue;
    result.push(String(book.orderIds[index]));
  }
  return result.sort();
};

describe('orderbook lifecycle cleanup', () => {
  test('cancel, replace, and full fill remove stale orders and reuse slots safely', () => {
    let book = createBook({
      tick: 1n,
      pmin: 1n,
      pmax: 1000n,
      maxOrders: 16,
      stpPolicy: 0,
    });

    for (const command of [
      { kind: 0 as const, ownerId: 'maker-a', orderId: 'ask-1', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 110n, qtyLots: 25 },
      { kind: 0 as const, ownerId: 'maker-b', orderId: 'ask-2', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 112n, qtyLots: 20 },
      { kind: 0 as const, ownerId: 'maker-c', orderId: 'bid-1', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 90n, qtyLots: 15 },
      { kind: 0 as const, ownerId: 'maker-d', orderId: 'bid-2', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 88n, qtyLots: 10 },
    ]) {
      book = applyCommand(book, command).state;
    }

    const initialActive = activeOrderIds(book);
    expect(initialActive).toEqual(['ask-1', 'ask-2', 'bid-1', 'bid-2']);
    expect(book.orderIdToIdx.size).toBe(4);

    const cancel = applyCommand(book, {
      kind: 1,
      ownerId: 'maker-b',
      orderId: 'ask-2',
    });
    book = cancel.state;
    expect(cancel.events.some((event) => event.type === 'CANCELED' && event.orderId === 'ask-2')).toBe(true);
    expect(book.orderIdToIdx.has('ask-2')).toBe(false);
    expect(activeOrderIds(book)).toEqual(['ask-1', 'bid-1', 'bid-2']);

    const replace = applyCommand(book, {
      kind: 2,
      ownerId: 'maker-d',
      orderId: 'bid-2',
      newPriceTicks: 89n,
      qtyDeltaLots: 5,
    });
    book = replace.state;
    expect(book.orderIdToIdx.has('bid-2')).toBe(true);
    expect(activeOrderIds(book)).toEqual(['ask-1', 'bid-1', 'bid-2']);

    const fill = applyCommand(book, {
      kind: 0,
      ownerId: 'taker-x',
      orderId: 'buy-1',
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 120n,
      qtyLots: 25,
    });
    book = fill.state;

    expect(fill.events.some((event) => event.type === 'TRADE' && event.makerOrderId === 'ask-1')).toBe(true);
    expect(book.orderIdToIdx.has('ask-1')).toBe(false);
    expect(activeOrderIds(book)).toEqual(['bid-1', 'bid-2']);
    expect(book.orderIdToIdx.size).toBe(2);

    for (const command of [
      { kind: 0 as const, ownerId: 'maker-e', orderId: 'ask-3', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 115n, qtyLots: 12 },
      { kind: 0 as const, ownerId: 'maker-f', orderId: 'bid-3', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 87n, qtyLots: 11 },
    ]) {
      book = applyCommand(book, command).state;
    }

    expect(activeOrderIds(book)).toEqual(['ask-3', 'bid-1', 'bid-2', 'bid-3']);
    expect(book.orderIdToIdx.has('ask-1')).toBe(false);
    expect(book.orderIdToIdx.has('ask-2')).toBe(false);
    expect(book.orderIdToIdx.has('bid-1')).toBe(true);
    expect(book.orderIdToIdx.has('bid-2')).toBe(true);
    expect(book.orderIdToIdx.has('ask-3')).toBe(true);
    expect(book.orderIdToIdx.has('bid-3')).toBe(true);

    const activeCount = Array.from(book.orderActive).reduce((sum, flag) => sum + Number(flag > 0), 0);
    expect(activeCount).toBe(book.orderIdToIdx.size);
    expect(book.freeHead).toBeGreaterThanOrEqual(0);
  });

  test('replace rejects off-grid and out-of-range prices', () => {
    let book = createBook({
      tick: 5n,
      pmin: 100n,
      pmax: 200n,
      maxOrders: 16,
      stpPolicy: 0,
    });

    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-a',
      orderId: 'bid-1',
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 120n,
      qtyLots: 10,
    }).state;

    const offGridReplace = applyCommand(book, {
      kind: 2,
      ownerId: 'maker-a',
      orderId: 'bid-1',
      newPriceTicks: 123n,
      qtyDeltaLots: 0,
    });
    expect(offGridReplace.events).toContainEqual({
      type: 'REJECT',
      orderId: 'bid-1',
      ownerId: 'maker-a',
      reason: 'new price off grid',
    });

    const outOfRangeReplace = applyCommand(book, {
      kind: 2,
      ownerId: 'maker-a',
      orderId: 'bid-1',
      newPriceTicks: 205n,
      qtyDeltaLots: 0,
    });
    expect(outOfRangeReplace.events).toContainEqual({
      type: 'REJECT',
      orderId: 'bid-1',
      ownerId: 'maker-a',
      reason: 'new price out of range',
    });
  });
});
