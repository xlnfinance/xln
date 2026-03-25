import type { EntityState, SwapBookEntry } from './types';
import { compareCanonicalText, swapKey } from './swap-execution';

export function listOpenSwapOffers(state: Pick<EntityState, 'accounts'>): SwapBookEntry[] {
  const offers: SwapBookEntry[] = [];
  for (const [accountId, account] of state.accounts.entries()) {
    if (!(account?.swapOffers instanceof Map)) continue;
    for (const [offerId, offer] of account.swapOffers.entries()) {
      const createdHeight = Math.max(0, Number(offer.createdHeight));
      offers.push({
        offerId: String(offerId),
        accountId: String(accountId),
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        minFillRatio: offer.minFillRatio,
        createdHeight,
        priceTicks: offer.priceTicks ?? 0n,
      });
    }
  }
  return offers.sort((left, right) => {
    const heightCmp = right.createdHeight - left.createdHeight;
    if (heightCmp !== 0) return heightCmp;
    const accountCmp = compareCanonicalText(left.accountId, right.accountId);
    if (accountCmp !== 0) return accountCmp;
    return compareCanonicalText(left.offerId, right.offerId);
  });
}

export function getOpenSwapOfferEntries(state: Pick<EntityState, 'accounts'>): Map<string, SwapBookEntry> {
  return new Map(listOpenSwapOffers(state).map((offer) => [swapKey(offer.accountId, offer.offerId), offer]));
}
