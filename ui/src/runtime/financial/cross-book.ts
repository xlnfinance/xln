import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '@xln/core/extensions/cross-j/market';

type BookLeg = { jurisdiction: string; tokenId: number; hubId: string };

/** Price orientation and storage owner are separate canonical decisions. */
export function crossBookMarket(source: BookLeg, target: BookLeg) {
  const market = deriveCanonicalCrossJurisdictionMarketForLegs(
    source.jurisdiction,
    source.tokenId,
    target.jurisdiction,
    target.tokenId,
  );
  return {
    pairId: market.venueId,
    hubId: deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      source.jurisdiction,
      source.hubId,
      target.jurisdiction,
      target.hubId,
    ),
    baseTokenId: market.sourceIsBase ? source.tokenId : target.tokenId,
    quoteTokenId: market.sourceIsBase ? target.tokenId : source.tokenId,
    sourceIsBase: market.sourceIsBase,
  };
}

export type CrossBookMarket = ReturnType<typeof crossBookMarket>;
