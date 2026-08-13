import { applyCommand, OrderbookCapacityError } from '../../../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../../infra/logger';
import { queueUniqueSwapResolveForEntityState } from '../queue';
import {
  containSamePairFailure,
  type SameOrderbookPass,
} from './pass';
import type { PreparedSameOffer } from './offer-types';

const orderbookSameLog = createStructuredLogger('orderbook.same');

const rejectFullBook = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): void => {
  orderbookSameLog.debug('book.full', {
    pair: offer.bookKey,
    maxOrders: offer.book.params.maxOrders,
    offer: shortOrder(offer.offer.offerId, 8),
    account: shortId(offer.accountId, 8),
  });
  const reason = `book-full:${offer.book.params.maxOrders}`;
  if (pass.debugRebuildProjectionOnly) {
    pass.recordDebugProjectionReject(offer.accountId, offer.offer.offerId, reason);
    return;
  }
  const queued = queueUniqueSwapResolveForEntityState(
    pass.accountTxs,
    pass.hubState,
    pass.queuedSwapResolutions,
    offer.accountId,
    {
      offerId: offer.offer.offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: reason,
    },
  );
  if (queued) {
    orderbookSameLog.debug('resolve.queued_cancel_full_book', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
    });
  }
};

export const applySameOfferCommand = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): ReturnType<typeof applyCommand> | null => {
  orderbookSameLog.debug('order.add', {
    maker: shortId(offer.makerId),
    order: shortOrder(offer.namespacedOrderId, 20),
    side: offer.side,
    price: offer.priceTicks.toString(),
    qty: offer.qtyLots.toString(),
  });
  try {
    const result = applyCommand(
      // applyCommand intentionally mutates its BookState hot cache. Matching a
      // user-authorized fee must therefore run on a detached preview: the
      // original cache cannot move until every paired Account resolve passes.
      structuredClone(offer.book),
      {
        kind: 0,
        ownerId: offer.makerId,
        orderId: offer.namespacedOrderId,
        side: offer.side,
        tif: offer.offer.timeInForce,
        postOnly: pass.debugRebuildProjectionOnly,
        priceTicks: offer.priceTicks,
        qtyLots: offer.qtyLots,
      },
      { suspendedOrderIds: pass.suspendedSameOrderIds },
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof OrderbookCapacityError) {
      rejectFullBook(pass, offer);
    } else {
      containSamePairFailure(
        pass,
        offer.bookKey,
        offer.accountId,
        offer.offer.offerId,
        message,
      );
    }
    return null;
  }
};
