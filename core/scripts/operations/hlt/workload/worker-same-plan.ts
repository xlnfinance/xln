/** Canonical same-j load offer construction shared by single and multi-lane workers. */

import { deriveSwapNetAuthorization } from '../../../../account/swap/swap-net-authorization';
import {
  getStaticSwapTokenDimensions,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  getSwapLotScale,
  quoteAmountAtPrice,
} from '../../../../orderbook';
import type { EntityTx } from '../../../../types/entity-tx';
import { safeStringify } from '../../../../protocol/serialization';
import { deriveExecutableBidForAsk } from '../boundary/worker-book-boundary';

export const LOAD_BASE_TOKEN_ID = 2;
export const LOAD_QUOTE_TOKEN_ID = 1;

export type SwapLanePlan = Readonly<{
  offers: EntityTx[];
  quoteCredit: bigint;
  baseCredit: bigint;
  cancelledOfferIds: readonly string[];
}>;

/**
 * Credit granted to H1 must cover the balance already delivered during setup
 * plus every later transfer from H1 to this trader. Opposite-side offers may
 * repay that balance, but relying on their fill order would make a valid
 * role-free plan fail when a trader starts with a bid.
 */
export const requiredReceiveCreditForOffers = (
  initialReceived: bigint,
  tokenId: number,
  offers: readonly EntityTx[],
): bigint => initialReceived + offers.reduce((total, tx) => total + (
  tx.type === 'placeSwapOffer' && tx.data.wantTokenId === tokenId
    ? tx.data.wantAmount
    : 0n
), 0n);

export type RealisticExchangeDistribution = Readonly<{
  submittedOffers: number;
  matchedSubmittedOffers: number;
  matchedTrades: number;
  cancelledOffers: number;
  mmOnlyTakers: number;
  userOnlyTakers: number;
  partialUserMakerFills: number;
  mmResidualTakers: number;
  sweep2Takers: number;
  sweep5Takers: number;
  sweep10Takers: number;
  sweep20Takers: number;
}>;

const sustainedOrdersPerLane = (totalOrders: number, lanes: number): number[] => {
  if (
    !Number.isSafeInteger(totalOrders) || !Number.isSafeInteger(lanes) ||
    totalOrders < 1 || lanes < 1 || totalOrders % lanes !== 0
  ) throw new Error('PRODUCTION_SWAP_LOAD_SUSTAINED_LANE_PLAN_INVALID');
  return Array.from({ length: lanes }, () => totalOrders / lanes);
};

export const buildSameLoadOffers = (
  hubEntityId: string,
  offerPrefix: string,
  prices: readonly bigint[],
  minimumTradeSize: bigint,
): EntityTx[] => prices.map((priceTicks, index) => {
  const { baseAmount, quoteAmount } = deriveExecutableBidForAsk(
    LOAD_BASE_TOKEN_ID,
    LOAD_QUOTE_TOKEN_ID,
    minimumTradeSize,
    priceTicks,
  );
  if (quoteAmount <= 0n) throw new Error('PRODUCTION_SWAP_LOAD_QUOTE_INVALID');
  return {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: hubEntityId,
      offerId: `${offerPrefix}-${index + 1}`,
      giveTokenId: LOAD_QUOTE_TOKEN_ID,
      giveAmount: quoteAmount,
      wantTokenId: LOAD_BASE_TOKEN_ID,
      wantAmount: baseAmount,
      ...getStaticSwapTokenDimensions(LOAD_QUOTE_TOKEN_ID, LOAD_BASE_TOKEN_ID),
      ...deriveSwapNetAuthorization(baseAmount, 1),
    },
  };
});

export const buildSameLoadAsks = (
  hubEntityId: string,
  offerPrefix: string,
  count: number,
  minimumTradeSize: bigint,
  priceTicks: bigint,
): EntityTx[] => {
  const { baseAmount, quoteAmount } = deriveExecutableBidForAsk(
    LOAD_BASE_TOKEN_ID,
    LOAD_QUOTE_TOKEN_ID,
    minimumTradeSize,
    priceTicks,
  );
  return Array.from({ length: count }, (_, index) => ({
    type: 'placeSwapOffer' as const,
    data: {
      counterpartyEntityId: hubEntityId,
      offerId: `${offerPrefix}-${index + 1}`,
      giveTokenId: LOAD_BASE_TOKEN_ID,
      giveAmount: baseAmount,
      wantTokenId: LOAD_QUOTE_TOKEN_ID,
      wantAmount: quoteAmount,
      ...getStaticSwapTokenDimensions(LOAD_BASE_TOKEN_ID, LOAD_QUOTE_TOKEN_ID),
      ...deriveSwapNetAuthorization(quoteAmount, 1),
    },
  }));
};

