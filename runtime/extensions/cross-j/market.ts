import type { CrossJurisdictionSwapRoute } from '../../types';
import { isLiquidSwapToken } from '../../account/utils';
import { parseJurisdictionStackIdentity } from '../../jurisdiction/jurisdiction-stack';

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();
const normalizeJurisdiction = (value: string): string => String(value || '').trim().toLowerCase();

const requireStackIdentity = (jurisdiction: string, errorCode: string) => {
  const stack = parseJurisdictionStackIdentity(jurisdiction);
  if (!stack) {
    throw new Error(`${errorCode}:${normalizeJurisdiction(jurisdiction)}`);
  }
  return stack;
};

const crossJurisdictionStackKey = (jurisdiction: string): string => {
  const stack = requireStackIdentity(jurisdiction, 'CROSS_J_MARKET_JURISDICTION_INVALID');
  return `stack:${stack.chainId}:${stack.depositoryAddress}`;
};

const crossJurisdictionAssetKey = (jurisdiction: string, tokenId: number): string =>
  `${crossJurisdictionStackKey(jurisdiction)}:${Math.floor(Number(tokenId) || 0)}`;

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
    route.source.counterpartyEntityId,
    route.target.jurisdiction,
    route.target.entityId,
  );
}

export function deriveCanonicalCrossJurisdictionBookOwnerForLegs(
  sourceJurisdiction: string,
  sourceHubEntityId: string,
  targetJurisdiction: string,
  targetHubEntityId: string,
): string {
  const sourceStack = requireStackIdentity(sourceJurisdiction, 'CROSS_J_BOOK_JURISDICTION_INVALID');
  const targetStack = requireStackIdentity(targetJurisdiction, 'CROSS_J_BOOK_JURISDICTION_INVALID');
  if (
    sourceStack.chainId === targetStack.chainId &&
    sourceStack.depositoryAddress === targetStack.depositoryAddress
  ) {
    throw new Error(
      `CROSS_J_REQUIRES_DISTINCT_STACKS:stack:${sourceStack.chainId}:${sourceStack.depositoryAddress}`,
    );
  }
  // Book ownership is a sequencing/storage decision and must stay independent
  // from display price orientation and token selection. Every token market for
  // the same pair of stacks therefore lives in the same hub Entity orderbook.
  const sourceKey = [sourceStack.chainId, sourceStack.depositoryAddress] as const;
  const targetKey = [targetStack.chainId, targetStack.depositoryAddress] as const;
  const sourceOwnsBook = sourceKey[0] < targetKey[0] || (
    sourceKey[0] === targetKey[0] && sourceKey[1] < targetKey[1]
  );
  return normalizeEntityId(
    sourceOwnsBook
      ? sourceHubEntityId
      : targetHubEntityId,
  );
}
