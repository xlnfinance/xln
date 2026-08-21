import { describe, expect, test } from 'bun:test';

import { applyCommand, commitBookOverlay, createBook } from '../../../../orderbook';
import { projectPortableBook, decodePortableBook } from '../../../../storage/schema/book/portable';
import { safeParse, safeStringify } from '../../../../protocol/serialization';

describe('portable recovery book codec', () => {
  const entityId = `0x${'11'.repeat(32)}`;
  const pairId = '1/2';

  test('round-trips Patricia pages without serializing private fields or locator duplicates', () => {
    let book = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: entityId,
      orderId: 'portable-bid',
      side: 0,
      tif: 0,
      postOnly: true,
      priceTicks: 25_000_000n,
      qtyLots: 10_000_000n,
    }).state);
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: `0x${'22'.repeat(32)}`,
      orderId: 'portable-ask',
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 25_000_001n,
      qtyLots: 20_000_000n,
    }).state);

    const projected = projectPortableBook(entityId, pairId, book);
    expect(Object.keys(projected)).toEqual(['header', 'rows']);
    expect(safeStringify(projected)).not.toContain('orders');

    const restored = decodePortableBook(
      safeParse(safeStringify(projected)),
      entityId,
      pairId,
      'TEST_BOOK',
    );
    expect(restored.commitmentHash).toBe(book.commitmentHash);
    expect(restored.bidPages.rootHash()).toBe(book.bidPages.rootHash());
    expect(restored.askPages.rootHash()).toBe(book.askPages.rootHash());
    expect(restored.orders.get('portable-bid')?.qtyLots).toBe(10_000_000n);
    expect(restored.orders.get('portable-ask')?.qtyLots).toBe(20_000_000n);
  });

  test('rejects a corrupted page root instead of accepting a partial book', () => {
    const projected = projectPortableBook(entityId, pairId, createBook({
      bucketWidthTicks: 10n,
      maxOrders: 100,
      stpPolicy: 1,
    }));
    const corrupt = {
      ...projected,
      header: { ...(projected['header'] as Record<string, unknown>), bidRootHash: `0x${'11'.repeat(32)}` },
    };
    expect(() => decodePortableBook(corrupt, entityId, pairId, 'TEST_BOOK'))
      .toThrow('STORAGE_BOOK_BID_ROOT_MISMATCH');
  });
});
