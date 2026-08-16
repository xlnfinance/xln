import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { forkBookState, type BookState } from '../../../../../../orderbook';
import { createStructuredLogger } from '../../../../../../infra/logger';
import {
  buildCrossJurisdictionMarketOffer,
  crossJurisdictionBookAdmissionKeyFor,
  type CrossMarketOffer,
} from '../../../../../../extensions/cross-j/orderbook';
import { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../../../../../extensions/cross-j/fill-ack';
import { swapKey, type CrossJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import type {
  CrossOrderbookPass,
  CrossOrderbookProcessInput,
} from './types';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

export const createCrossOrderbookPass = (
  input: CrossOrderbookProcessInput,
): CrossOrderbookPass => ({
  ...input,
  crossLiveOfferMeta: new Map(),
  aggregatedFills: new Map(),
  suspendedOrderIds: new Set(),
  workingBookCache: new Map(),
  speculativeTradePairs: new Set(),
});

export const getCrossMarketOffer = (
  pass: CrossOrderbookPass,
  offer: CrossJurisdictionWorkingOrderbookOffer,
): CrossMarketOffer | null => {
  const key = swapKey(offer.accountId, offer.offerId);
  const cached = pass.crossLiveOfferMeta.get(key);
  if (cached) return cached;
  const marketOffer = buildCrossJurisdictionMarketOffer(
    offer,
    pass.hubState.entityId,
  );
  if (marketOffer) pass.crossLiveOfferMeta.set(key, marketOffer);
  return marketOffer;
};

export const getCrossAdmission = (
  pass: CrossOrderbookPass,
  accountId: string,
  offerId: string,
) => pass.hubState.crossJurisdictionBookAdmissions?.get(
  crossJurisdictionBookAdmissionKeyFor(accountId, offerId),
);

export const getWorkingCrossBook = (
  pass: CrossOrderbookPass,
  pairId: string,
  committedBook: BookState,
): BookState => {
  const cached = pass.workingBookCache.get(pairId);
  if (cached) return cached;
  const working = forkBookState(committedBook);
  pass.workingBookCache.set(pairId, working);
  return working;
};

export const assertPendingBookFillAckLive = (
  pass: CrossOrderbookPass,
  accountId: string,
  offerId: string,
): boolean => {
  const admission = getCrossAdmission(pass, accountId, offerId);
  const pendingFill = admission?.pendingFill;
  if (!pendingFill) return false;
  const now = Number(pass.hubState.timestamp || 0);
  const updatedAt = Number(pendingFill.updatedAt || admission.updatedAt || 0);
  const ageMs = Math.max(0, now - updatedAt);
  if (
    ageMs <= CROSS_J_PENDING_FILL_ACK_TTL_MS ||
    pendingFill.ttlExpiredAt !== undefined
  ) {
    return true;
  }
  const routeHash = admission.routeHash || admission.route?.routeHash || '';
  pendingFill.ttlExpiredAt = now;
  admission.updatedAt = now || admission.updatedAt;
  if (!pass.candidateEffects) {
    throw haltRuntimeFailure("CROSS_J_BOOK_FILL_TTL_EFFECT_COLLECTOR_REQUIRED", 'CROSS_J_BOOK_FILL_TTL_EFFECT_COLLECTOR_REQUIRED');
  }
  pass.candidateEffects.push({
    kind: 'securityIncidentRecord',
    identity: {
      domain: 'cross-j',
      code: 'CROSS_J_BOOK_FILL_TTL_EXPIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary:
        'Book-owner fill is still waiting for its exact terminal sibling acknowledgement',
      entityId: pass.hubState.entityId,
      accountId,
      offerId,
      routeHash,
    },
  });
  orderbookCrossLog.warn('pending_fill_ack_ttl_expired_preserved', {
    entityId: pass.hubState.entityId,
    accountId,
    offerId,
    routeHash,
    bookOwnerEntityId: admission.bookOwnerEntityId,
    sourceEntityId: admission.sourceEntityId,
    pendingFill,
    ageMs,
    ttlMs: CROSS_J_PENDING_FILL_ACK_TTL_MS,
    repairProtocol: {
      classification: 'unexpected_book_owner_pending_fill_without_terminal_ack',
      preserveEvidence: true,
      operatorAction:
        'Inspect the book-owner admission, source fill notice delivery, source route progress, ' +
        'and pending account frames before replaying or terminally voiding this order.',
      forbiddenAction:
        'Do not clear pendingFill silently; the committed book mutation and exact fill payload ' +
        'must remain available for repair.',
    },
  });
  return true;
};

export const committedCrossRouteStatus = (
  pass: CrossOrderbookPass,
  accountId: string,
  offerId: string,
): string | undefined => {
  const admission = getCrossAdmission(pass, accountId, offerId);
  if (admission && admission.status !== 'admitted') {
    return `admission:${admission.status}`;
  }
  const entityRoute = pass.hubState.crossJurisdictionSwaps?.get(offerId);
  if (entityRoute?.status) return entityRoute.status;
  const offerRoute = pass.hubState.accounts
    .get(accountId)
    ?.state.swapOffers?.get(offerId)
    ?.crossJurisdiction;
  return offerRoute?.status ?? admission?.route?.status;
};