export const buildParallelLaneOfferPlan = (
  hubEntityId: string,
  offerNamespace: string,
  swaps: number,
  lanes: number,
  minimumTradeSize: bigint,
  executableLimitPriceTicks: bigint,
): ReadonlyArray<SwapLanePlan> =>
  sustainedOrdersPerLane(swaps, lanes).map((count, laneIndex) => {
    const offers = buildSameLoadOffers(
      hubEntityId,
      `${offerNamespace}-${laneIndex + 1}`,
      Array.from({ length: count }, () => executableLimitPriceTicks),
      minimumTradeSize,
    );
    return {
      offers,
      quoteCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.giveAmount : 0n), 0n),
      baseCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.wantAmount : 0n), 0n),
      cancelledOfferIds: [],
    };
  });

export const buildIndependentMakerTakerPlan = (
  hubEntityId: string,
  offerNamespace: string,
  swaps: number,
  lanesPerSide: number,
  minimumTradeSize: bigint,
  makerPriceTicks: bigint,
  takerPriceTicks: bigint,
): Readonly<{
  makerPlans: ReturnType<typeof buildParallelLaneOfferPlan>;
  takerPlans: ReturnType<typeof buildParallelLaneOfferPlan>;
}> => {
  const counts = sustainedOrdersPerLane(swaps, lanesPerSide);
  const makerPlans = counts.map((count, laneIndex) => {
    const offers = buildSameLoadAsks(
      hubEntityId,
      `${offerNamespace}-maker-${laneIndex + 1}`,
      count,
      minimumTradeSize,
      makerPriceTicks,
    );
    return {
      offers,
      quoteCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.wantAmount : 0n), 0n),
      baseCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.giveAmount : 0n), 0n),
      cancelledOfferIds: [],
    };
  });
  const takerPlans = buildParallelLaneOfferPlan(
    hubEntityId,
    `${offerNamespace}-taker`,
    swaps,
    lanesPerSide,
    minimumTradeSize,
    takerPriceTicks,
  );
  return { makerPlans, takerPlans };
};

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

const lcm = (left: bigint, right: bigint): bigint => left / gcd(left, right) * right;

const deriveRealisticBaseUnit = (
  minimumTradeSize: bigint,
  prices: readonly bigint[],
): bigint => {
  const dimensions = getStaticSwapTokenDimensions(LOAD_QUOTE_TOKEN_ID, LOAD_BASE_TOKEN_ID);
  const baseLot = getSwapLotScale(LOAD_BASE_TOKEN_ID);
  const exactLots = prices.map(price => getSwapExactQuoteLotMultipleAtPriceForDimensions(
    dimensions.wantTokenDecimals,
    dimensions.giveTokenDecimals,
    price,
  ));
  const commonLots = exactLots.reduce(lcm, 1n);
  const minimumBase = deriveExecutableBidForAsk(
    LOAD_BASE_TOKEN_ID,
    LOAD_QUOTE_TOKEN_ID,
    minimumTradeSize,
    prices.reduce((lowest, price) => price < lowest ? price : lowest),
  ).baseAmount;
  const minimumLots = (minimumBase + baseLot - 1n) / baseLot;
  return ((minimumLots + commonLots - 1n) / commonLots) * commonLots * baseLot;
};

const buildFixedBaseOffer = (
  hubEntityId: string,
  offerId: string,
  side: 'ask' | 'bid',
  baseAmount: bigint,
  priceTicks: bigint,
): Extract<EntityTx, { type: 'placeSwapOffer' }> => {
  const quoteAmount = quoteAmountAtPrice(
    LOAD_BASE_TOKEN_ID,
    LOAD_QUOTE_TOKEN_ID,
    baseAmount,
    priceTicks,
  );
  const dimensions = getStaticSwapTokenDimensions(
    side === 'ask' ? LOAD_BASE_TOKEN_ID : LOAD_QUOTE_TOKEN_ID,
    side === 'ask' ? LOAD_QUOTE_TOKEN_ID : LOAD_BASE_TOKEN_ID,
  );
  return {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: hubEntityId,
      offerId,
      giveTokenId: side === 'ask' ? LOAD_BASE_TOKEN_ID : LOAD_QUOTE_TOKEN_ID,
      giveAmount: side === 'ask' ? baseAmount : quoteAmount,
      wantTokenId: side === 'ask' ? LOAD_QUOTE_TOKEN_ID : LOAD_BASE_TOKEN_ID,
      wantAmount: side === 'ask' ? quoteAmount : baseAmount,
      priceTicks,
      ...dimensions,
      ...deriveSwapNetAuthorization(side === 'ask' ? quoteAmount : baseAmount, 1),
    },
  };
};

