import { describe, expect, test } from 'bun:test';

import { applyCommand, computeBookHash, createBook, getBookOrder, getBookOrders } from '../../../orderbook/core';
import { commitBookOverlay } from '../../../orderbook/book-overlay';

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
      { kind: 0 as const, ownerId: 'maker-a', orderId: 'ask-1', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 110n, qtyLots: 25n },
      { kind: 0 as const, ownerId: 'maker-b', orderId: 'ask-2', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 112n, qtyLots: 20n },
      { kind: 0 as const, ownerId: 'maker-c', orderId: 'bid-1', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 90n, qtyLots: 15n },
      { kind: 0 as const, ownerId: 'maker-d', orderId: 'bid-2', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 88n, qtyLots: 10n },
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
      qtyLots: 25n,
    });
    book = fill.state;

    expect(fill.events.some((event) => event.type === 'TRADE' && event.makerOrderId === 'ask-1')).toBe(true);
    expect(book.lastTradePriceTicks).toBe(110n);
    expect(getBookOrder(book, 'ask-1')).toBeNull();
    expect(activeOrderIds(book)).toEqual(['bid-1', 'bid-2']);
    expect(book.orders.size).toBe(2);

    for (const command of [
      { kind: 0 as const, ownerId: 'maker-e', orderId: 'ask-3', side: 1 as const, tif: 0 as const, postOnly: false, priceTicks: 115n, qtyLots: 12n },
      { kind: 0 as const, ownerId: 'maker-f', orderId: 'bid-3', side: 0 as const, tif: 0 as const, postOnly: false, priceTicks: 87n, qtyLots: 11n },
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
      qtyLots: 10n,
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

  test('FOK partial preview rolls back every maker fill and locator change', () => {
    const seeded = commitBookOverlay(applyCommand(createBook({
      bucketWidthTicks: 1n, maxOrders: 16, stpPolicy: 0,
    }), {
      kind: 0, ownerId: 'maker', orderId: 'ask', side: 1,
      tif: 0, postOnly: true, priceTicks: 100n, qtyLots: 5n,
    }).state);
    const before = computeBookHash(seeded);
    const result = applyCommand(seeded, {
      kind: 0, ownerId: 'taker', orderId: 'fok', side: 0,
      tif: 2, postOnly: false, priceTicks: 100n, qtyLots: 10n,
    });
    expect(result.events).toEqual([{
      type: 'REJECT', orderId: 'fok', ownerId: 'taker', reason: 'FOK cannot fill entirely',
    }]);
    expect(computeBookHash(seeded)).toBe(before);
    expect(getBookOrder(seeded, 'ask')?.qtyLots).toBe(5n);
    expect(getBookOrder(result.state, 'ask')?.qtyLots).toBe(5n);
  });

  test('published order locators cannot diverge from canonical price pages', () => {
    let book = createBook({
      bucketWidthTicks: 100n,
      maxOrders: 16,
      stpPolicy: 0,
    });

    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: 'maker-a',
      orderId: 'ask-stale',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 110n,
      qtyLots: 5n,
    }).state);

    const staleOrder = book.orders.get('ask-stale');
    expect(staleOrder).not.toBeUndefined();
    if (!staleOrder) throw new Error('expected stale order to exist');
    expect(Object.isFrozen(staleOrder)).toBe(true);
    expect(() => Object.assign(staleOrder, { qtyLots: 0n })).toThrow();
    expect(getBookOrder(book, 'ask-stale')?.qtyLots).toBe(5n);
    expect(activeOrderIds(book)).toEqual(['ask-stale']);
  });
});
