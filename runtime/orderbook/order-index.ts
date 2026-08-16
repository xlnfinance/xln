import type { BookState } from './core';
import { BookBranchMap } from './book-overlay';
import type { OrderbookExtState } from './types';

const addPair = (
  index: Map<string, string[]>,
  orderId: string,
  pairId: string,
): void => {
  const existing = index.get(orderId);
  if (!existing) {
    index.set(orderId, [pairId]);
    return;
  }
  if (existing.includes(pairId)) return;
  index.set(orderId, [...existing, pairId].sort());
};

const removePair = (
  index: Map<string, string[]>,
  orderId: string,
  pairId: string,
): void => {
  const existing = index.get(orderId);
  if (!existing) return;
  const filtered = existing.filter(candidate => candidate !== pairId);
  if (filtered.length === 0) index.delete(orderId);
  else index.set(orderId, filtered);
};

const requireOrderPairIndex = (ext: OrderbookExtState): Map<string, string[]> => {
  if (!(ext.orderPairs instanceof Map)) {
    throw new Error('ORDERBOOK_PAIR_INDEX_MAP_REQUIRED');
  }
  return ext.orderPairs;
};

/** Cold recovery-only reconstruction. Production replacement is dirty-key only. */
export const rebuildOrderbookPairIndex = (
  ext: OrderbookExtState,
): Map<string, string[]> => {
  const next = new Map<string, string[]>();
  for (const [pairId, book] of ext.books) {
    for (const orderId of book.orders.keys()) addPair(next, orderId, pairId);
  }
  ext.orderPairs = next;
  return next;
};

export const replaceOrderbookPair = (
  ext: OrderbookExtState,
  pairId: string,
  book: BookState,
): void => {
  const index = requireOrderPairIndex(ext);
  const previous = ext.books.get(pairId);
  if (!previous) {
    ext.books.set(pairId, book);
    for (const orderId of book.orders.keys()) addPair(index, orderId, pairId);
    return;
  }
  if (!(book.orders instanceof BookBranchMap)) {
    if (book !== previous) throw new Error('ORDERBOOK_PAIR_DIRTY_DELTA_REQUIRED');
    return;
  }
  for (const orderId of book.orders.deletedKeys()) removePair(index, orderId, pairId);
  for (const [orderId] of book.orders.changedEntries()) {
    // The frame may publish the same active Book overlay more than once. Its
    // own base view already sees earlier additions, so comparing against
    // `previous` can hide a newly indexed order. addPair is idempotent.
    addPair(index, orderId, pairId);
  }
  ext.books.set(pairId, book);
};

export const getOrderbookPairsForOrder = (
  ext: OrderbookExtState,
  orderId: string,
): string[] => {
  const index = requireOrderPairIndex(ext);
  const indexedPairs = index.get(orderId) ?? [];
  // Read paths include MM health checks outside the Entity transition. Never
  // let a getter repair replica state; writes and cold recovery own the index.
  return indexedPairs.filter(pairId => ext.books.get(pairId)?.orders.has(orderId));
};