const summarizePlan = (
  offers: EntityTx[],
  cancelledOfferIds: readonly string[],
): SwapLanePlan => ({
  offers,
  quoteCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer'
    ? (tx.data.giveTokenId === LOAD_QUOTE_TOKEN_ID ? tx.data.giveAmount : 0n)
    : 0n), 0n),
  baseCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer'
    ? (tx.data.giveTokenId === LOAD_BASE_TOKEN_ID ? tx.data.giveAmount : 0n)
    : 0n), 0n),
  cancelledOfferIds,
});

type RealisticExchangePlanOptions = Readonly<{
  hubEntityId: string;
  offerNamespace: string;
  rounds: number;
  lanesPerSide: number;
  minimumTradeSize: bigint;
  matchedPriceTicks: bigint;
  restingAskPriceTicks: bigint;
  restingBidPriceTicks: bigint;
}>;

const realisticTraderCohort = (
  trader: number,
  lanesPerSide: number,
  matchedPerSide: number,
): Readonly<{ side: 'ask' | 'bid'; matched: boolean }> => {
  if (trader < matchedPerSide) return { side: 'ask', matched: true };
  if (trader < lanesPerSide) return { side: 'ask', matched: false };
  if (trader < lanesPerSide + matchedPerSide) return { side: 'bid', matched: true };
  return { side: 'bid', matched: false };
};

const buildRealisticTraderPlan = (
  options: RealisticExchangePlanOptions,
  trader: number,
  matchedPerSide: number,
  baseUnit: bigint,
): SwapLanePlan => {
  const cohort = realisticTraderCohort(trader, options.lanesPerSide, matchedPerSide);
  const priceTicks = cohort.matched
    ? options.matchedPriceTicks
    : cohort.side === 'ask' ? options.restingAskPriceTicks : options.restingBidPriceTicks;
  const offers = Array.from({ length: options.rounds }, (_, round) => buildFixedBaseOffer(
    options.hubEntityId,
    `${options.offerNamespace}-trader-${trader + 1}-${round + 1}`,
    cohort.side,
    baseUnit,
    priceTicks,
  ));
  return summarizePlan(offers, cohort.matched ? [] : offers.map(offer => offer.data.offerId));
};

export const buildRealisticExchangePlan = (options: RealisticExchangePlanOptions): Readonly<{
  traderPlans: readonly SwapLanePlan[];
  distribution: RealisticExchangeDistribution;
}> => {
  if (
    !Number.isSafeInteger(options.lanesPerSide) || options.lanesPerSide < 5 ||
    options.lanesPerSide % 5 !== 0 ||
    !Number.isSafeInteger(options.rounds) || options.rounds < 1 ||
    !(options.restingBidPriceTicks < options.matchedPriceTicks &&
      options.matchedPriceTicks < options.restingAskPriceTicks)
  ) {
    throw new Error('HLT_REALISTIC_PLAN_CARDINALITY_INVALID');
  }
  const matchedPerSide = options.lanesPerSide * 4 / 5;
  const baseUnit = deriveRealisticBaseUnit(options.minimumTradeSize, [
    options.matchedPriceTicks,
    options.restingAskPriceTicks,
    options.restingBidPriceTicks,
  ]);
  const traders = options.lanesPerSide * 2;
  const traderPlans = Array.from({ length: traders }, (_, trader) =>
    buildRealisticTraderPlan(options, trader, matchedPerSide, baseUnit));
  const matchedTrades = matchedPerSide * options.rounds;
  const submittedOffers = traders * options.rounds;
  const distribution = {
    submittedOffers,
    matchedSubmittedOffers: matchedTrades * 2,
    matchedTrades,
    cancelledOffers: submittedOffers - matchedTrades * 2,
    mmOnlyTakers: 0,
    userOnlyTakers: matchedTrades,
    partialUserMakerFills: 0,
    mmResidualTakers: 0,
    sweep2Takers: 0,
    sweep5Takers: 0,
    sweep10Takers: 0,
    sweep20Takers: 0,
  };
  return { traderPlans, distribution };
};

