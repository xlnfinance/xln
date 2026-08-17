/** Parallel same-j load submission across independently signed Entity/Account lanes. */

import type { RuntimeInput } from '../../../../../runtime/types';
import type { LoadBookSnapshot } from '../boundary/worker-book-boundary';
import type { LoadFrame, LoadIdentity } from '../boundary/worker-boundary';
import { setupParallelLoadLanes } from './worker-lanes';
import {
  buildIndependentMakerTakerPlan,
  LOAD_BASE_TOKEN_ID,
  LOAD_QUOTE_TOKEN_ID,
} from './worker-same-plan';
import { deriveSameOrderbookPriceBandBounds } from '../../../../../entity/tx/handlers/account/orderbook/helpers';
import {
  sendObserved,
  waitForTradeCount,
  type ConnectedRuntime,
} from '../worker-runtime';
import type { SettlementAccountPair } from '../settlement-reader';

export type ParallelLaneSubmission = Readonly<{
  finalBook: LoadBookSnapshot;
  runtimeInputBatches: number;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  economicCompletionElapsedMs: number;
  roundSubmissionLagMs: readonly number[];
  settlementPairs: readonly SettlementAccountPair[];
}>;

export type PreparedParallelSameLoad = Readonly<{
  makerIdentities: readonly LoadIdentity[];
  takerIdentities: readonly LoadIdentity[];
  makerPlans: ReturnType<typeof buildIndependentMakerTakerPlan>['makerPlans'];
  takerPlans: ReturnType<typeof buildIndependentMakerTakerPlan>['takerPlans'];
}>;

type IndependentLanePlans = PreparedParallelSameLoad['makerPlans'];

export const buildLaneRoundOfferInputs = (
  identities: readonly LoadIdentity[],
  plans: IndependentLanePlans,
  round: number,
): RuntimeInput['entityInputs'] => identities.map((identity, index) => ({
  entityId: identity.entityId,
  signerId: identity.signerId,
  entityTxs: [plans[index]!.offers[round]!],
}));

const settlementPairs = (
  hubEntityId: string,
  identities: readonly LoadIdentity[],
  plans: IndependentLanePlans,
): SettlementAccountPair[] => identities.map((identity, index) => ({
  hubEntityId,
  loadEntityId: identity.entityId,
  offerIds: plans[index]!.offers.map(tx => {
    if (tx.type !== 'placeSwapOffer') throw new Error('PRODUCTION_SWAP_LOAD_SETTLEMENT_OFFER_TYPE_INVALID');
    return tx.data.offerId;
  }),
}));

