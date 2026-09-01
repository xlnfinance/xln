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
export const REALISTIC_TAKER_SIZE_CYCLE = [1n, 2n, 5n, 10n, 20n] as const;

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

type RestingAsk = Readonly<{ priceTicks: bigint; qtyLots: bigint }>;

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

const distributeOffers = (
  lanes: number,
  rounds: number,
  build: (globalIndex: number, laneIndex: number, round: number) => EntityTx,
): EntityTx[][] => Array.from({ length: lanes }, (_, laneIndex) =>
  Array.from({ length: rounds }, (_, round) => build(round * lanes + laneIndex, laneIndex, round)));

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

const deterministicCoprimeStride = (size: number): number => {
  let stride = 2_654_435_761 % size;
  if (stride < 1) stride = 1;
  while (greatestCommonDivisor(stride, size) !== 1) stride += 1;
  return stride;
};

/**
 * Assign a per-round order strategy to a trader without permanent maker/taker
 * cohorts. The seeded permutation randomizes the initial side; every next
 * round flips that side and rotates the size/price strategy within it. Thus a
 * trader deterministically exercises both sides while every round remains an
 * exact balanced permutation of all strategies.
 */
export const realisticTraderStrategyIndex = (
  traderIndex: number,
  round: number,
  traders: number,
): number => {
  if (!Number.isSafeInteger(traders) || traders < 2 || traders % 2 !== 0) {
    throw new Error(`HLT_REALISTIC_TRADER_COUNT_INVALID:${traders}`);
  }
  if (!Number.isSafeInteger(traderIndex) || traderIndex < 0 || traderIndex >= traders) {
    throw new Error(`HLT_REALISTIC_TRADER_INDEX_INVALID:${traderIndex}:${traders}`);
  }
  if (!Number.isSafeInteger(round) || round < 0) {
    throw new Error(`HLT_REALISTIC_TRADER_ROUND_INVALID:${round}`);
  }
  const perSide = traders / 2;
  const stride = deterministicCoprimeStride(traders);
  const sideFor = (index: number): number =>
    (Math.floor((index * stride % traders) / perSide)) ^ (round % 2);
  const side = sideFor(traderIndex);
  let rank = 0;
  for (let index = 0; index < traderIndex; index += 1) {
    if (sideFor(index) === side) rank += 1;
  }
  const strategyRotation = Math.floor(round / 2) * Math.max(1, Math.floor(perSide / 5));
  return side * perSide + (rank + strategyRotation) % perSide;
};

const flattenRoundMajor = (
  offersByLane: readonly (readonly EntityTx[])[],
  rounds: number,
): EntityTx[] => Array.from({ length: rounds }, (_, round) =>
  offersByLane.map(offers => offers[round] ?? (() => {
    throw new Error(`HLT_REALISTIC_PLAN_ROUND_MISSING:${round}`);
  })())).flat();

const simulateRealisticDistribution = (
  makers: readonly Extract<EntityTx, { type: 'placeSwapOffer' }>[],
  takers: readonly Extract<EntityTx, { type: 'placeSwapOffer' }>[],
  mmAsks: readonly RestingAsk[],
  cancelledOffers: number,
  lanesPerSide: number,
  rounds: number,
): RealisticExchangeDistribution => {
  const baseLot = getSwapLotScale(LOAD_BASE_TOKEN_ID);
  const mmDepth = mmAsks.map((ask, index) => ({
    offerId: `mm-${index}`,
    qtyLots: ask.qtyLots,
    source: 'mm' as const,
  }));
  let matchedTrades = 0;
  let mmOnlyTakers = 0;
  let userOnlyTakers = 0;
  let partialUserMakerFills = 0;
  let mmResidualTakers = 0;
  const sweeps = new Map<number, number>([[2, 0], [5, 0], [10, 0], [20, 0]]);
  const matchedUserOffers = new Set<string>();
  for (let round = 0; round < rounds; round += 1) {
    const userDepth = makers.slice(round * lanesPerSide, (round + 1) * lanesPerSide)
      .filter(tx => tx.data.giveTokenId === LOAD_BASE_TOKEN_ID)
      .map(tx => ({ offerId: tx.data.offerId, qtyLots: tx.data.giveAmount / baseLot, source: 'user' as const }));
    const asks = [...userDepth, ...mmDepth.filter(ask => ask.qtyLots > 0n)];
    let cursor = 0;
    for (const taker of takers.slice(round * lanesPerSide, (round + 1) * lanesPerSide)) {
      let remaining = taker.data.wantAmount / baseLot;
      let userOrders = 0;
      let usedMm = false;
      while (remaining > 0n) {
        const ask = asks[cursor];
        if (!ask) throw new Error('HLT_REALISTIC_MM_DEPTH_INSUFFICIENT');
        const fill = remaining < ask.qtyLots ? remaining : ask.qtyLots;
        if (ask.source === 'user') {
          userOrders += 1;
          matchedUserOffers.add(ask.offerId);
          if (fill < ask.qtyLots) partialUserMakerFills += 1;
        } else usedMm = true;
        matchedTrades += 1;
        remaining -= fill;
        ask.qtyLots -= fill;
        if (ask.qtyLots === 0n) cursor += 1;
      }
      if (userOrders === 0) mmOnlyTakers += 1;
      if (userOrders > 0 && !usedMm) userOnlyTakers += 1;
      if (userOrders > 0 && usedMm) mmResidualTakers += 1;
      const sweepCount = sweeps.get(userOrders);
      if (sweepCount !== undefined) sweeps.set(userOrders, sweepCount + 1);
    }
    if (userDepth.some(ask => ask.qtyLots > 0n)) {
      throw new Error(`HLT_REALISTIC_USER_DEPTH_UNMATCHED:${round}`);
    }
  }
  return {
    submittedOffers: makers.length + takers.length,
    matchedSubmittedOffers: matchedUserOffers.size + takers.length,
    matchedTrades,
    cancelledOffers,
    mmOnlyTakers,
    userOnlyTakers,
    partialUserMakerFills,
    mmResidualTakers,
    sweep2Takers: sweeps.get(2) ?? 0,
    sweep5Takers: sweeps.get(5) ?? 0,
    sweep10Takers: sweeps.get(10) ?? 0,
    sweep20Takers: sweeps.get(20) ?? 0,
  };
};

