import { expect, test } from 'bun:test';

import {
  applyCommand,
  commitBookOverlay,
  computeBookCommitmentHash,
  createBook,
  createOrderbookExtState,
  forkBookState,
  getBookOrder,
  getOrderbookPairsForOrder,
  isBookOverlay,
  replaceOrderbookPair,
  type BookState,
  type OrderCmd,
} from '../../../orderbook';
import {
  decodeBookPricePageTree,
  projectBookPricePageTree,
} from '../../../orderbook/pages/page';

const hubProfile = {
  entityId: `0x${'11'.repeat(32)}`,
  name: 'Overlay Hub',
  spreadDistribution: {
    makerBps: 0,
    takerBps: 10_000,
    hubBps: 0,
    makerReferrerBps: 0,
    takerReferrerBps: 0,
  },
  referenceTokenId: 1,
  usdQuoteAuthorityEntityId: `0x${'22'.repeat(32)}`,
  minTradeSize: 0n,
  supportedPairs: ['1/2'],
};

const accept = (book: BookState, command: OrderCmd): BookState =>
  commitBookOverlay(applyCommand(book, command).state);

test('command overlay copies only dirty book branches and reject can drop it', () => {
  let committed = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  committed = accept(committed, {
    kind: 0,
    ownerId: 'maker-a',
    orderId: 'ask-a',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 100n,
    qtyLots: 5n,
  });
  committed = accept(committed, {
    kind: 0,
    ownerId: 'maker-b',
    orderId: 'ask-b',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 200n,
    qtyLots: 7n,
  });
  const committedRoot = computeBookCommitmentHash(committed);
  const untouchedPage = committed.askPages.get({ priceTicks: 200n, pageSequence: 0 });

  const preview = applyCommand(committed, {
    kind: 0,
    ownerId: 'taker',
    orderId: 'bid-a',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 100n,
    qtyLots: 3n,
  });

  expect(isBookOverlay(preview.state)).toBe(true);
  expect(getBookOrder(committed, 'ask-a')?.qtyLots).toBe(5n);
  expect(committed.tradeCount).toBe(0);
  expect(computeBookCommitmentHash(committed)).toBe(committedRoot);
  expect(preview.state.askPages.get({ priceTicks: 200n, pageSequence: 0 })).toBe(untouchedPage);
  expect(preview.state.askPages.get({ priceTicks: 100n, pageSequence: 0 }))
    .not.toBe(committed.askPages.get({ priceTicks: 100n, pageSequence: 0 }));

  // Dropping preview is the fee/auth rejection path: the committed parent did
  // not move and no compensating clone or rollback is needed.
  const accepted = commitBookOverlay(preview.state);
  expect(accepted).not.toBe(committed);
  expect(committed.askPages.get({ priceTicks: 100n, pageSequence: 0 })?.slots[0]?.qtyLots).toBe(5n);
  expect(committed.tradeCount).toBe(0);
  expect(getBookOrder(accepted, 'ask-a')?.qtyLots).toBe(2n);
  expect(accepted.tradeCount).toBe(1);
  expect(accepted.askPages.get({ priceTicks: 200n, pageSequence: 0 })).toBe(untouchedPage);
  expect(computeBookCommitmentHash(accepted)).not.toBe(committedRoot);
  expect(computeBookCommitmentHash(committed)).toBe(committedRoot);
});

test('a sealed command overlay cannot be certified twice', () => {
  const base = createBook({ bucketWidthTicks: 1n, maxOrders: 16, stpPolicy: 0 });
  const child = applyCommand(base, {
    kind: 0, ownerId: 'maker', orderId: 'ask-once', side: 1,
    tif: 0, postOnly: true, priceTicks: 100n, qtyLots: 1n,
  }).state;
  commitBookOverlay(child);
  expect(() => commitBookOverlay(child)).toThrow('BOOK_OVERLAY_REQUIRED');
});

test('overlay preserves exact price-time events and cold commitment parity', () => {
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  book = accept(book, {
    kind: 0,
    ownerId: 'older',
    orderId: 'ask-1',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 100n,
    qtyLots: 2n,
  });
  book = accept(book, {
    kind: 0,
    ownerId: 'newer',
    orderId: 'ask-2',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 100n,
    qtyLots: 2n,
  });
  const result = applyCommand(book, {
    kind: 0,
    ownerId: 'buyer',
    orderId: 'bid',
    side: 0,
    tif: 1,
    postOnly: false,
    priceTicks: 100n,
    qtyLots: 3n,
  });
  expect(result.events.filter(event => event.type === 'TRADE').map(event => event.makerOrderId))
    .toEqual(['ask-1', 'ask-2']);
  const accepted = commitBookOverlay(result.state);
  expect(getBookOrder(accepted, 'ask-1')).toBeNull();
  expect(getBookOrder(accepted, 'ask-2')?.qtyLots).toBe(1n);
  const incremental = computeBookCommitmentHash(accepted);
  const cold = {
    ...accepted,
    orders: new Map([...accepted.orders].map(([key, order]) => [key, { ...order }])),
    bidPages: decodeBookPricePageTree(projectBookPricePageTree(accepted.bidPages), 'TEST_BIDS'),
    askPages: decodeBookPricePageTree(projectBookPricePageTree(accepted.askPages), 'TEST_ASKS'),
  };
  delete cold.commitmentHash;
  expect(computeBookCommitmentHash(cold)).toBe(incremental);
});

