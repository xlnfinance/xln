/** Parallel same-j load submission across independently signed Entity/Account lanes. */

import type { RuntimeInput } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import { LIMITS } from '../../../../config/constants';
import type { LoadBookSnapshot } from '../boundary/worker-book-boundary';
import type { LoadIdentity } from '../boundary/worker-boundary';
import { setupParallelLoadLanes } from '../lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import {
  buildIndependentMakerTakerPlan,
  LOAD_BASE_TOKEN_ID,
  LOAD_QUOTE_TOKEN_ID,
} from './worker-same-plan';
import { deriveSameOrderbookPriceBandBounds } from '../../../../entity/tx/handlers/account/orderbook/helpers';
import type { ConnectedRuntime } from '../worker-runtime';
import type { SettlementAccountPair } from '../settlement-reader';

export type ParallelLaneSubmission = Readonly<{
  runtimeInputBatches: number;
  offersPerRound: number;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
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

const collectRoundExtraTxs = (
  build: ParallelLoadRoundExtraTxs | undefined,
  lane: LaneRuntime,
  identity: LoadIdentity,
  firstRound: number,
  batchRounds: number,
): EntityTx[] => {
  if (!build) return [];
  return Array.from({ length: batchRounds }, (_, offset) =>
    build({ lane, identity, round: firstRound + offset })).flat();
};

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

/** Keep a mixed tail from becoming a swap-only one-action RuntimeInput. */
export const resolveLoadBatchRounds = (
  remainingRounds: number,
  actionsPerFrame: 1 | 2 | 3,
): number => {
  if (!Number.isSafeInteger(remainingRounds) || remainingRounds < 1) {
    throw new Error(`PRODUCTION_SWAP_LOAD_BATCH_REMAINDER_INVALID:${remainingRounds}`);
  }
  return actionsPerFrame === 3 && remainingRounds === 4
    ? 2
    : Math.min(actionsPerFrame, remainingRounds);
};

/**
 * Open-loop HLT cannot assume that an earlier order settled before the last
 * wave was admitted. Keep each sovereign Account inside the production
 * dispute-proof bound; scale throughput with more users, never by silently
 * manufacturing offers that Account consensus must reject.
 */
export const assertOpenLoopOfferBudget = (offersPerAccount: number): void => {
  if (!Number.isSafeInteger(offersPerAccount) || offersPerAccount < 1) {
    throw new Error(`HLT_OPEN_LOOP_OFFERS_PER_ACCOUNT_INVALID:${offersPerAccount}`);
  }
  if (offersPerAccount > LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS) {
    throw new Error(
      `HLT_OPEN_LOOP_OFFER_CAP_EXCEEDED:perAccount=${offersPerAccount}:` +
      `cap=${LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS}:increase-users-or-split-settled-windows`,
    );
  }
};

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
  assertOpenLoopOfferBudget(options.rounds);
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
  const entityTxs = input?.entityTxs;
  if (!input || inputs.length !== 1 || !entityTxs) {
    throw new Error('PRODUCTION_SWAP_LOAD_ROUND_INPUT_CARDINALITY');
  }
  return [{ ...input, entityTxs: [...entityTxs, ...extra] }];
};

export const submitPreparedParallelSameLoad = async (options: {
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  swapsPerRound: number;
  rounds: number;
  cadenceMs: number;
  actionsPerFrame?: 1 | 2 | 3;
  prepared: PreparedParallelSameLoad;
  extraEntityTxs?: ParallelLoadRoundExtraTxs;
}): Promise<ParallelLaneSubmission> => {
  const startedAt = performance.now();
  const roundSubmissionLagMs: number[] = [];
  const actionsPerFrame = options.actionsPerFrame ?? 1;
  // Offered load is a stream, not a closed-loop benchmark. One RuntimeInput
  // carries at most three adjacent user actions, the production-realistic
  // Account frame range selected by the owner. Batches remain open-loop: they
  // never wait for Hub progress, Runtime commit, or an earlier Account ACK.
  const pendingWaves: Array<Promise<Readonly<{ elapsedMs: number; error: unknown | null }>>> = [];
  let streamFailure: unknown | null = null;
  let waveIndex = 0;
  for (let firstRound = 0; firstRound < options.rounds;) {
    const batchRounds = resolveLoadBatchRounds(options.rounds - firstRound, actionsPerFrame);
    const dueAt = startedAt + firstRound * options.cadenceMs;
    const remainingMs = dueAt - performance.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, remainingMs));
    if (streamFailure !== null) throw streamFailure;
    const lagMs = Math.max(0, Math.ceil(performance.now() - dueAt));
    roundSubmissionLagMs.push(lagMs);
    const laneInputs = [
      ...options.prepared.makerRuntimes.map((lane, index) => {
        const identity = options.prepared.makerIdentities[index]!;
        return {
          lane,
          inputs: withRoundExtraTxs(
            buildLaneRoundOfferInputs(
              [identity],
              [options.prepared.makerPlans[index]!],
              firstRound,
              batchRounds,
            ),
            collectRoundExtraTxs(options.extraEntityTxs, lane, identity, firstRound, batchRounds),
          ),
        };
      }),
      ...options.prepared.takerRuntimes.map((lane, index) => {
        const identity = options.prepared.takerIdentities[index]!;
        return {
          lane,
          inputs: withRoundExtraTxs(
            buildLaneRoundOfferInputs(
              [identity],
              [options.prepared.takerPlans[index]!],
              firstRound,
              batchRounds,
            ),
            collectRoundExtraTxs(options.extraEntityTxs, lane, identity, firstRound, batchRounds),
          ),
        };
      }),
    ];
    const waveStartedAt = performance.now();
    const wave = queueLaneRuntimeInputWave(waveIndex, laneInputs.map(({ lane, inputs }) => ({
      lane,
      input: {
        runtimeTxs: [],
        entityInputs: inputs,
      },
    })));
    pendingWaves.push(wave.then(
      () => ({ elapsedMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error: null }),
      error => {
        streamFailure ??= error;
        return { elapsedMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error };
      },
    ));
    console.log(
      `[load] stream dispatched wave=${waveIndex} rounds=${firstRound}-${firstRound + batchRounds - 1} ` +
      `submitted=${(firstRound + batchRounds) * options.swapsPerRound} lagMs=${lagMs}`,
    );
    waveIndex += 1;
    firstRound += batchRounds;
  }
  const waveResults = await Promise.all(pendingWaves);
  const failedWave = waveResults.find(result => result.error !== null);
  if (failedWave) throw failedWave.error;
  const ingressAcceptedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
  return {
    runtimeInputBatches: Math.ceil(options.rounds / actionsPerFrame),
    offersPerRound: actionsPerFrame,
    enqueueAckElapsedMs: ingressAcceptedElapsedMs,
    commandObservedElapsedMs: ingressAcceptedElapsedMs,
    roundSubmissionLagMs,
    settlementPairs: [
      ...settlementPairs(options.hubIdentity.entityId, options.prepared.makerIdentities, options.prepared.makerPlans),
      ...settlementPairs(options.hubIdentity.entityId, options.prepared.takerIdentities, options.prepared.takerPlans),
    ],
  };
};
