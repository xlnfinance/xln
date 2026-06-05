import type { EntityState } from '../../../types';
import {
  applyCommand,
  getBookOrder,
  getOrderbookPairsForOrder,
  type BookState,
  type OrderbookExtState,
} from '../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../logger';
import {
  buildCrossJurisdictionCancelAck,
  markCrossJurisdictionBookAdmissionClosed,
  type CrossJurisdictionFillInstruction,
} from '../../../cross-jurisdiction-orderbook';
import {
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import type {
  MatchResult,
  SwapCancelRequestEvent,
} from './orderbook-offers';

const orderbookLog = createStructuredLogger('orderbook');

/**
 * Apply hub-decided orderbook cancels and enqueue the account-level settlement.
 * This mutates only the orderbook extension and returns account mempool ops for
 * the entity orchestrator to commit through the normal account frame path.
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelRequestEvent[],
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const debugProjectionRejects: MatchResult['debugProjectionRejects'] = [];
  const queuedSwapResolutions = new Set<string>();
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };

  for (const { offerId, accountId } of cancels) {
    const accountMachine = hubState.accounts.get(accountId);
    const hasOffer = Boolean(accountMachine?.swapOffers?.has(offerId));
    if (!hasOffer) continue;

    const namespacedOrderId = `${accountId}:${offerId}`;
    let orderbookCancelled = false;
    const matchingBooks: Array<{ bookKey: string; book: BookState; ownerId: string }> = [];

    for (const bookKey of getOrderbookPairsForOrder(ext, namespacedOrderId)) {
      const book = ext.books.get(bookKey);
      if (!book) continue;
      const existingOrder = getBookOrder(book, namespacedOrderId);
      if (!existingOrder) continue;
      matchingBooks.push({ bookKey, book, ownerId: existingOrder.ownerId });
    }

    if (matchingBooks.length > 1) {
      throw new Error(
        `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matchingBooks.length}`,
      );
    }

    for (const { bookKey, book, ownerId } of matchingBooks) {
      const result = applyCommand(book, {
        kind: 1,
        ownerId,
        orderId: namespacedOrderId,
      });

      bookUpdates.push({ pairId: bookKey, book: result.state });
      orderbookLog.debug('order.cancelled', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8), pair: bookKey });
      orderbookCancelled = true;
    }

    const offer = accountMachine?.swapOffers?.get(offerId);
    if (offer?.crossJurisdiction) {
      markCrossJurisdictionBookAdmissionClosed(
        hubState,
        offer.crossJurisdiction.source.entityId,
        offerId,
        Number(hubState.timestamp || 0),
        'cancel_request',
      );
      mempoolOps.push({ accountId, tx: buildCrossJurisdictionCancelAck(offerId, offer.crossJurisdiction) });
      orderbookLog.debug('crossj.cancel_ack_queued', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      continue;
    }

    if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, {
      offerId,
      fillRatio: 0,
      cancelRemainder: true,
    })) {
      if (!orderbookCancelled) {
        orderbookLog.debug('resolve.queued_cancel_missing_book_order', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      } else {
        orderbookLog.debug('resolve.queued_cancel', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      }
    }
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