export const deriveRealisticExchangeDistribution = (options: Readonly<{
  makerPlans: readonly SwapLanePlan[];
  takerPlans: readonly SwapLanePlan[];
  mmAsks: readonly RestingAsk[];
  takerLimitPriceTicks: bigint;
  lanesPerSide: number;
  rounds: number;
}>): RealisticExchangeDistribution => simulateRealisticDistribution(
  flattenRoundMajor(options.makerPlans.map(plan => plan.offers), options.rounds)
    .filter((tx): tx is Extract<EntityTx, { type: 'placeSwapOffer' }> => tx.type === 'placeSwapOffer'),
  flattenRoundMajor(options.takerPlans.map(plan => plan.offers), options.rounds)
    .filter((tx): tx is Extract<EntityTx, { type: 'placeSwapOffer' }> => tx.type === 'placeSwapOffer'),
  options.mmAsks.filter(ask => ask.priceTicks <= options.takerLimitPriceTicks),
  options.makerPlans.reduce((total, plan) => total + plan.cancelledOfferIds.length, 0),
  options.lanesPerSide,
  options.rounds,
);

export const buildRealisticExchangePlan = (options: Readonly<{
  hubEntityId: string;
  offerNamespace: string;
  rounds: number;
  lanesPerSide: number;
  minimumTradeSize: bigint;
  partialMakerAskPriceTicks: bigint;
  makerAskPriceTicks: bigint;
  restingBidPriceTicks: bigint;
  takerLimitPriceTicks: bigint;
  mmAsks: readonly RestingAsk[];
}>): Readonly<{
  traderPlans: readonly SwapLanePlan[];
  distribution: RealisticExchangeDistribution;
}> => {
  const totalPerSide = options.rounds * options.lanesPerSide;
  if (!Number.isSafeInteger(totalPerSide) || totalPerSide < 1) {
    throw new Error('HLT_REALISTIC_PLAN_CARDINALITY_INVALID');
  }
  const matchedMakersPerRound = Math.floor(options.lanesPerSide * 3 / 5);
  const baseUnit = deriveRealisticBaseUnit(options.minimumTradeSize, [
    options.partialMakerAskPriceTicks,
    options.makerAskPriceTicks,
    options.restingBidPriceTicks,
    options.takerLimitPriceTicks,
    ...options.mmAsks
      .filter(ask => ask.priceTicks <= options.takerLimitPriceTicks)
      .map(ask => ask.priceTicks),
  ]);
  const passiveOffers = distributeOffers(options.lanesPerSide, options.rounds, (_index, lane, round) => {
    const matched = lane < matchedMakersPerRound;
    const offerId = `${options.offerNamespace}-maker-${lane + 1}-${round + 1}`;
    return buildFixedBaseOffer(
      options.hubEntityId,
      offerId,
      matched ? 'ask' : 'bid',
      baseUnit * (matched && lane === 0 ? 2n : 1n),
      matched
        ? (lane === 0 ? options.partialMakerAskPriceTicks : options.makerAskPriceTicks)
        : options.restingBidPriceTicks,
    );
  });
  const aggressiveOffers = distributeOffers(options.lanesPerSide, options.rounds, (index, lane, round) =>
    buildFixedBaseOffer(
      options.hubEntityId,
      `${options.offerNamespace}-taker-${lane + 1}-${round + 1}`,
      'bid',
      baseUnit * (REALISTIC_TAKER_SIZE_CYCLE[index % REALISTIC_TAKER_SIZE_CYCLE.length] ?? (() => {
        throw new Error(`HLT_REALISTIC_TAKER_SIZE_MISSING:${index}`);
      })()),
      options.takerLimitPriceTicks,
    ));
  const traders = options.lanesPerSide * 2;
  const traderOffers = Array.from({ length: traders }, (_, traderIndex) =>
    Array.from({ length: options.rounds }, (_, round) => {
      const strategyIndex = realisticTraderStrategyIndex(traderIndex, round, traders);
      const source = strategyIndex < options.lanesPerSide
        ? passiveOffers[strategyIndex]?.[round]
        : aggressiveOffers[strategyIndex - options.lanesPerSide]?.[round];
      if (source?.type !== 'placeSwapOffer') {
        throw new Error(`HLT_REALISTIC_TRADER_STRATEGY_MISSING:${traderIndex}:${round}:${strategyIndex}`);
      }
      return {
        ...source,
        data: {
          ...source.data,
          offerId: `${options.offerNamespace}-trader-${traderIndex + 1}-${round + 1}`,
        },
      };
    }));
  const traderPlans = traderOffers.map(offers => summarizePlan(
    offers,
    offers.filter(tx => tx.type === 'placeSwapOffer' &&
      tx.data.giveTokenId === LOAD_QUOTE_TOKEN_ID &&
      tx.data.priceTicks === options.restingBidPriceTicks)
      .map(tx => tx.type === 'placeSwapOffer' ? tx.data.offerId : ''),
  ));
  const plannedPassiveOffers = Array.from({ length: options.rounds }, (_, round) =>
    traderOffers.map(offers => offers[round]).filter((tx): tx is Extract<EntityTx, { type: 'placeSwapOffer' }> =>
      tx?.type === 'placeSwapOffer' && tx.data.priceTicks !== options.takerLimitPriceTicks)).flat();
  const plannedAggressiveOffers = Array.from({ length: options.rounds }, (_, round) =>
    traderOffers.map(offers => offers[round]).filter((tx): tx is Extract<EntityTx, { type: 'placeSwapOffer' }> =>
      tx?.type === 'placeSwapOffer' && tx.data.priceTicks === options.takerLimitPriceTicks)).flat();
  const distribution = simulateRealisticDistribution(
    plannedPassiveOffers,
    plannedAggressiveOffers,
    options.mmAsks.filter(ask => ask.priceTicks <= options.takerLimitPriceTicks),
    traderPlans.reduce((total, plan) => total + plan.cancelledOfferIds.length, 0),
    options.lanesPerSide,
    options.rounds,
  );
  return { traderPlans, distribution };
};