/**
 * One balanced user market: every round has exactly one ask and one bid for
 * each pair of traders. A trader keeps one side for the whole offered window:
 * flipping sides while earlier rounds are still in flight makes valid delivery
 * interleavings hit self-trade prevention and invalidates the fixed trade count.
 */
export const buildBalancedExchangePlan = (options: Readonly<{
  hubEntityId: string;
  offerNamespace: string;
  rounds: number;
  traders: number;
  minimumTradeSize: bigint;
  priceTicks: bigint;
}>): Readonly<{
  traderPlans: readonly SwapLanePlan[];
  distribution: RealisticExchangeDistribution;
}> => {
  if (!Number.isSafeInteger(options.traders) || options.traders < 2 || options.traders % 2 !== 0) {
    throw new Error(`HLT_BALANCED_TRADER_COUNT_INVALID:${options.traders}`);
  }
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) {
    throw new Error(`HLT_BALANCED_ROUND_COUNT_INVALID:${options.rounds}`);
  }
  const baseUnit = deriveRealisticBaseUnit(options.minimumTradeSize, [options.priceTicks]);
  const traderPlans = Array.from({ length: options.traders }, (_, trader) => summarizePlan(
    Array.from({ length: options.rounds }, (_, round) => buildFixedBaseOffer(
      options.hubEntityId,
      `${options.offerNamespace}-trader-${trader + 1}-${round + 1}`,
      trader % 2 === 0 ? 'ask' : 'bid',
      baseUnit,
      options.priceTicks,
    )),
    [],
  ));
  const matchedTrades = options.traders / 2 * options.rounds;
  const submittedOffers = options.traders * options.rounds;
  return {
    traderPlans,
    distribution: {
      submittedOffers,
      matchedSubmittedOffers: submittedOffers,
      matchedTrades,
      cancelledOffers: 0,
      mmOnlyTakers: 0,
      userOnlyTakers: matchedTrades,
      partialUserMakerFills: 0,
      mmResidualTakers: 0,
      sweep2Takers: 0,
      sweep5Takers: 0,
      sweep10Takers: 0,
      sweep20Takers: 0,
    },
  };
};

export const assertBalancedExchangeDistribution = (
  distribution: RealisticExchangeDistribution,
): void => {
  if (
    distribution.submittedOffers < 2 ||
    distribution.submittedOffers % 2 !== 0 ||
    distribution.matchedSubmittedOffers !== distribution.submittedOffers ||
    distribution.matchedTrades !== distribution.submittedOffers / 2 ||
    distribution.cancelledOffers !== 0 ||
    distribution.mmOnlyTakers !== 0 ||
    distribution.mmResidualTakers !== 0
  ) {
    throw new Error(`HLT_BALANCED_DISTRIBUTION_INVALID:${safeStringify(distribution)}`);
  }
};

export const assertRealisticExchangeDistribution = (
  distribution: RealisticExchangeDistribution,
): void => {
  if (
    distribution.submittedOffers < 1 ||
    distribution.matchedSubmittedOffers + distribution.cancelledOffers !== distribution.submittedOffers ||
    distribution.cancelledOffers < 1 ||
    distribution.matchedTrades < 1
  ) {
    throw new Error(`HLT_REALISTIC_TERMINAL_PARTITION_INVALID:${safeStringify(distribution)}`);
  }
  const matchedRatio = distribution.matchedSubmittedOffers / distribution.submittedOffers;
  if (matchedRatio < 0.79 || matchedRatio > 0.81) {
    throw new Error(`HLT_REALISTIC_MATCHED_OFFER_RATIO_INVALID:${matchedRatio}`);
  }
  if (
    distribution.userOnlyTakers !== distribution.matchedTrades ||
    distribution.mmOnlyTakers !== 0 ||
    distribution.partialUserMakerFills !== 0 ||
    distribution.mmResidualTakers !== 0 ||
    distribution.sweep2Takers !== 0 ||
    distribution.sweep5Takers !== 0 ||
    distribution.sweep10Takers !== 0 ||
    distribution.sweep20Takers !== 0
  ) {
    throw new Error(`HLT_REALISTIC_INDEPENDENT_LIQUIDITY_INVALID:${safeStringify(distribution)}`);
  }
};
