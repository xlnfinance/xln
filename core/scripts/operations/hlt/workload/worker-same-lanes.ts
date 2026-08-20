/** Parallel same-j load submission across independently signed Entity/Account lanes. */

import type { RuntimeInput } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import type { LoadBookSnapshot } from '../boundary/worker-book-boundary';
import type { LoadFrame, LoadIdentity } from '../boundary/worker-boundary';
import { setupParallelLoadLanes } from '../lanes/worker-lanes';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import {
  buildIndependentMakerTakerPlan,
  LOAD_BASE_TOKEN_ID,
  LOAD_QUOTE_TOKEN_ID,
} from './worker-same-plan';
import { deriveSameOrderbookPriceBandBounds } from '../../../../entity/tx/handlers/account/orderbook/helpers';
import {
  readLoadBook,
  sendObserved,
  waitForTradeCount,
  type ConnectedRuntime,
} from '../worker-runtime';
import type { SettlementAccountPair } from '../settlement-reader';

export type ParallelLaneSubmission = Readonly<{
  finalBook: LoadBookSnapshot;
  runtimeInputBatches: number;
  offersPerRound: number;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  economicCompletionElapsedMs: number;
  roundSubmissionLagMs: readonly number[];
  settlementPairs: readonly SettlementAccountPair[];
}>;

export type PreparedParallelSameLoad = Readonly<{
  makerIdentities: readonly LoadIdentity[];
  takerIdentities: readonly LoadIdentity[];
  makerRuntimes: readonly LaneRuntime[];
  takerRuntimes: readonly LaneRuntime[];
  makerPlans: ReturnType<typeof buildIndependentMakerTakerPlan>['makerPlans'];
  takerPlans: ReturnType<typeof buildIndependentMakerTakerPlan>['takerPlans'];
}>;

type IndependentLanePlans = PreparedParallelSameLoad['makerPlans'];

export type ParallelLoadRoundExtraTxs = (args: {
  lane: LaneRuntime;
  identity: LoadIdentity;
  round: number;
}) => readonly EntityTx[];

export const buildLaneRoundOfferInputs = (
  identities: readonly LoadIdentity[],
  plans: IndependentLanePlans,
  round: number,
  offersPerRound = 1,
): RuntimeInput['entityInputs'] => identities.map((identity, index) => {
  const offers = plans[index]!.offers.slice(round, round + offersPerRound);
  if (offers.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_ROUND_OFFERS_EMPTY');
  return {
    entityId: identity.entityId,
    signerId: identity.signerId,
    entityTxs: offers,
  };
});

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
  portBase: number;
  hub: ConnectedRuntime;
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
  const makers = await setupParallelLoadLanes({
    workDir: options.workDir,
    portBase: options.portBase,
    hub: options.hub,
    hubIdentity: options.hubIdentity,
    lanes: options.lanes,
    laneOffset: options.laneOffset,
    role: 'maker',
    laneGrantedCreditTokenId: LOAD_QUOTE_TOKEN_ID,
    laneGrantedCreditAmounts: makerPlans.map(plan => plan.quoteCredit),
    hubGrantedCreditTokenId: LOAD_BASE_TOKEN_ID,
    hubGrantedCreditAmounts: makerPlans.map(plan => plan.baseCredit),
  });
  const takers = await setupParallelLoadLanes({
    workDir: options.workDir,
    portBase: options.portBase,
    hub: options.hub,
    hubIdentity: options.hubIdentity,
    lanes: options.lanes,
    laneOffset: options.laneOffset,
    role: 'taker',
    laneGrantedCreditTokenId: LOAD_BASE_TOKEN_ID,
    laneGrantedCreditAmounts: takerPlans.map(plan => plan.baseCredit),
    hubGrantedCreditTokenId: LOAD_QUOTE_TOKEN_ID,
    hubGrantedCreditAmounts: takerPlans.map(plan => plan.quoteCredit),
  });
  return {
    makerIdentities: makers.identities,
    takerIdentities: takers.identities,
    makerRuntimes: makers.runtimes,
    takerRuntimes: takers.runtimes,
    makerPlans,
    takerPlans,
  };
};

const withRoundExtraTxs = (
  inputs: RuntimeInput['entityInputs'],
  extra: readonly EntityTx[],
): RuntimeInput['entityInputs'] => {
  if (extra.length === 0) return inputs;
  const input = inputs[0];
  if (!input || inputs.length !== 1) throw new Error('PRODUCTION_SWAP_LOAD_ROUND_INPUT_CARDINALITY');
  return [{ ...input, entityTxs: [...input.entityTxs, ...extra] }];
};

