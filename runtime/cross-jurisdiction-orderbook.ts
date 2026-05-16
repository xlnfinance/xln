import {
  CROSS_J_MAX_FILL_RATIO,
  deriveCanonicalCrossJurisdictionMarket,
} from './cross-jurisdiction';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from './orderbook';
import {
  deriveCanonicalSwapFillRatio,
  type NormalizedOrderbookOffer,
} from './swap-execution';
import type { AccountTx, CrossJurisdictionSwapRoute } from './types';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export interface CrossJurisdictionFillInstruction {
  accountId: string;
  offerId: string;
  route: CrossJurisdictionSwapRoute;
  fillRatio: number;
  cancelRemainder: boolean;
  sourceAmount: bigint;
  targetAmount: bigint;
  executionSourceAmount: bigint;
  executionTargetAmount: bigint;
  priceImprovementMode: 'source_savings' | 'target_bonus' | 'none';
  priceImprovementAmount: bigint;
  priceImprovementTokenId: number | null;
  priceTicks: bigint;
  pairId: string;
  orderId: string;
}

export type CrossMarketOffer = {
  offer: NormalizedOrderbookOffer;
  route: CrossJurisdictionSwapRoute;
  pairId: string;
  side: 0 | 1;
  baseAmount: bigint;
  quoteAmount: bigint;
  priceTicks: bigint;
  makerId: string;
};

export type CrossOrderbookFill = {
  filledLots: number;
  weightedCost: bigint;
};

export const computeCrossJurisdictionPriceTicks = (
  side: 0 | 1,
  baseAmount: bigint,
  quoteAmount: bigint,
): bigint => {
  if (baseAmount <= 0n || quoteAmount <= 0n) return 0n;
  const scaledQuote = quoteAmount * ORDERBOOK_PRICE_SCALE;
  const remainder = scaledQuote % baseAmount;
  let priceTicks = scaledQuote / baseAmount;
  if (side === 1 && remainder > 0n) priceTicks += 1n;
  return priceTicks > 0n ? priceTicks : 0n;
};

export const buildCrossJurisdictionMarketOffer = (
  offer: NormalizedOrderbookOffer,
  hubEntityId: string,
): CrossMarketOffer | null => {
  const route = offer.crossJurisdiction;
  if (!route) return null;
  const bookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
  if (bookOwner && bookOwner !== normalizeEntityRef(hubEntityId)) return null;
  if (route.status !== 'resting' && route.status !== 'partially_filled') return null;
  const market = deriveCanonicalCrossJurisdictionMarket(route);
  if (!market.sourceKey || !market.targetKey || market.sourceKey === market.targetKey) return null;
  const side: 0 | 1 = market.sourceIsBase ? 1 : 0;
  const baseAmount = side === 1 ? offer.giveAmount : offer.wantAmount;
  const quoteAmount = side === 1 ? offer.wantAmount : offer.giveAmount;
  const priceTicks = offer.priceTicks > 0n
    ? offer.priceTicks
    : computeCrossJurisdictionPriceTicks(side, baseAmount, quoteAmount);
  if (baseAmount <= 0n || quoteAmount <= 0n || priceTicks <= 0n) return null;
  return {
    offer,
    route,
    pairId: market.venueId,
    side,
    baseAmount,
    quoteAmount,
    priceTicks,
    makerId: offer.makerIsLeft ? offer.fromEntity : offer.toEntity,
  };
};

