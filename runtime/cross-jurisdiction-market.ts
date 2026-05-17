import type { CrossJurisdictionSwapRoute } from './types';

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();
const normalizeJurisdiction = (value: string): string => String(value || '').trim().toLowerCase();

const crossJurisdictionAssetKey = (jurisdiction: string, tokenId: number): string =>
  `${normalizeJurisdiction(jurisdiction)}:${Math.floor(Number(tokenId) || 0)}`;

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
  const sourceIsBase = sourceKey <= targetKey;
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
  return normalizeEntityId(
    sourceKey <= targetKey
      ? sourceHubEntityId
      : targetHubEntityId,
  );
}
