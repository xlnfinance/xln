import { expect, test } from 'bun:test';

import { encodeBuffer } from '../../../../storage/codec/codec';
import {
  appendBookPricePageOrder,
  BOOK_PRICE_PAGE_CAPACITY,
  createBookPricePageTree,
  decodeBookPricePage,
  getBestBookPricePage,
  reduceBookPricePageOrder,
  removeBookPricePageOrder,
} from '../../../../orderbook/pages/page';
import { MAX_BOOK_PRICE_PAGE_SEQUENCE } from '../../../../orderbook/pages/key';

test('price pages preserve price order and FIFO page order without storing price in value', () => {
  let tree = createBookPricePageTree();
  const locations = [];
  for (let index = 0; index < BOOK_PRICE_PAGE_CAPACITY + 1; index += 1) {
    const appended = appendBookPricePageOrder(tree, 25_000n, {
      orderId: `account:offer-${index}`,
      ownerId: 'maker',
      qtyLots: 1n,
      seq: index + 1,
    });
    tree = appended.tree;
    locations.push(appended.location);
  }
  tree = appendBookPricePageOrder(tree, 24_000n, { orderId: 'lower', ownerId: 'maker', qtyLots: 2n, seq: 100 }).tree;
  expect(locations[0]).toEqual({ key: { priceTicks: 25_000n, pageSequence: 0 }, slot: 0 });
  expect(locations.at(-1)).toEqual({ key: { priceTicks: 25_000n, pageSequence: 1 }, slot: 0 });
  expect(getBestBookPricePage(tree, 'lowest')?.[0]).toEqual({ priceTicks: 24_000n, pageSequence: 0 });
  expect(getBestBookPricePage(tree, 'highest')?.[0]).toEqual({ priceTicks: 25_000n, pageSequence: 0 });
  expect('priceTicks' in (tree.get({ priceTicks: 25_000n, pageSequence: 0 }) ?? {})).toBe(false);
});

test('empty exact-price level resets uint16 page sequence to zero', () => {
  let tree = createBookPricePageTree();
  const appended = appendBookPricePageOrder(tree, 7n, { orderId: 'first', ownerId: 'maker', qtyLots: 3n, seq: 1 });
  tree = removeBookPricePageOrder(appended.tree, appended.location, 'first');
  const restarted = appendBookPricePageOrder(tree, 7n, { orderId: 'second', ownerId: 'maker', qtyLots: 4n, seq: 2 });
  expect(restarted.location).toEqual({ key: { priceTicks: 7n, pageSequence: 0 }, slot: 0 });
});

test('a non-empty price keeps its live tail page instead of resurrecting page zero', () => {
  let tree = createBookPricePageTree();
  const locations = [];
  for (let index = 0; index < BOOK_PRICE_PAGE_CAPACITY + 1; index += 1) {
    const appended = appendBookPricePageOrder(tree, 8n, {
      orderId: `order-${index}`, ownerId: 'maker', qtyLots: 1n, seq: index + 1,
    });
    tree = appended.tree;
    locations.push(appended.location);
  }
  for (let index = 0; index < BOOK_PRICE_PAGE_CAPACITY; index += 1) {
    tree = removeBookPricePageOrder(tree, locations[index]!, `order-${index}`);
  }
  const appended = appendBookPricePageOrder(tree, 8n, {
    orderId: 'tail', ownerId: 'maker', qtyLots: 1n, seq: 99,
  });
  expect(appended.location).toEqual({ key: { priceTicks: 8n, pageSequence: 1 }, slot: 1 });
});

test('uint16 page exhaustion rejects loudly without mutating the tree', () => {
  const slots = Array.from({ length: BOOK_PRICE_PAGE_CAPACITY }, (_, index) => ({
    orderId: `order-${index}`, ownerId: 'maker', qtyLots: 1n, seq: index + 1,
  }));
  const tree = createBookPricePageTree().updated(
    { priceTicks: 9n, pageSequence: MAX_BOOK_PRICE_PAGE_SEQUENCE },
    {
      headSlot: 0,
      nextSlot: BOOK_PRICE_PAGE_CAPACITY,
      liveCount: BOOK_PRICE_PAGE_CAPACITY,
      totalQtyLots: BigInt(BOOK_PRICE_PAGE_CAPACITY),
      slots,
    },
  );
  const root = tree.rootHash();
  expect(() => appendBookPricePageOrder(tree, 9n, {
    orderId: 'overflow', ownerId: 'maker', qtyLots: 1n, seq: 99,
  })).toThrow('BOOK_PAGE_SEQUENCE_EXHAUSTED');
  expect(tree.rootHash()).toBe(root);
});

test('canonical page capacity stays comfortably below the 10KB record invariant', () => {
  const accountId = `0x${'f'.repeat(64)}`;
  let tree = createBookPricePageTree();
  for (let index = 0; index < BOOK_PRICE_PAGE_CAPACITY; index += 1) {
    const suffix = String(index);
    const offerId = `${'o'.repeat(256 - suffix.length)}${suffix}`;
    tree = appendBookPricePageOrder(tree, 1n, {
      orderId: `${accountId}:${offerId}`,
      ownerId: accountId,
      qtyLots: 10n ** 24n,
      seq: index + 1,
    }).tree;
  }
  const page = tree.get({ priceTicks: 1n, pageSequence: 0 });
  expect(page).toBeDefined();
  expect(encodeBuffer(page).byteLength).toBeLessThan(10_000);
  expect(encodeBuffer(page).byteLength).toBe(6_731);
});

test('partial fill updates one page without changing FIFO location', () => {
  const appended = appendBookPricePageOrder(createBookPricePageTree(), 5n, {
    orderId: 'order', ownerId: 'maker', qtyLots: 10n, seq: 1,
  });
  const reduced = reduceBookPricePageOrder(appended.tree, appended.location, 'order', 4n);
  const page = reduced.get(appended.location.key);
  expect(page?.slots[appended.location.slot]?.qtyLots).toBe(4n);
  expect(page?.totalQtyLots).toBe(4n);
  expect(page?.headSlot).toBe(0);
});

test('page entry rejects UTF-8 identifiers that could violate the record bound', () => {
  const tree = createBookPricePageTree();
  expect(() => appendBookPricePageOrder(tree, 1n, {
    orderId: '💥'.repeat(100),
    ownerId: 'maker',
    qtyLots: 1n,
    seq: 1,
  })).toThrow('BOOK_PAGE_ORDER_ID_BYTES_INVALID:400');
  expect(() => appendBookPricePageOrder(tree, 1n, {
    orderId: 'order',
    ownerId: 'x'.repeat(67),
    qtyLots: 1n,
    seq: 1,
  })).toThrow('BOOK_PAGE_OWNER_ID_BYTES_INVALID:67');
});

test('page disk/network decoder rejects drift and inconsistent aggregates', () => {
  const slots = Array(BOOK_PRICE_PAGE_CAPACITY).fill(null);
  slots[0] = { orderId: 'order', ownerId: 'maker', qtyLots: 1n, seq: 1 };
  const valid = { headSlot: 0, nextSlot: 1, liveCount: 1, totalQtyLots: 1n, slots };
  expect(decodeBookPricePage(valid)).toEqual(valid);
  expect(() => decodeBookPricePage({ ...valid, extra: true })).toThrow('BOOK_PAGE_FIELDS');
  expect(() => decodeBookPricePage({ ...valid, totalQtyLots: 2n }))
    .toThrow('BOOK_PAGE_AGGREGATE_INVALID');
});
