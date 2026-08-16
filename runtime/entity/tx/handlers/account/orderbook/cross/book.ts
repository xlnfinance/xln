import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import {
  applyCommand,
  commitBookOverlay,
  crossJurisdictionBookQtyLots,
  getBookOrder,
  type BookOrderState,
  type BookState,
} from '../../../../../../orderbook';
import { isCrossJurisdictionRouteExpired } from '../../../../../../extensions/cross-j';
import { createStructuredLogger, shortOrder } from '../../../../../../infra/logger';
import {
  buildCrossMarketOfferFromBookOrder,
  parseNamespacedOrderId,
} from '../helpers';
import { findQueuedCrossSwapAckForEntityState } from '../queue';
import {
  assertPendingBookFillAckLive,
  committedCrossRouteStatus,
} from './pass';
import type { CrossOrderbookPass } from './types';

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
  const next = commitBookOverlay(applyCommand(book, {
    kind: 1,
    ownerId: order.ownerId,
    orderId,
  }).state);
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

export const classifyCrossBookMaker = (
  pass: CrossOrderbookPass,
  pairId: string,
  order: Readonly<BookOrderState>,
): 'eligible' | 'suspended' | 'cancel' => {
  const orderId = order.orderId;
  const { accountId, offerId } = parseNamespacedOrderId(
    orderId,
    'ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER',
  );
  const account = pass.hubState.accounts.get(accountId);
  // A remote admitted route is intentionally represented without a local
  // AccountReplica. Only a locally owned Account can enter dispute here.
  if (account && account.status !== 'active') {
    orderbookCrossLog.debug('book.remove_disputed_account', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      account: accountId.slice(-8),
    });
    return 'cancel';
  }
  const queuedAck = findQueuedCrossSwapAckForEntityState(
    pass.hubState,
    accountId,
    offerId,
  );
  const pendingBookAck = assertPendingBookFillAckLive(pass, accountId, offerId);
  const status = committedCrossRouteStatus(pass, accountId, offerId);
  if (status && !isWorkingCrossRouteStatus(status)) {
    orderbookCrossLog.debug('book.remove_non_working', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      status,
    });
    return 'cancel';
  }
  const meta =
    pass.crossLiveOfferMeta.get(orderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
  if (!meta) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_SNAPSHOT_MISSING", `ORDERBOOK_CROSS_J_SNAPSHOT_MISSING: pair=${pairId} order=${orderId} ` +
      `account=${accountId} offer=${offerId} pendingAck=${queuedAck ? 'yes' : 'no'}`);
  }
  pass.crossLiveOfferMeta.set(orderId, meta);
  if (isCrossJurisdictionRouteExpired(meta.route, Number(pass.hubState.timestamp || 0))) {
    orderbookCrossLog.debug('book.remove_expired_before_match', {
      pair: pairId,
      order: shortOrder(orderId, 20),
      expiresAt: meta.route.expiresAt,
      now: pass.hubState.timestamp,
    });
    return 'cancel';
  }
  if (pendingBookAck || queuedAck) {
    pass.suspendedOrderIds.add(orderId);
    return 'suspended';
  }
  const canonicalQty = crossBookQtyLots(meta.baseTokenId, meta.baseAmount);
  if (
    meta.pairId !== pairId ||
    order.priceTicks !== meta.priceTicks ||
    order.ownerId !== meta.makerId
  ) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_CACHE_MISMATCH", `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
      `storedPair=${pairId} canonicalPair=${meta.pairId} ` +
      `storedOwner=${order.ownerId} canonicalOwner=${meta.makerId} ` +
      `storedQty=${order.qtyLots.toString()} canonicalQty=${canonicalQty.toString()} ` +
      `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`);
  }
  if (order.qtyLots !== canonicalQty) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_CACHE_MISMATCH", `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
      `storedQty=${order.qtyLots.toString()} canonicalQty=${canonicalQty.toString()} ` +
      `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`);
  }
  return 'eligible';
};
