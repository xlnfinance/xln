import { LIMITS } from '../constants';
import { deriveCanonicalCrossJurisdictionMarket } from '../extensions/cross-j';
import type { SwapOffer } from '../types';

export const accountSwapMarketKey = (
  offer: Pick<SwapOffer, 'giveTokenId' | 'wantTokenId' | 'crossJurisdiction'>,
): string => {
  if (!offer.crossJurisdiction) {
    return `same:${offer.giveTokenId}>${offer.wantTokenId}`;
  }
  const market = deriveCanonicalCrossJurisdictionMarket(offer.crossJurisdiction);
  return `${market.venueId}:${market.sourceIsBase ? 'base>quote' : 'quote>base'}`;
};

export const getAccountSwapMarketOfferCount = (
  offers: Iterable<SwapOffer>,
  candidate: Pick<SwapOffer, 'giveTokenId' | 'wantTokenId' | 'crossJurisdiction' | 'makerIsLeft'>,
): number => {
  const marketKey = accountSwapMarketKey(candidate);
  let count = 0;
  for (const offer of offers) {
    if (offer.makerIsLeft !== candidate.makerIsLeft) continue;
    if (accountSwapMarketKey(offer) === marketKey) count += 1;
  }
  return count;
};

export const getAccountSwapMarketLimitError = (
  offers: Iterable<SwapOffer>,
  candidate: Pick<SwapOffer, 'giveTokenId' | 'wantTokenId' | 'crossJurisdiction' | 'makerIsLeft'>,
): string | undefined => {
  const count = getAccountSwapMarketOfferCount(offers, candidate);
  const limit = LIMITS.MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET;
  if (count < limit) return undefined;
  return `Too many open swap offers for ${accountSwapMarketKey(candidate)} on ${candidate.makerIsLeft ? 'left' : 'right'} side: max ${limit}`;
};
