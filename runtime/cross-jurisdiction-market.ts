import type { CrossJurisdictionSwapRoute } from './types';
import { isLiquidSwapToken } from './account-utils';

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();
const normalizeJurisdiction = (value: string): string => String(value || '').trim().toLowerCase();

const crossJurisdictionAssetKey = (jurisdiction: string, tokenId: number): string =>
  `${normalizeJurisdiction(jurisdiction)}:${Math.floor(Number(tokenId) || 0)}`;

const sourceLegIsCanonicalBase = (
  sourceJurisdiction: string,
  sourceTokenId: number,
  targetJurisdiction: string,
  targetTokenId: number,
): boolean => {
  const sourceKey = crossJurisdictionAssetKey(sourceJurisdiction, sourceTokenId);
  const targetKey = crossJurisdictionAssetKey(targetJurisdiction, targetTokenId);
  const sourceIsLiquid = isLiquidSwapToken(sourceTokenId);
  const targetIsLiquid = isLiquidSwapToken(targetTokenId);

  // Cross-j venue price is quote per base. Keep USD stables (USDC/USDT)
  // on the quote side across jurisdictions so WETH/USDT means USDT per WETH,
  // not the inverted jurisdiction-string ordering.
  if (sourceIsLiquid !== targetIsLiquid) {
    return !sourceIsLiquid;
  }

  return sourceKey <= targetKey;
};

export type CanonicalCrossJurisdictionMarket = {
  sourceKey: string;
  targetKey: string;
  baseKey: string;
  quoteKey: string;
  sourceIsBase: boolean;
  venueId: string;
};

export function deriveCanonicalCrossJurisdictionMarket(route: CrossJurisdictionSwapRoute): CanonicalCrossJurisdictionMarket {
  return deriveCanonicalCrossJurisdictionMarketForLegs(
    route.source.jurisdiction,
    route.source.tokenId,
    route.target.jurisdiction,
    route.target.tokenId,
  );
}

export function deriveCanonicalCrossJurisdictionMarketForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  targetJurisdiction: string,
  targetTokenId: number,
): CanonicalCrossJurisdictionMarket {
  const sourceKey = crossJurisdictionAssetKey(sourceJurisdiction, sourceTokenId);
  const targetKey = crossJurisdictionAssetKey(targetJurisdiction, targetTokenId);
  const sourceIsBase = sourceLegIsCanonicalBase(sourceJurisdiction, sourceTokenId, targetJurisdiction, targetTokenId);
  const baseKey = sourceIsBase ? sourceKey : targetKey;
  const quoteKey = sourceIsBase ? targetKey : sourceKey;
  return {
    sourceKey,
    targetKey,
    baseKey,
    quoteKey,
    sourceIsBase,
    venueId: `cross:${baseKey}/${quoteKey}`,
  };
}

export function deriveCanonicalCrossJurisdictionVenueId(route: CrossJurisdictionSwapRoute): string {
  return deriveCanonicalCrossJurisdictionMarket(route).venueId;
}

export function deriveCanonicalCrossJurisdictionVenueIdForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  targetJurisdiction: string,
  targetTokenId: number,
): string {
  return deriveCanonicalCrossJurisdictionMarketForLegs(
    sourceJurisdiction,
    sourceTokenId,
    targetJurisdiction,
    targetTokenId,
  ).venueId;
}

export function deriveCanonicalCrossJurisdictionBookOwner(route: CrossJurisdictionSwapRoute): string {
  return deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    route.source.jurisdiction,
    route.source.tokenId,
    route.source.counterpartyEntityId,
    route.target.jurisdiction,
    route.target.tokenId,
    route.target.entityId,
  );
}

export function deriveCanonicalCrossJurisdictionBookOwnerForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  sourceHubEntityId: string,
  targetJurisdiction: string,
  targetTokenId: number,
  targetHubEntityId: string,
): string {
  const sourceKey = crossJurisdictionAssetKey(sourceJurisdiction, sourceTokenId);
  const targetKey = crossJurisdictionAssetKey(targetJurisdiction, targetTokenId);
  // Book ownership is a sequencing/storage decision and must stay independent
  // from display price orientation. USD stables can be quote-side for prices
  // without moving the book to a different hub.
  const sourceOwnsBook = sourceKey <= targetKey;
  return normalizeEntityId(
    sourceOwnsBook
      ? sourceHubEntityId
      : targetHubEntityId,
  );
}