export const submitPreparedParallelSameLoad = async (options: {
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  initialFrame: LoadFrame;
  swapsPerRound: number;
  rounds: number;
  cadenceMs: number;
  prepared: PreparedParallelSameLoad;
  extraEntityTxs?: ParallelLoadRoundExtraTxs;
}): Promise<ParallelLaneSubmission> => {
  const startedAt = performance.now();
  let enqueueAckElapsedMs = 0;
  let commandObservedElapsedMs = 0;
  const roundSubmissionLagMs: number[] = [];
  // Every Account admits at most LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS open
  // same-j offers; a user whose queue outruns settlement gets its surplus
  // offers rejected at proposal time. Keep each user's outstanding rounds
  // under that limit: round r may start only when the Hub has already traded
  // all but `windowRounds` of the rounds sent so far.
  const windowRounds = Number(process.env['XLN_LOAD_WINDOW_ROUNDS'] || 12);
  // A user may carry several orders in one signed Account frame (a quoting
  // market maker does); `offersPerRound` rounds go out in one user input.
  const offersPerRound = Math.max(1, Number(process.env['XLN_LOAD_OFFERS_PER_ROUND'] || 1));
  if (windowRounds < offersPerRound) throw new Error('PRODUCTION_SWAP_LOAD_WINDOW_BELOW_BATCH');
  const logHubPipeline = (phase: string, round: number, book: LoadBookSnapshot, submittedSwaps: number): void => {
    const matched = book.tradeCount - options.initialBook.tradeCount;
    const inFlight = Math.max(0, submittedSwaps - matched);
    console.log(
      `[load] hub-pipeline ${phase} round=${round} submitted=${submittedSwaps} ` +
      `matched=${matched} inFlight=${inFlight} ` +
      `visibleBids=${book.visibleBidOrders} visibleAsks=${book.visibleAskOrders} ` +
      `bestBid=${book.bestBidPriceTicks ?? 'none'} bestAsk=${book.bestAskPriceTicks}`,
    );
  };
  for (let round = 0; round < options.rounds; round += offersPerRound) {
    const dueAt = startedAt + round * options.cadenceMs;
    const remainingMs = dueAt - performance.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, remainingMs));
    let lastWindowMatched = -1;
    while (true) {
      const book = await readLoadBook(options.hub, options.hubIdentity.entityId);
      const tradedRounds = Math.floor((book.tradeCount - options.initialBook.tradeCount) / options.swapsPerRound);
      const submittedSwaps = round * options.swapsPerRound;
      const matched = book.tradeCount - options.initialBook.tradeCount;
      if (matched !== lastWindowMatched) {
        logHubPipeline('window', round, book, submittedSwaps);
        lastWindowMatched = matched;
      }
      if (round + offersPerRound - tradedRounds <= windowRounds) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const lagMs = Math.max(0, Math.ceil(performance.now() - dueAt));
    for (let k = 0; k < Math.min(offersPerRound, options.rounds - round); k += 1) roundSubmissionLagMs.push(lagMs);
    // Every user submits from its own Runtime process concurrently; the round
    // is observed when the slowest user Runtime has committed its own frame.
    const laneInputs = [
      ...options.prepared.makerRuntimes.map((lane, index) => {
        const identity = options.prepared.makerIdentities[index]!;
        return {
          lane,
          inputs: withRoundExtraTxs(
            buildLaneRoundOfferInputs([identity], [options.prepared.makerPlans[index]!], round, Math.min(offersPerRound, options.rounds - round)),
            options.extraEntityTxs?.({ lane, identity, round }) ?? [],
          ),
        };
      }),
      ...options.prepared.takerRuntimes.map((lane, index) => {
        const identity = options.prepared.takerIdentities[index]!;
        return {
          lane,
          inputs: withRoundExtraTxs(
            buildLaneRoundOfferInputs([identity], [options.prepared.takerPlans[index]!], round, Math.min(offersPerRound, options.rounds - round)),
            options.extraEntityTxs?.({ lane, identity, round }) ?? [],
          ),
        };
      }),
    ];
    const observed = await Promise.all(laneInputs.map(({ lane, inputs }) =>
      sendObserved(lane.runtime, `prod-load-round-${options.initialFrame.height}-${round + 1}-${lane.laneKey}`, {
        runtimeTxs: [],
        entityInputs: inputs,
      })));
    enqueueAckElapsedMs += Math.max(...observed.map(entry => entry.enqueueAckElapsedMs));
    commandObservedElapsedMs += Math.max(...observed.map(entry => entry.commandObservedElapsedMs));
    const batchOffers = Math.min(offersPerRound, options.rounds - round);
    logHubPipeline(
      'submitted',
      round,
      await readLoadBook(options.hub, options.hubIdentity.entityId),
      (round + batchOffers) * options.swapsPerRound,
    );
  }
  const finalBook = await waitForTradeCount(
    options.hub,
    options.hubIdentity.entityId,
    options.initialBook.tradeCount + options.swapsPerRound * options.rounds,
  );
  return {
    finalBook,
    runtimeInputBatches: Math.ceil(options.rounds / offersPerRound),
    offersPerRound,
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
