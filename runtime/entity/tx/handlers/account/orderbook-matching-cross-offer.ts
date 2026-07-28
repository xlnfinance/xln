import { applyCommand } from '../../../../orderbook';
import { createStructuredLogger, shortOrder } from '../../../../infra/logger';
import { resolveCrossJurisdictionExecutionPriceTicks } from '../../../../extensions/cross-j/orderbook';
import {
  aggregateCrossTradeFills,
  buildCrossMarketOfferFromBookOrder,
  collectTradeEvents,
  parseNamespacedOrderId,
  rejectEventsForOrder,
} from './orderbook-matching-helpers';
import { hasQueuedCrossSwapAckForEntityState } from './orderbook-queue';
import { prepareCrossOrderbookOffer } from './orderbook-matching-cross-admission';
import { getWorkingCrossBook } from './orderbook-matching-cross-pass';
import type {
  CrossOrderbookPass,
  PreparedCrossOffer,
} from './orderbook-matching-cross-types';
import type { CrossJurisdictionWorkingOrderbookOffer } from '../../../../orderbook/swap-execution';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

const applySpeculativeCrossCommand = (
  pass: CrossOrderbookPass,
  offer: PreparedCrossOffer,
): ReturnType<typeof applyCommand> | null => {
  try {
    return applyCommand(
      getWorkingCrossBook(pass, offer.marketOffer.pairId, offer.committedBook),
      {
        kind: 0,
        ownerId: offer.marketOffer.makerId,
        orderId: offer.namespacedOrderId,
        side: offer.marketOffer.side,
        tif: offer.rawOffer.timeInForce,
        postOnly: pass.debugRebuildProjectionOnly,
        priceTicks: offer.marketOffer.priceTicks,
        qtyLots: offer.qtyLots,
      },
      { suspendedOrderIds: pass.suspendedOrderIds },
    );
  } catch (error) {
    pass.rejectInvalidCrossOffer(
      offer.accountId,
      offer.rawOffer.offerId,
      `cross-pair-error:${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const canonicalCrossTradeEvents = (
  pass: CrossOrderbookPass,
  events: ReturnType<typeof collectTradeEvents>,
): ReturnType<typeof collectTradeEvents> => events.map(event => {
  const maker =
    pass.crossLiveOfferMeta.get(event.makerOrderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, event.makerOrderId);
  const taker =
    pass.crossLiveOfferMeta.get(event.takerOrderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, event.takerOrderId);
  if (!maker || !taker) {
    throw new Error(
      `ORDERBOOK_CROSS_J_TRADE_META_MISSING:` +
      `maker=${event.makerOrderId}:taker=${event.takerOrderId}`,
    );
  }
  pass.crossLiveOfferMeta.set(event.makerOrderId, maker);
  pass.crossLiveOfferMeta.set(event.takerOrderId, taker);
  return {
    ...event,
    price: resolveCrossJurisdictionExecutionPriceTicks(maker, taker),
  };
});

const commitRestingCrossOffer = (
  pass: CrossOrderbookPass,
  offer: PreparedCrossOffer,
): void => {
  const result = applyCommand(
    offer.committedBook,
    {
      kind: 0,
      ownerId: offer.marketOffer.makerId,
      orderId: offer.namespacedOrderId,
      side: offer.marketOffer.side,
      tif: offer.rawOffer.timeInForce,
      postOnly: pass.debugRebuildProjectionOnly,
      priceTicks: offer.marketOffer.priceTicks,
      qtyLots: offer.qtyLots,
    },
    { suspendedOrderIds: pass.suspendedOrderIds },
  );
  if (collectTradeEvents(result.events).length > 0) {
    throw new Error(
      `ORDERBOOK_CROSS_J_COMMITTED_WRITE_TRADED: order=${offer.namespacedOrderId}`,
    );
  }
  pass.bookCache.set(offer.marketOffer.pairId, result.state);
  pass.bookUpdates.push({ pairId: offer.marketOffer.pairId, book: result.state });
};

const aggregateCrossTrades = (
  pass: CrossOrderbookPass,
  trades: ReturnType<typeof collectTradeEvents>,
): void => {
  for (const event of trades) {
    orderbookCrossLog.debug('trade', {
      maker: shortOrder(event.makerOrderId, 20),
      taker: shortOrder(event.takerOrderId, 20),
      qty: event.qty,
      price: event.price.toString(),
    });
    // Each matched route now has an Account/hash-ledger ACK in flight.
    pass.suspendedOrderIds.add(event.makerOrderId);
    pass.suspendedOrderIds.add(event.takerOrderId);
  }
  for (const [orderId, fill] of aggregateCrossTradeFills(trades)) {
    const meta =
      pass.crossLiveOfferMeta.get(orderId) ??
      buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
    if (!meta) {
      throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${orderId}`);
    }
    const { accountId, offerId } = parseNamespacedOrderId(
      orderId,
      'ORDERBOOK_CROSS_J_MALFORMED_FILL_ORDER',
    );
    if (
      hasQueuedCrossSwapAckForEntityState(
        pass.hubState,
        accountId,
        offerId,
      )
    ) {
      continue;
    }
    const current = pass.aggregatedFills.get(orderId);
    if (current) {
      current.filledLots += fill.filledLots;
      current.weightedCost += fill.weightedCost;
    } else {
      pass.aggregatedFills.set(orderId, {
        filledLots: fill.filledLots,
        weightedCost: fill.weightedCost,
      });
    }
  }
};

export const processCrossOrderbookOffer = (
  pass: CrossOrderbookPass,
  rawOffer: CrossJurisdictionWorkingOrderbookOffer,
): void => {
  const offer = prepareCrossOrderbookOffer(pass, rawOffer);
  if (!offer) return;
  const result = applySpeculativeCrossCommand(pass, offer);
  if (!result) return;
  const rejects = rejectEventsForOrder(result.events, offer.namespacedOrderId);
  const trades = canonicalCrossTradeEvents(pass, collectTradeEvents(result.events));
  if (rejects.length > 0 && trades.length === 0) {
    pass.rejectInvalidCrossOffer(
      offer.accountId,
      rawOffer.offerId,
      `cross-post-only-reject:${rejects.map(event => event.reason).join(',')}`,
    );
    return;
  }
  if (pass.debugRebuildProjectionOnly) {
    if (trades.length > 0) {
      pass.recordDebugProjectionReject(
        offer.accountId,
        rawOffer.offerId,
        `debug-rebuild-cross-trade:${trades.length}`,
      );
    }
    return;
  }
  if (
    trades.length === 0 &&
    !pass.speculativeTradePairs.has(offer.marketOffer.pairId)
  ) {
    commitRestingCrossOffer(pass, offer);
  }
  if (trades.length > 0) {
    pass.speculativeTradePairs.add(offer.marketOffer.pairId);
  }
  aggregateCrossTrades(pass, trades);
};
