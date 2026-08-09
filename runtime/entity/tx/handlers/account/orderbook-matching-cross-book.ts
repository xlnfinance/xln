import {
  applyCommand,
  crossJurisdictionBookQtyLots,
  getBookOrder,
  type BookState,
} from '../../../../orderbook';
import { isCrossJurisdictionRouteExpired } from '../../../../extensions/cross-j';
import { createStructuredLogger, shortOrder } from '../../../../infra/logger';
import {
  buildCrossMarketOfferFromBookOrder,
  parseNamespacedOrderId,
} from './orderbook-matching-helpers';
import { findQueuedCrossSwapAckForEntityState } from './orderbook-queue';
import {
  assertPendingBookFillAckLive,
  committedCrossRouteStatus,
} from './orderbook-matching-cross-pass';
import type { CrossOrderbookPass } from './orderbook-matching-cross-types';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

export const crossBookQtyLots = crossJurisdictionBookQtyLots;

const isWorkingCrossRouteStatus = (status: string | undefined): boolean =>
  status === 'resting' || status === 'partially_filled';

const removeCrossBookOrder = (
  pass: CrossOrderbookPass,
  pairId: string,
  book: BookState,
  orderId: string,
): BookState => {
  const order = getBookOrder(book, orderId);
  if (!order) return book;
  const next = applyCommand(book, {
    kind: 1,
    ownerId: order.ownerId,
    orderId,
  }).state;
  pass.bookCache.set(pairId, next);
  pass.bookUpdates.push({ pairId, book: next });
  return next;
};

export const removeCrossBookOrderAfterFill = (
  pass: CrossOrderbookPass,
  pairId: string,
  orderId: string,
  reason: string,
): void => {
  const book = pass.bookCache.get(pairId) ?? pass.ext.books.get(pairId);
  if (!book || !getBookOrder(book, orderId)) return;
  removeCrossBookOrder(pass, pairId, book, orderId);
  orderbookCrossLog.debug('book.remove_resolving', {
    pair: pairId,
    order: shortOrder(orderId, 20),
    reason,
  });
};

const validateCrossBookOrder = (
  pass: CrossOrderbookPass,
  pairId: string,
  book: BookState,
  orderId: string,
): BookState => {
  const order = getBookOrder(book, orderId);
  if (!order) return book;
  const { accountId, offerId } = parseNamespacedOrderId(
    orderId,
    'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER',
  );
  const account = pass.hubState.accounts.get(accountId);
  if ((account?.status ?? 'active') !== 'active') {
    const next = removeCrossBookOrder(pass, pairId, book, orderId);
    orderbookCrossLog.debug('book.remove_disputed_account', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      account: accountId.slice(-8),
    });
    return next;
  }
  const queuedAck = findQueuedCrossSwapAckForEntityState(
    pass.hubState,
    accountId,
    offerId,
  );
  const pendingBookAck = assertPendingBookFillAckLive(pass, accountId, offerId);
  const status = committedCrossRouteStatus(pass, accountId, offerId);
  if (status && !isWorkingCrossRouteStatus(status)) {
    const next = removeCrossBookOrder(pass, pairId, book, orderId);
    orderbookCrossLog.debug('book.remove_non_working', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      status,
    });
    return next;
  }
  const meta =
    pass.crossLiveOfferMeta.get(orderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
  if (!meta) {
    throw new Error(
      `ORDERBOOK_CROSS_J_SNAPSHOT_MISSING: pair=${pairId} order=${orderId} ` +
      `account=${accountId} offer=${offerId} pendingAck=${queuedAck ? 'yes' : 'no'}`,
    );
  }
  pass.crossLiveOfferMeta.set(orderId, meta);
  if (isCrossJurisdictionRouteExpired(meta.route, Number(pass.hubState.timestamp || 0))) {
    const next = removeCrossBookOrder(pass, pairId, book, orderId);
    orderbookCrossLog.debug('book.remove_expired_before_match', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      expiresAt: meta.route.expiresAt,
      now: pass.hubState.timestamp,
    });
    return next;
  }
  if (pendingBookAck || queuedAck) {
    pass.suspendedOrderIds.add(orderId);
    return book;
  }
  const canonicalQty = crossBookQtyLots(meta.baseTokenId, meta.baseAmount);
  if (
    meta.pairId !== pairId ||
    order.priceTicks !== meta.priceTicks ||
    order.ownerId !== meta.makerId
  ) {
    throw new Error(
      `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
      `storedPair=${pairId} canonicalPair=${meta.pairId} ` +
      `storedOwner=${order.ownerId} canonicalOwner=${meta.makerId} ` +
      `storedQty=${order.qtyLots.toString()} canonicalQty=${canonicalQty.toString()} ` +
      `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
    );
  }
  if (order.qtyLots !== canonicalQty) {
    throw new Error(
      `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
      `storedQty=${order.qtyLots.toString()} canonicalQty=${canonicalQty.toString()} ` +
      `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
    );
  }
  return book;
};

export const assertCrossBookMatchesCommittedOffers = (
  pass: CrossOrderbookPass,
  pairId: string,
  initialBook: BookState,
): BookState => {
  if (pass.assertedPairs.has(pairId)) return initialBook;
  pass.assertedPairs.add(pairId);
  let book = initialBook;
  for (const order of [...initialBook.orders.values()]) {
    book = validateCrossBookOrder(pass, pairId, book, order.orderId);
  }
  return book;
};

export const primeCommittedCrossBooks = (pass: CrossOrderbookPass): void => {
  for (const [pairId, sourceBook] of pass.ext.books) {
    if (!String(pairId).startsWith('cross:')) continue;
    const book = pass.bookCache.get(pairId) ?? sourceBook;
    pass.bookCache.set(
      pairId,
      assertCrossBookMatchesCommittedOffers(pass, pairId, book),
    );
  }
};
