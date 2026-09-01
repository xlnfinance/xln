import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { recordAcceptedUsdAskPrice, type BookState } from '../../../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../../support/logger';
import { HEAVY_LOGS } from '../../../../../../support/debug-flags';
import {
  aggregateSameTradeFills,
  buildSameFillResolvePlan,
  collectTradeEvents,
  extractOfferIdForLog,
  parseNamespacedOrderId,
  rejectEventsForOrder,
} from '../helpers';
import {
  hasQueuedSwapResolveForEntityState,
} from '../queue';
import { queueSameSwapResolve, recordZeroFillCancel, type SameOrderbookPass } from './pass';
import type { PreparedSameOffer } from './offer-types';
import { normalizeEntityRef } from '../../../../account-key';

const orderbookSameLog = createStructuredLogger('orderbook.same');

export const isAuthorizedUsdReferenceAsk = (
  profile: Pick<SameOrderbookPass['ext']['hubProfile'], 'referenceTokenId' | 'usdQuoteAuthorityEntityId'>,
  offer: {
    side: 0 | 1;
    makerId: string;
    offer: { giveTokenId: number; wantTokenId: number };
  },
): boolean =>
  offer.side === 1 &&
  offer.offer.giveTokenId !== profile.referenceTokenId &&
  offer.offer.wantTokenId === profile.referenceTokenId &&
  normalizeEntityRef(offer.makerId) === normalizeEntityRef(profile.usdQuoteAuthorityEntityId);

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
  const plans = [];
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
      throw haltRuntimeFailure(
        'ORDERBOOK_TRADE_PARTICIPANT_ALREADY_RESOLVING',
        `ORDERBOOK_TRADE_PARTICIPANT_ALREADY_RESOLVING: account=${accountId} offer=${offerId}`,
      );
    }
    if (HEAVY_LOGS) {
      orderbookSameLog.trace('lookup', {
        account: shortId(accountId, 8),
        found: pass.hubState.accounts.has(accountId),
      });
    }
    const account = pass.hubState.accounts.get(accountId);
    if (!account) {
      throw haltRuntimeFailure("ORDERBOOK_ACCOUNT_LOOKUP_FAILED", `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId}`);
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
    plans.push(plan);
  }
  // Build and authorize every paired Account resolution before queuing any of
  // them. A taker fee rejection must discard the preview atomically; otherwise
  // the maker Account could move while the taker Account rejects its half.
  for (const plan of plans) {
    const queued = queueSameSwapResolve(
      pass,
      plan.accountId,
      plan.resolveEnqueueData,
    );
    if (queued) {
      orderbookSameLog.debug('resolve.queued', {
        offer: shortOrder(plan.offerId, 8),
        fillPct: plan.fillPct,
        cancel: plan.cancelRemainder,
        source: plan.offerSource,
      });
    }
  }
};

export const rejectFeeUnauthorizedOffer = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): void => rejectUnfilledOffer(pass, offer, 'fee-authorization-exceeded', 'fee-authorization-exceeded');

const rejectUnfilledOffer = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
  reasons: string,
  resolveComment: string | undefined,
): void => {
  const reason = `post-only-reject:${reasons || 'unknown'}`;
  // The single funnel for "a committed offer left the book with a zero fill",
  // self-trade prevention included. Each of those is a legitimate market
  // outcome, so the pass counts them by reason and reports one summary.
  recordZeroFillCancel(pass, reasons || 'unknown');
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
  const queued = queueSameSwapResolve(
    pass,
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
    const profile = pass.ext.hubProfile;
    if (isAuthorizedUsdReferenceAsk(profile, offer)) {
      // The accepted command and price reference commit in the same Entity
      // frame. User/cross quotes and trades never enter this branch, so a tiny
      // wash trade cannot move the $6.5m cross-j risk boundary.
      result.state = recordAcceptedUsdAskPrice(result.state, offer.priceTicks);
    }
    queueSameTradeFills(pass, offer, result.state, trades, resolveComment);
  }
};
