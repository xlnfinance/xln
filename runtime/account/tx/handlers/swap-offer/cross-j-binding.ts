import type { AccountState } from '../../../../types/account';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../../extensions/cross-j';
import type { SwapOfferTx } from './admission';

export const validateCrossJurisdictionSourceBinding = (
  account: AccountState,
  tx: SwapOfferTx,
): string | null => {
  const route = tx.data.crossJurisdiction;
  if (!route) return null;
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  const sourcePull = route.sourcePull;
  const pairedPull = sourcePull
    ? account.pulls?.get(sourcePull.pullId)
    : undefined;
  if (!sourcePull || !pairedPull) {
    return 'Cross-j swap offer requires paired source pull lock';
  }
  if (
    pairedPull.tokenId !== sourcePull.tokenId ||
    pairedPull.tokenId !== tx.data.giveTokenId ||
    pairedPull.amount !== sourcePull.signedAmount ||
    (pairedPull.fullHash || '').toLowerCase() !== sourcePull.fullHash.toLowerCase() ||
    (pairedPull.partialRoot || '').toLowerCase() !== sourcePull.partialRoot.toLowerCase()
  ) {
    return 'Cross-j swap offer source pull mismatch';
  }
  const binding = pairedPull.crossJurisdiction;
  if (
    !binding ||
    binding.leg !== 'source' ||
    binding.orderId !== canonicalRoute.orderId ||
    (binding.routeHash || '').toLowerCase() !==
      (canonicalRoute.routeHash || '').toLowerCase()
  ) {
    return 'Cross-j source pull binding mismatch';
  }
  return null;
};
