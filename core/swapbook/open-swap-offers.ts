import type { SwapBookEntry } from '../entity/types';
import type { SwapOffer } from '../types/account';
import { compareCanonicalText } from './swap-execution';

export function listOpenSwapOffers(state: {
  accounts: ReadonlyMap<string, { state: { swapOffers: ReadonlyMap<string, SwapOffer> } }>;
}): SwapBookEntry[] {
  const offers: SwapBookEntry[] = [];
  for (const [accountId, account] of state.accounts.entries()) {
    for (const [offerId, offer] of account.state.swapOffers.entries()) {
      const createdHeight = Math.max(0, Number(offer.createdHeight));
      offers.push({
        offerId: String(offerId),
        accountId: String(accountId),
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        createdHeight,
        priceTicks: offer.priceTicks,
        ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
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