export const prepareParallelSameLoad = async (options: {
  workDir: string;
  hub: ConnectedRuntime;
  load: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  minimumTradeSize: bigint;
  swapsPerRound: number;
  rounds: number;
  lanes: number;
  laneOffset: number;
}): Promise<PreparedParallelSameLoad> => {
  const highestVisibleAsk = options.initialBook.executableAskPriceTicks.at(-1);
  const bestVisibleAsk = options.initialBook.executableAskPriceTicks[0];
  const bestBid = options.initialBook.bestBidPriceTicks;
  if (!highestVisibleAsk || !bestVisibleAsk || bestBid === null) {
    throw new Error('PRODUCTION_SWAP_LOAD_MM_TWO_SIDED_DEPTH_MISSING');
  }
  const anchor = (bestBid + bestVisibleAsk) / 2n;
  const { maxAllowed } = deriveSameOrderbookPriceBandBounds(anchor);
  if (maxAllowed < highestVisibleAsk) throw new Error('PRODUCTION_SWAP_LOAD_VISIBLE_DEPTH_OUTSIDE_PRICE_BAND');
  if (anchor <= bestBid || anchor >= bestVisibleAsk) {
    throw new Error('PRODUCTION_SWAP_LOAD_INDEPENDENT_SPREAD_MISSING');
  }
  // Load makers and takers meet inside the real MM spread. Neither side can
  // consume bootstrap MM liquidity, so every counted trade proves an
  // independently signed maker Account settled against a distinct taker lane.
  const { makerPlans, takerPlans } = buildIndependentMakerTakerPlan(
    options.hubIdentity.entityId,
    `prod-load-${options.laneOffset}`,
    options.swapsPerRound * options.rounds,
    options.lanes,
    options.minimumTradeSize,
    anchor,
  );
  if (
    makerPlans.some(plan => plan.offers.length !== options.rounds) ||
    takerPlans.some(plan => plan.offers.length !== options.rounds) ||
    makerPlans.some(plan => plan.baseCredit <= 0n || plan.quoteCredit <= 0n) ||
    takerPlans.some(plan => plan.baseCredit <= 0n || plan.quoteCredit <= 0n)
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_PLAN_EMPTY');
  }
  const makerIdentities = await setupParallelLoadLanes({
    workDir: options.workDir,
    hub: options.hub,
    load: options.load,
    hubIdentity: options.hubIdentity,
    lanes: options.lanes,
    laneOffset: options.laneOffset,
    role: 'maker',
    laneGrantedCreditTokenId: LOAD_QUOTE_TOKEN_ID,
    laneGrantedCreditAmounts: makerPlans.map(plan => plan.quoteCredit),
    hubGrantedCreditTokenId: LOAD_BASE_TOKEN_ID,
    hubGrantedCreditAmounts: makerPlans.map(plan => plan.baseCredit),
  });
  const takerIdentities = await setupParallelLoadLanes({
    workDir: options.workDir,
    hub: options.hub,
    load: options.load,
    hubIdentity: options.hubIdentity,
    lanes: options.lanes,
    laneOffset: options.laneOffset,
    role: 'taker',
    laneGrantedCreditTokenId: LOAD_BASE_TOKEN_ID,
    laneGrantedCreditAmounts: takerPlans.map(plan => plan.baseCredit),
    hubGrantedCreditTokenId: LOAD_QUOTE_TOKEN_ID,
    hubGrantedCreditAmounts: takerPlans.map(plan => plan.quoteCredit),
  });
  return { makerIdentities, takerIdentities, makerPlans, takerPlans };
};

export const submitPreparedParallelSameLoad = async (options: {
  hub: ConnectedRuntime;
  load: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  initialFrame: LoadFrame;
  swapsPerRound: number;
  rounds: number;
  cadenceMs: number;
  prepared: PreparedParallelSameLoad;
}): Promise<ParallelLaneSubmission> => {
  const startedAt = performance.now();
  let enqueueAckElapsedMs = 0;
  let commandObservedElapsedMs = 0;
  const roundSubmissionLagMs: number[] = [];
  for (let round = 0; round < options.rounds; round += 1) {
    const dueAt = startedAt + round * options.cadenceMs;
    const remainingMs = dueAt - performance.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, remainingMs));
    roundSubmissionLagMs.push(Math.max(0, Math.ceil(performance.now() - dueAt)));
    const observed = await sendObserved(options.load, `prod-load-round-${options.initialFrame.height}-${round + 1}`, {
      runtimeTxs: [],
      entityInputs: [
        ...buildLaneRoundOfferInputs(options.prepared.makerIdentities, options.prepared.makerPlans, round),
        ...buildLaneRoundOfferInputs(options.prepared.takerIdentities, options.prepared.takerPlans, round),
      ],
    });
    enqueueAckElapsedMs += observed.enqueueAckElapsedMs;
    commandObservedElapsedMs += observed.commandObservedElapsedMs;
  }
  const finalBook = await waitForTradeCount(
    options.hub,
    options.hubIdentity.entityId,
    options.initialBook.tradeCount + options.swapsPerRound * options.rounds,
  );
  return {
    finalBook,
    runtimeInputBatches: options.rounds,
    enqueueAckElapsedMs,
    commandObservedElapsedMs,
    economicCompletionElapsedMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
    roundSubmissionLagMs,
    settlementPairs: [
      ...settlementPairs(options.hubIdentity.entityId, options.prepared.makerIdentities, options.prepared.makerPlans),
      ...settlementPairs(options.hubIdentity.entityId, options.prepared.takerIdentities, options.prepared.takerPlans),
    ],
  };
};
