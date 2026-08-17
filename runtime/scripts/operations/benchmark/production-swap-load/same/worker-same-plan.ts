/** Canonical same-j load offer construction shared by single and multi-lane workers. */

import { deriveSwapNetAuthorization } from '../../../../../account/swap/swap-net-authorization';
import { getStaticSwapTokenDimensions } from '../../../../../orderbook';
import type { EntityTx } from '../../../../../types/entity-tx';
import { deriveExecutableBidForAsk } from '../boundary/worker-book-boundary';

export const LOAD_BASE_TOKEN_ID = 2;
export const LOAD_QUOTE_TOKEN_ID = 1;

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
): ReadonlyArray<Readonly<{ offers: EntityTx[]; quoteCredit: bigint; baseCredit: bigint }>> =>
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
    };
  });

export const buildIndependentMakerTakerPlan = (
  hubEntityId: string,
  offerNamespace: string,
  swaps: number,
  lanesPerSide: number,
  minimumTradeSize: bigint,
  priceTicks: bigint,
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
      priceTicks,
    );
    return {
      offers,
      quoteCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.wantAmount : 0n), 0n),
      baseCredit: offers.reduce((sum, tx) => sum + (tx.type === 'placeSwapOffer' ? tx.data.giveAmount : 0n), 0n),
    };
  });
  const takerPlans = buildParallelLaneOfferPlan(
    hubEntityId,
    `${offerNamespace}-taker`,
    swaps,
    lanesPerSide,
    minimumTradeSize,
    priceTicks,
  );
  return { makerPlans, takerPlans };
};
