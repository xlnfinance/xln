import type { BookState } from '../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../infra/logger';
import { HEAVY_LOGS } from '../../../../infra/debug-flags';
import {
  aggregateSameTradeFills,
  buildSameFillResolvePlan,
  collectTradeEvents,
  extractOfferIdForLog,
  parseNamespacedOrderId,
  rejectEventsForOrder,
} from './orderbook-matching-helpers';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
} from './orderbook-queue';
import type { SameOrderbookPass } from './orderbook-matching-same-pass';
import type { PreparedSameOffer } from './orderbook-matching-same-offer-types';

const orderbookSameLog = createStructuredLogger('orderbook.same');

const queueSameTradeFills = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
  book: BookState,
  trades: ReturnType<typeof collectTradeEvents>,
  resolveComment: string | undefined,
): void => {
  for (const event of trades) {
    orderbookSameLog.debug('trade', {
      maker: shortOrder(extractOfferIdForLog(event.makerOrderId)),
      taker: shortOrder(extractOfferIdForLog(event.takerOrderId)),
      price: event.price.toString(),
      qty: event.qty,
    });
  }
  for (const [namespacedOrderId, fill] of aggregateSameTradeFills(trades)) {
    const { accountId, offerId } = parseNamespacedOrderId(
      namespacedOrderId,
      'ORDERBOOK_FILL_LOOKUP_FAILED',
    );
    if (
      hasQueuedSwapResolveForEntityState(
        pass.hubState,
        pass.queuedSwapResolutions,
        accountId,
        offerId,
      )
    ) {
      continue;
    }
    if (HEAVY_LOGS) {
      orderbookSameLog.trace('lookup', {
        account: shortId(accountId, 8),
        known: [...pass.hubState.accounts.keys()].map(id => shortId(id, 8)),
        found: pass.hubState.accounts.has(accountId),
      });
    }
    const account = pass.hubState.accounts.get(accountId);
    if (!account) {
      throw new Error(
        `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId} ` +
        `known=[${[...pass.hubState.accounts.keys()].join(',')}]`,
      );
    }
    const plan = buildSameFillResolvePlan({
      accountId,
      offerId,
      namespacedOrderId,
      fill,
      currentNamespacedOrderId: offer.namespacedOrderId,
      currentOffer: offer.offer,
      batchOffer: pass.orderbookOfferMeta.get(namespacedOrderId) ?? null,
      accountOffer: account.state.swapOffers?.get(offerId) ?? null,
      book,
      bookKey: offer.bookKey,
      ...(resolveComment ? { resolveComment } : {}),
      takerFeeBps: pass.swapTakerFeeBps,
    });
    const queued = queueUniqueSwapResolveForEntityState(
      pass.accountTxs,
      pass.hubState,
      pass.queuedSwapResolutions,
      accountId,
      plan.resolveEnqueueData,
    );
    if (queued) {
      orderbookSameLog.debug('resolve.queued', {
        offer: shortOrder(offerId, 8),
        fillPct: plan.fillPct,
        cancel: plan.cancelRemainder,
        source: plan.offerSource,
      });
    }
  }
};

const rejectUnfilledOffer = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
  reasons: string,
  resolveComment: string | undefined,
): void => {
  const reason = `post-only-reject:${reasons || 'unknown'}`;
  orderbookSameLog.debug('offer.reject_post_only', {
    offer: shortOrder(offer.offer.offerId, 8),
    account: shortId(offer.accountId, 8),
    side: offer.side,
    price: offer.priceTicks.toString(),
    qty: offer.qtyLots.toString(),
    bestBid: String(offer.bestBid),
    bestAsk: String(offer.bestAsk),
    reason: reasons || 'unknown',
  });
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
      comment: resolveComment ?? reason,
    },
  );
  if (queued) {
    orderbookSameLog.debug('resolve.queued_cancel_reject', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
    });
  }
};

export const processSameCommandEvents = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
  result: {
    state: BookState;
    events: Parameters<typeof rejectEventsForOrder>[0];
  },
): void => {
  const rejects = rejectEventsForOrder(result.events, offer.namespacedOrderId);
  const trades = collectTradeEvents(result.events);
  const stpReject = rejects.find(event => event.reason === 'STP cancel taker');
  const resolveComment = stpReject
    ? `STP:${String(stpReject.blockingOrderId || '')}`
    : undefined;
  if (rejects.length > 0 && trades.length === 0) {
    const reasons = rejects.map(event => event.reason).filter(Boolean).join(', ');
    rejectUnfilledOffer(pass, offer, reasons, resolveComment);
    return;
  }
  if (!pass.debugRebuildProjectionOnly) {
    queueSameTradeFills(pass, offer, result.state, trades, resolveComment);
  }
};
