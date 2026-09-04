import { forkBookState, type BookState } from '../../../../../../orderbook';
import {
  buildCrossJurisdictionMarketOffer,
  crossJurisdictionBookAdmissionKeyFor,
  type CrossMarketOffer,
} from '../../../../../../extensions/cross-j/orderbook';
import { swapKey, type CrossJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import type {
  CrossOrderbookPass,
  CrossOrderbookProcessInput,
} from './types';

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
  // Fill progress never reaches the Account offer; the admitted route (or the
  // Hub route mirror) carries the progressed remainder the book row reflects.
  const progressedRoute =
    getCrossAdmission(pass, offer.accountId, offer.offerId)?.route ??
    pass.hubState.crossJurisdictionSwaps?.get(offer.offerId) ??
    offer.crossJurisdiction;
  const marketOffer = buildCrossJurisdictionMarketOffer(
    progressedRoute === offer.crossJurisdiction ? offer : { ...offer, crossJurisdiction: progressedRoute },
    pass.hubState.entityId,
  );
  if (marketOffer) pass.crossLiveOfferMeta.set(key, marketOffer);
  return marketOffer;
};

const getCrossAdmission = (
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