export const buildCrossJurisdictionFillAck = (
  accountId: string,
  offerId: string,
  namespacedOrderId: string,
  meta: CrossMarketOffer,
  fill: CrossOrderbookFill,
): { instruction: CrossJurisdictionFillInstruction; tx: CrossSwapFillAckTx } | null => {
  const filledLotsBig = BigInt(fill.filledLots);
  if (filledLotsBig <= 0n || fill.weightedCost <= 0n) return null;

  const executionBaseWei = filledLotsBig * SWAP_LOT_SCALE;
  const executionQuoteWei = (fill.weightedCost * SWAP_LOT_SCALE) / ORDERBOOK_PRICE_SCALE;
  const sourceAmount = meta.side === 1 ? executionBaseWei : executionQuoteWei;
  const targetAmount = meta.side === 1 ? executionQuoteWei : executionBaseWei;
  if (sourceAmount <= 0n || targetAmount <= 0n) return null;

  const previousRatio = Math.max(0, Math.min(
    CROSS_J_MAX_FILL_RATIO,
    Math.floor(Number(meta.route.claimedRatio ?? 0) || 0),
  ));
  const previousCumulativeRatio = Math.max(
    previousRatio,
    Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(meta.route.cumulativeFillRatio ?? 0) || 0))),
  );
  const sourceTotal = BigInt(meta.route.source.amount);
  const targetTotal = BigInt(meta.route.target.amount);
  const previousSourceClaimed =
    meta.route.filledSourceAmount ??
    meta.route.sourceClaimed ??
    ((sourceTotal * BigInt(previousCumulativeRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const desiredSourceClaimed = previousSourceClaimed + sourceAmount;
  const cappedSourceClaimed = desiredSourceClaimed >= sourceTotal ? sourceTotal : desiredSourceClaimed;
  const fillRatio = cappedSourceClaimed >= sourceTotal
    ? CROSS_J_MAX_FILL_RATIO
    : deriveCanonicalSwapFillRatio(sourceTotal, cappedSourceClaimed);
  if (fillRatio <= previousCumulativeRatio) return null;

  const settlementSourceAmount =
    (sourceTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) - previousSourceClaimed;
  const previousTargetClaimed =
    meta.route.filledTargetAmount ??
    meta.route.targetClaimed ??
    ((targetTotal * BigInt(previousCumulativeRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const settlementTargetAmount =
    (targetTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) - previousTargetClaimed;
  if (settlementSourceAmount <= 0n || settlementTargetAmount <= 0n) return null;
  const priceImprovementMode = meta.route.priceImprovementMode ?? 'source_savings';
  const sourceSavings = settlementSourceAmount > sourceAmount ? settlementSourceAmount - sourceAmount : 0n;
  const targetBonus = targetAmount > settlementTargetAmount ? targetAmount - settlementTargetAmount : 0n;
  const priceImprovementAmount = priceImprovementMode === 'source_savings'
    ? sourceSavings
    : priceImprovementMode === 'target_bonus'
      ? targetBonus
      : 0n;
  const priceImprovementTokenId = priceImprovementAmount > 0n
    ? priceImprovementMode === 'source_savings'
      ? Number(meta.route.source.tokenId)
      : Number(meta.route.target.tokenId)
    : null;
  const executionSourceAmount = priceImprovementMode === 'source_savings' && sourceSavings > 0n
    ? settlementSourceAmount - sourceSavings
    : settlementSourceAmount;
  const executionTargetAmount = priceImprovementMode === 'target_bonus' && targetBonus > 0n
    ? settlementTargetAmount + targetBonus
    : settlementTargetAmount;

  const instruction: CrossJurisdictionFillInstruction = {
    accountId,
    offerId,
    route: meta.route,
    fillRatio,
    cancelRemainder: fillRatio >= CROSS_J_MAX_FILL_RATIO,
    sourceAmount: settlementSourceAmount,
    targetAmount: settlementTargetAmount,
    executionSourceAmount,
    executionTargetAmount,
    priceImprovementMode,
    priceImprovementAmount,
    priceImprovementTokenId,
    priceTicks: meta.priceTicks,
    pairId: meta.pairId,
    orderId: namespacedOrderId,
  };
  const tx: CrossSwapFillAckTx = {
    type: 'cross_swap_fill_ack',
    data: {
      offerId,
      fillSeq: Math.max(0, Math.floor(Number(meta.route.fillSeq ?? 0) || 0)) + 1,
      incrementalSourceAmount: settlementSourceAmount,
      incrementalTargetAmount: settlementTargetAmount,
      cumulativeSourceAmount: previousSourceClaimed + settlementSourceAmount,
      cumulativeTargetAmount: previousTargetClaimed + settlementTargetAmount,
      cumulativeFillRatio: fillRatio,
      executionSourceAmount,
      executionTargetAmount,
      priceImprovementMode,
      ...(priceImprovementAmount > 0n ? { priceImprovementAmount } : {}),
      ...(priceImprovementTokenId !== null ? { priceImprovementTokenId } : {}),
      cancelRemainder: fillRatio >= CROSS_J_MAX_FILL_RATIO,
      comment: `cross-j-hashledger-fill:${fillRatio}`,
      priceTicks: meta.priceTicks,
      pairId: meta.pairId,
    },
  };
  return { instruction, tx };
};

export const buildCrossJurisdictionCancelAck = (
  offerId: string,
  route: CrossJurisdictionSwapRoute,
): CrossSwapFillAckTx => {
  const currentRatio = Math.max(
    0,
    Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(route.cumulativeFillRatio ?? route.claimedRatio ?? 0) || 0)),
  );
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const cumulativeSourceAmount =
    route.filledSourceAmount ??
    route.sourceClaimed ??
    ((sourceTotal * BigInt(currentRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const cumulativeTargetAmount =
    route.filledTargetAmount ??
    route.targetClaimed ??
    ((targetTotal * BigInt(currentRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  return {
    type: 'cross_swap_fill_ack',
    data: {
      offerId,
      fillSeq: Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0)),
      incrementalSourceAmount: 0n,
      incrementalTargetAmount: 0n,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
      cumulativeFillRatio: currentRatio,
      executionSourceAmount: 0n,
      executionTargetAmount: 0n,
      cancelRemainder: true,
      comment: 'cross-j-cancel-request',
      pairId: route.venueId || '',
    },
  };
};
