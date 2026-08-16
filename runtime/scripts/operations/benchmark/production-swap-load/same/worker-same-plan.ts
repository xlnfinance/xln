/** Canonical same-j load offer construction shared by single and multi-lane workers. */

import { deriveSwapNetAuthorization } from '../../../../../account/swap/swap-net-authorization';
import { getStaticSwapTokenDimensions } from '../../../../../orderbook';
import type { EntityTx } from '../../../../../types/entity-tx';
import { deriveExecutableBidForAsk } from '../boundary/worker-book-boundary';
import { distributeLoadOrders } from './worker-lanes';

export const LOAD_BASE_TOKEN_ID = 2;
export const LOAD_QUOTE_TOKEN_ID = 1;

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

export const quoteCreditCeiling = (
  prices: readonly bigint[],
  minimumTradeSize: bigint,
  swaps: number,
): bigint => {
  const quotes = prices.map(priceTicks =>
    deriveExecutableBidForAsk(LOAD_BASE_TOKEN_ID, LOAD_QUOTE_TOKEN_ID, minimumTradeSize, priceTicks).quoteAmount
  );
  const maximum = quotes.reduce((highest, quote) => quote > highest ? quote : highest, 0n);
  if (maximum <= 0n) throw new Error('PRODUCTION_SWAP_LOAD_MM_ASK_MISSING');
  return maximum * BigInt(swaps);
};

export const buildParallelLaneOfferPlan = (
  hubEntityId: string,
  swaps: number,
  lanes: number,
  minimumTradeSize: bigint,
  executableLimitPriceTicks: bigint,
): ReadonlyArray<Readonly<{ offers: EntityTx[]; quoteCredit: bigint; baseCredit: bigint }>> =>
  distributeLoadOrders(swaps, lanes).map((count, laneIndex) => {
    const offers = buildSameLoadOffers(
      hubEntityId,
      `prod-load-lane-${laneIndex + 1}`,
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
  swaps: number,
  lanesPerSide: number,
  minimumTradeSize: bigint,
  priceTicks: bigint,
): Readonly<{
  makerPlans: ReturnType<typeof buildParallelLaneOfferPlan>;
  takerPlans: ReturnType<typeof buildParallelLaneOfferPlan>;
}> => {
  const counts = distributeLoadOrders(swaps, lanesPerSide);
  const makerPlans = counts.map((count, laneIndex) => {
    const offers = buildSameLoadAsks(
      hubEntityId,
      `prod-load-maker-${laneIndex + 1}`,
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
    swaps,
    lanesPerSide,
    minimumTradeSize,
    priceTicks,
  );
  return { makerPlans, takerPlans };
};
