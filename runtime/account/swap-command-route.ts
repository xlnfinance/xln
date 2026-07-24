import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j';
import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionVenueIdForLegs,
} from '../extensions/cross-j/market';
import type { CrossJurisdictionSwapRoute } from '../types';

const normalizeId = (value: string): string => String(value || '').trim().toLowerCase();

const stableIdHash = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, '0');
};

export const buildDeterministicSwapOfferId = (input: Readonly<{
  logicalTimestamp: number;
  logicalHeight: number;
  sourceEntityId: string;
  counterpartyEntityId: string;
  sellToken: number;
  buyToken: number;
  sellAmount: bigint;
  buyAmount: bigint;
  priceTicks: bigint;
  routeValue: string;
}>): string => {
  const logicalTimestamp = Math.max(0, Math.floor(Number(input.logicalTimestamp) || 0));
  const logicalHeight = Math.max(0, Math.floor(Number(input.logicalHeight) || 0));
  const seed = [
    logicalTimestamp,
    logicalHeight,
    normalizeId(input.sourceEntityId),
    normalizeId(input.counterpartyEntityId),
    input.sellToken,
    input.buyToken,
    input.sellAmount.toString(),
    input.buyAmount.toString(),
    input.priceTicks.toString(),
    input.routeValue,
  ].join('|');
  return `swap-${logicalTimestamp.toString(36)}-${logicalHeight.toString(36)}-${stableIdHash(seed)}`;
};

type RouteParty = Readonly<{
  entityId: string;
  signerId: string;
  hubEntityId: string;
  hubSignerId: string;
  jurisdiction: string;
}>;

export const buildCrossJurisdictionSwapIntent = (input: Readonly<{
  offerId: string;
  logicalTimestamp: number;
  expiresInMs: number;
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  wantAmount: bigint;
  priceTicks: bigint;
  source: RouteParty;
  target: RouteParty;
}>): CrossJurisdictionSwapRoute => {
  const bookOwnerEntityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    input.source.jurisdiction,
    input.source.hubEntityId,
    input.target.jurisdiction,
    input.target.hubEntityId,
  );
  const bookHubSignerId = bookOwnerEntityId === input.source.hubEntityId
    ? input.source.hubSignerId
    : bookOwnerEntityId === input.target.hubEntityId
      ? input.target.hubSignerId
      : '';
  if (!bookHubSignerId) throw new Error('SWAP_COMMAND_BOOK_HUB_SIGNER_MISSING');
  const now = Math.max(0, Math.floor(Number(input.logicalTimestamp) || 0));
  const expiresInMs = Math.max(30_000, Math.floor(input.expiresInMs));
  return withCanonicalCrossJurisdictionRouteHash({
    orderId: input.offerId,
    bookOwnerEntityId,
    venueId: deriveCanonicalCrossJurisdictionVenueIdForLegs(
      input.source.jurisdiction,
      input.giveTokenId,
      input.target.jurisdiction,
      input.wantTokenId,
    ),
    makerEntityId: input.source.entityId,
    hubEntityId: bookOwnerEntityId,
    sourceSignerId: input.source.signerId,
    sourceHubSignerId: input.source.hubSignerId,
    targetHubSignerId: input.target.hubSignerId,
    targetSignerId: input.target.signerId,
    bookHubSignerId,
    source: {
      jurisdiction: input.source.jurisdiction,
      entityId: input.source.entityId,
      counterpartyEntityId: input.source.hubEntityId,
      tokenId: input.giveTokenId,
      amount: input.giveAmount,
    },
    target: {
      jurisdiction: input.target.jurisdiction,
      entityId: input.target.hubEntityId,
      counterpartyEntityId: input.target.entityId,
      tokenId: input.wantTokenId,
      amount: input.wantAmount,
    },
    priceTicks: input.priceTicks,
    priceImprovementMode: 'source_savings',
    status: 'intent',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + expiresInMs,
  });
};