/**
 * One balanced user market: every round has exactly one ask and one bid for
 * each pair of traders, so measured settlement never depends on MM
 * replenishment.
 *
 * A trader keeps its side for the whole run. Flipping sides per round looks
 * more lifelike, but every order here rests at the same price: a trader whose
 * previous order is still resting when its opposite-side order arrives crosses
 * itself, and self-trade prevention then cancels the incoming order with a
 * zero fill (`core/orderbook/core.ts`, `stpPolicy === 1`). The maker stays
 * resting, its intended counterparty is destroyed, and the run silently loses
 * trades — measured at 5 to 19 of 2,500 with 1,000 traders, varying with
 * arrival order. A fixed side per trader makes the plan's trade count exact by
 * construction instead of by timing. Side coverage per Runtime belongs to a
 * workload whose price levels keep the two sides apart.
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
  const matchedRatio = distribution.matchedSubmittedOffers / distribution.submittedOffers;
  if (matchedRatio < 0.79 || matchedRatio > 0.81) {
    throw new Error(`HLT_REALISTIC_MATCHED_OFFER_RATIO_INVALID:${matchedRatio}`);
  }
  const required = [
    distribution.mmOnlyTakers,
    distribution.userOnlyTakers,
    distribution.partialUserMakerFills,
    distribution.mmResidualTakers,
    distribution.sweep2Takers,
    distribution.sweep5Takers,
    distribution.sweep10Takers,
    distribution.sweep20Takers,
  ];
  if (required.some(count => count < 1)) {
    throw new Error(`HLT_REALISTIC_DISTRIBUTION_COVERAGE_MISSING:${required.join(':')}`);
  }
};