test('command merges into frame overlay before the finalized book publishes', () => {
  const committed = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  const frame = forkBookState(committed);
  const command = applyCommand(frame, {
    kind: 0,
    ownerId: 'maker',
    orderId: 'ask',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 120n,
    qtyLots: 4n,
  });

  expect(committed.orders.size).toBe(0);
  expect(frame.orders.size).toBe(0);
  expect(commitBookOverlay(command.state)).toBe(frame);
  expect(frame.orders.size).toBe(1);
  expect(frame.askPages.size).toBe(1);
  expect(committed.orders.size).toBe(0);
  const published = commitBookOverlay(frame);
  expect(published).not.toBe(committed);
  // Certification path-copies both canonical pages and the derived locator;
  // an observer retaining the old Book cannot see the candidate publication.
  expect(committed.askPages.size).toBe(0);
  expect(committed.orders.size).toBe(0);
  expect(published.orders.size).toBe(1);
  expect(published.askPages.size).toBe(1);
});

test('pair replacement updates only dirty order ids without iterating the full book', () => {
  let committed = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  committed = accept(committed, {
    kind: 0,
    ownerId: 'maker',
    orderId: 'ask',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 120n,
    qtyLots: 4n,
  });
  const ext = createOrderbookExtState(hubProfile);
  replaceOrderbookPair(ext, '1/2', committed);
  Object.defineProperty(committed.orders, Symbol.iterator, {
    value: () => {
      throw new Error('TEST_FULL_BOOK_ITERATION_FORBIDDEN');
    },
  });

  const cancelled = applyCommand(committed, {
    kind: 1,
    ownerId: 'maker',
    orderId: 'ask',
  }).state;
  expect(() => replaceOrderbookPair(ext, '1/2', cancelled)).not.toThrow();
  expect(ext.orderPairs.has('ask')).toBe(false);
});

test('pair lookup filters stale entries without mutating replica state', () => {
  const ext = createOrderbookExtState(hubProfile);
  ext.orderPairs.set('stale', ['1/2']);
  expect(getOrderbookPairsForOrder(ext, 'stale')).toEqual([]);
  expect(ext.orderPairs.get('stale')).toEqual(['1/2']);
});

test('one empty-pair frame accepts repeated rests and indexes every order', () => {
  const committed = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  const frame = forkBookState(committed);
  const ext = createOrderbookExtState(hubProfile);

  for (const orderId of ['ask-a', 'ask-b']) {
    const child = applyCommand(frame, {
      kind: 0,
      ownerId: orderId,
      orderId,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 120n,
      qtyLots: 1n,
    }).state;
    expect(commitBookOverlay(child)).toBe(frame);
    replaceOrderbookPair(ext, '1/2', frame);
  }

  expect(ext.orderPairs.get('ask-a')).toEqual(['1/2']);
  expect(ext.orderPairs.get('ask-b')).toEqual(['1/2']);
  const published = commitBookOverlay(frame);
  expect([...published.orders.keys()]).toEqual(['ask-a', 'ask-b']);
  expect(Object.keys(published).sort()).toEqual([
    'askPages', 'bidPages',
    'eventHash', 'lastAcceptedUsdAskPriceTicks', 'lastTradePriceTicks',
    'nextSeq', 'orders', 'params', 'tradeCount', 'tradeQtySum',
  ]);
});

test('published orderbook leaves cannot mutate behind their committed root', () => {
  let book = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
  book = accept(book, {
    kind: 0,
    ownerId: 'maker',
    orderId: 'ask',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 120n,
    qtyLots: 4n,
  });
  const root = computeBookCommitmentHash(book);
  const order = book.orders.get('ask')!;
  const page = book.askPages.get({ priceTicks: 120n, pageSequence: 0 })!;
  const entry = page.slots[0]!;

  expect(Object.isFrozen(order)).toBe(true);
  expect(Object.isFrozen(page)).toBe(true);
  expect(Object.isFrozen(page.slots)).toBe(true);
  expect(Object.isFrozen(entry)).toBe(true);
  expect(page.liveCount).toBe(1);
  expect(entry.orderId).toBe('ask');
  expect(() => Object.assign(order, { qtyLots: 99n })).toThrow();
  expect(computeBookCommitmentHash(book)).toBe(root);
  expect(book.orders.get('ask')?.qtyLots).toBe(4n);
});

test('frame overlay accumulates commands and materializes one persistent root at publish', () => {
  const committed = createBook({ bucketWidthTicks: 10n, maxOrders: 1_001, stpPolicy: 1 });
  const frame = forkBookState(committed);
  for (let index = 0; index < 1_000; index += 1) {
    const child = applyCommand(frame, {
      kind: 0,
      ownerId: `maker-${index}`,
      orderId: `order-${index}`,
      side: 1,
      tif: 0,
      postOnly: true,
      priceTicks: 1_000n + BigInt(index),
      qtyLots: 1n,
    }).state;
    expect(commitBookOverlay(child)).toBe(frame);
  }
  expect(committed.orders.size).toBe(0);
  const published = commitBookOverlay(frame);
  expect(published.orders.size).toBe(1_000);
  expect(computeBookCommitmentHash(published)).not.toBe(computeBookCommitmentHash(committed));
});
