import { describe, expect, test } from 'bun:test';

import { applyCommand, createBook, getBookOrder, getBookOrders } from '../orderbook/core';

const activeOrderIds = (book: ReturnType<typeof createBook>): string[] =>
  getBookOrders(book).map((order) => order.orderId).sort();

describe('orderbook lifecycle cleanup', () => {
  test('cancel and full fill remove stale orders cleanly', () => {
    let book = createBook({
      bucketWidthTicks: 100n,
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

    expect(activeOrderIds(book)).toEqual(['ask-1', 'ask-2', 'bid-1', 'bid-2']);
    expect(book.orders.size).toBe(4);

    const cancel = applyCommand(book, {
      kind: 1,
      ownerId: 'maker-b',
      orderId: 'ask-2',
    });
    book = cancel.state;
    expect(cancel.events.some((event) => event.type === 'CANCELED' && event.orderId === 'ask-2')).toBe(true);
    expect(getBookOrder(book, 'ask-2')).toBeNull();
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
    expect(getBookOrder(book, 'ask-1')).toBeNull();
    expect(activeOrderIds(book)).toEqual(['bid-1', 'bid-2']);
    expect(book.orders.size).toBe(2);

    for (const command of [
      { kind: 0 as const, ownerId: 'maker-e', orderId: 'ask-3', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 115n, qtyLots: 12 },
      { kind: 0 as const, ownerId: 'maker-f', orderId: 'bid-3', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 87n, qtyLots: 11 },
    ]) {
      book = applyCommand(book, command).state;
    }

    expect(activeOrderIds(book)).toEqual(['ask-3', 'bid-1', 'bid-2', 'bid-3']);
    expect(getBookOrder(book, 'ask-1')).toBeNull();
    expect(getBookOrder(book, 'ask-2')).toBeNull();
    expect(getBookOrder(book, 'bid-1')).not.toBeNull();
    expect(getBookOrder(book, 'bid-2')).not.toBeNull();
    expect(getBookOrder(book, 'ask-3')).not.toBeNull();
    expect(getBookOrder(book, 'bid-3')).not.toBeNull();
  });

  test('replace is explicitly unsupported', () => {
    let book = createBook({
      bucketWidthTicks: 100n,
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

    const replace = applyCommand(book, {
      kind: 2,
      ownerId: 'maker-a',
      orderId: 'bid-1',
      newPriceTicks: 123n,
      qtyDeltaLots: 0,
    });
    expect(replace.events).toContainEqual({
      type: 'REJECT',
      orderId: 'bid-1',
      ownerId: 'maker-a',
      reason: 'replace unsupported',
    });
  });

  test('stale top-of-book cleanup also evicts orphaned order map entries', () => {
    let book = createBook({
      bucketWidthTicks: 100n,
      maxOrders: 16,
      stpPolicy: 0,
    });

    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-a',
      orderId: 'ask-stale',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 110n,
      qtyLots: 5,
    }).state;

    const staleOrder = book.orders.get('ask-stale');
    expect(staleOrder).not.toBeUndefined();
    if (!staleOrder) throw new Error('expected stale order to exist');
    staleOrder.qtyLots = 0;

    const result = applyCommand(book, {
      kind: 0,
      ownerId: 'taker-a',
      orderId: 'buy-cleanup',
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 120n,
      qtyLots: 1,
    });

    book = result.state;

    expect(getBookOrder(book, 'ask-stale')).toBeNull();
    expect(book.orders.has('ask-stale')).toBe(false);
    expect(activeOrderIds(book)).toEqual(['buy-cleanup']);
  });
});
