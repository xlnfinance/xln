/** Parallel same-j load submission across independently signed Entity/Account lanes. */

import type { RuntimeInput } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import { LIMITS } from '../../../../config/constants';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { deriveSwapNetAuthorization } from '../../../../account/swap/swap-net-authorization';
import {
  getStaticSwapTokenDimensions,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  getSwapLotScale,
  quoteAmountAtPrice,
} from '../../../../orderbook';
import type { LoadBookSnapshot } from '../boundary/worker-book-boundary';
import type { LoadIdentity } from '../boundary/worker-boundary';
import {
  HLT_FAUCET_AMOUNT,
  setupParallelLoadTraderPopulation,
} from '../lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import {
  buildBalancedExchangePlan,
  buildIndependentMakerTakerPlan,
  buildRealisticExchangePlan,
  LOAD_BASE_TOKEN_ID,
  LOAD_QUOTE_TOKEN_ID,
  requiredReceiveCreditForOffers,
  type RealisticExchangeDistribution,
  type SwapLanePlan,
} from './worker-same-plan';
import { buildPacedOperationSchedule } from './operation-pacer';
import { deriveSameOrderbookPriceBandBounds } from '../../../../entity/tx/handlers/account/orderbook/helpers';
import { readLoadAccount, readLoadBook, type ConnectedRuntime } from '../worker-runtime';
import { assertProductionSwapFullySettled } from '../settlement';
import {
  waitForFullySettledEvidence,
  type SettlementAccountPair,
} from '../settlement-reader';

export type ParallelLaneSubmission = Readonly<{
  runtimeInputBatches: number;
  offersPerRound: number;
  enqueueAckElapsedMs: number;
  sourceDispatchFinishedElapsedMs: number;
  sourceAllAckedElapsedMs: number;
  commandObservedElapsedMs: number;
  roundSubmissionLagMs: readonly number[];
  settlementPairs: readonly SettlementAccountPair[];
}>;

export type RestingTailCancellation = Readonly<{
  cancelledOffers: number;
  enqueueAckElapsedMs: number;
}>;

export type PreparedParallelSameLoad = Readonly<{
  hubEntityId: string;
  traderIdentities: readonly LoadIdentity[];
  traderRuntimes: readonly LaneRuntime[];
  traderPlans: readonly SwapLanePlan[];
  setupTradeCount: number;
  distribution: RealisticExchangeDistribution;
}>;

const ceilDivide = (value: bigint, divisor: bigint): bigint =>
  (value + divisor - 1n) / divisor;

const requireIndex = <T>(values: readonly T[], index: number, code: string): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`${code}:${index}`);
  return value;
};

const buildMakerInventorySeedOffer = (
  hubEntityId: string,
  makerIndex: number,
  requiredBaseAmount: bigint,
  priceTicks: bigint,
): Extract<EntityTx, { type: 'placeSwapOffer' }> => {
  const dimensions = getStaticSwapTokenDimensions(LOAD_QUOTE_TOKEN_ID, LOAD_BASE_TOKEN_ID);
  const baseLot = getSwapLotScale(LOAD_BASE_TOKEN_ID);
  const exactQuoteLots = getSwapExactQuoteLotMultipleAtPriceForDimensions(
    dimensions.wantTokenDecimals,
    dimensions.giveTokenDecimals,
    priceTicks,
  );
  // H1 charges the seed taker 1 bps in the received token. Seed enough gross
  // token-2 that the committed net inventory still covers every maker order.
  const requiredGrossBaseAmount = ceilDivide(requiredBaseAmount * 10_000n, 9_999n);
  const baseLots = ceilDivide(requiredGrossBaseAmount, baseLot);
  const executableLots = ceilDivide(baseLots, exactQuoteLots) * exactQuoteLots;
  const baseAmount = executableLots * baseLot;
  const quoteAmount = quoteAmountAtPrice(
    LOAD_BASE_TOKEN_ID,
    LOAD_QUOTE_TOKEN_ID,
    baseAmount,
    priceTicks,
  );
  const authorization = deriveSwapNetAuthorization(baseAmount, 1);
  if (authorization.minNetReceive < requiredBaseAmount || quoteAmount <= 0n) {
    throw new Error(`HLT_MAKER_INVENTORY_SEED_AMOUNT_INVALID:${makerIndex}`);
  }
  return {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: hubEntityId,
      offerId: `hlt-maker-inventory-${makerIndex + 1}`,
      giveTokenId: LOAD_QUOTE_TOKEN_ID,
      giveAmount: quoteAmount,
      wantTokenId: LOAD_BASE_TOKEN_ID,
      wantAmount: baseAmount,
      ...dimensions,
      ...authorization,
    },
  };
};

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
  plans: readonly SwapLanePlan[],
  round: number,
  offersPerRound = 1,
): RuntimeInput['entityInputs'] => identities.map((identity, index) => {
  const offers = requireIndex(plans, index, 'PRODUCTION_SWAP_LOAD_LANE_PLAN_MISSING')
    .offers.slice(round, round + offersPerRound);
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
  plans: readonly SwapLanePlan[],
  firstRound = 0,
  rounds?: number,
): SettlementAccountPair[] => identities.map((identity, index) => ({
  hubEntityId,
  loadEntityId: identity.entityId,
  offerIds: requireIndex(plans, index, 'PRODUCTION_SWAP_LOAD_SETTLEMENT_PLAN_MISSING').offers
    .slice(firstRound, rounds === undefined ? undefined : firstRound + rounds).map(tx => {
    if (tx.type !== 'placeSwapOffer') throw new Error('PRODUCTION_SWAP_LOAD_SETTLEMENT_OFFER_TYPE_INVALID');
    return tx.data.offerId;
  }),
}));

export const prepareParallelSameLoad = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  marketMaker: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  minimumTradeSize: bigint;
  swapsPerRound: number;
  rounds: number;
  lanes: number;
  laneOffset: number;
  execution: 'peer' | 'realistic' | 'balanced';
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
  const regularMakerAsk = (anchor + bestVisibleAsk) / 2n;
  if (regularMakerAsk <= anchor || regularMakerAsk >= bestVisibleAsk) {
    throw new Error('HLT_REALISTIC_USER_PRICE_LEVELS_MISSING');
  }
  const totalOrdersPerCohort = options.swapsPerRound * options.rounds;
  // Every user is a trader. Strategy assignment changes per round; there are
  // no permanent maker/taker populations or role-specific Runtime hosts.
  const realisticPlans = options.execution === 'realistic'
    ? buildRealisticExchangePlan({
        hubEntityId: options.hubIdentity.entityId,
        offerNamespace: `prod-load-${options.laneOffset}-realistic`,
        rounds: options.rounds,
        lanesPerSide: options.lanes,
        minimumTradeSize: options.minimumTradeSize,
        partialMakerAskPriceTicks: anchor,
        makerAskPriceTicks: regularMakerAsk,
        restingBidPriceTicks: bestBid,
        takerLimitPriceTicks: highestVisibleAsk,
        mmAsks: options.initialBook.executableAsks,
      })
    : null;
  const balancedPlans = options.execution === 'balanced'
    ? buildBalancedExchangePlan({
        hubEntityId: options.hubIdentity.entityId,
        offerNamespace: `prod-load-${options.laneOffset}-balanced`,
        rounds: options.rounds,
        traders: options.lanes * 2,
        minimumTradeSize: options.minimumTradeSize,
        priceTicks: anchor,
      })
    : null;
  const peerPlans = realisticPlans || balancedPlans ? null : buildIndependentMakerTakerPlan(
        options.hubIdentity.entityId,
        `prod-load-${options.laneOffset}`,
        totalOrdersPerCohort,
        options.lanes,
        options.minimumTradeSize,
        anchor,
        anchor,
      );
  const traderPlans = realisticPlans?.traderPlans ?? balancedPlans?.traderPlans ?? [
    ...(peerPlans?.makerPlans ?? []),
    ...(peerPlans?.takerPlans ?? []),
  ];
  if (
    traderPlans.length !== options.lanes * 2 ||
    traderPlans.some(plan => plan.offers.length !== options.rounds) ||
    traderPlans.some(plan => plan.baseCredit <= 0n || plan.quoteCredit <= 0n)
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_PLAN_EMPTY');
  }
  const seedOffers = traderPlans.map((plan, index) => buildMakerInventorySeedOffer(
        options.hubIdentity.entityId,
        index,
        plan.baseCredit,
        highestVisibleAsk,
      ));
  const baseLot = getSwapLotScale(LOAD_BASE_TOKEN_ID);
  const requiredSeedBase = seedOffers.reduce((total, offer) => total + offer.data.wantAmount, 0n);
  const executableSeedBase = options.initialBook.executableAsks
    .filter(ask => ask.priceTicks <= highestVisibleAsk)
    .reduce((total, ask) => total + ask.qtyLots * baseLot, 0n);
  if (requiredSeedBase > executableSeedBase) {
    throw new Error(
      `HLT_TRADER_INVENTORY_DEPTH_INSUFFICIENT:required=${requiredSeedBase}:available=${executableSeedBase}`,
    );
  }
  const traders = await setupParallelLoadTraderPopulation({
    workDir: options.workDir,
    portBase: options.portBase,
    hub: options.hub,
    hubIdentity: options.hubIdentity,
    traders: traderPlans.length,
    laneOffset: options.laneOffset,
    receiveWindows: traderPlans.map((plan, index) => {
      const seed = requireIndex(seedOffers, index, 'HLT_TRADER_INVENTORY_SEED_MISSING');
      return [{
        tokenId: LOAD_BASE_TOKEN_ID,
        amount: requiredReceiveCreditForOffers(
          seed.data.wantAmount,
          LOAD_BASE_TOKEN_ID,
          plan.offers,
        ),
      }, {
        tokenId: LOAD_QUOTE_TOKEN_ID,
        amount: requiredReceiveCreditForOffers(
          HLT_FAUCET_AMOUNT,
          LOAD_QUOTE_TOKEN_ID,
          plan.offers,
        ),
      }];
    }),
  });
  let setupTradeCount = (await readLoadBook(options.hub, options.hubIdentity.entityId)).tradeCount;
  {
    const seedPairs: SettlementAccountPair[] = traders.runtimes.map((lane, index) => ({
      hubEntityId: options.hubIdentity.entityId,
      loadEntityId: lane.identity.entityId,
      offerIds: [requireIndex(seedOffers, index, 'HLT_TRADER_INVENTORY_SEED_MISSING').data.offerId],
    }));
    const seedStartedAt = performance.now();
    await queueLaneRuntimeInputWave(0, traders.runtimes.map((lane, index) => ({
      lane,
      input: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: lane.identity.entityId,
          signerId: lane.identity.signerId,
          entityTxs: [requireIndex(seedOffers, index, 'HLT_TRADER_INVENTORY_SEED_MISSING')],
        }],
      },
    })));
    const seedEvidence = await waitForFullySettledEvidence({
      hub: options.hub,
      load: traders.runtimes.map((lane, index) => ({
        runtime: lane.runtime,
        pairs: [requireIndex(seedPairs, index, 'HLT_TRADER_INVENTORY_PAIR_MISSING')],
      })),
      marketMaker: options.marketMaker,
      hubBookEntityId: options.hubIdentity.entityId,
      pairs: seedPairs,
      tradeCountBefore: setupTradeCount,
      expectedSubmittedOffers: seedOffers.length,
      expectedMatchedTrades: seedOffers.length,
      expectedFullySettledOffers: seedOffers.length,
      cancelledOffers: 0,
      startedAt: seedStartedAt,
    });
    assertProductionSwapFullySettled(seedEvidence);
    setupTradeCount = seedEvidence.tradeCountAfter;
  }
  // Every trader acquires token-2 through a real MM setup fill and retains
  // token-1 from the one canonical faucet, so either side is executable.
  const traderReady = await Promise.all(traders.runtimes.map(async (lane, index) => {
    const account = await readLoadAccount(lane.runtime, lane.identity.entityId, options.hubIdentity.entityId);
    const plan = requireIndex(traderPlans, index, 'HLT_TRADER_PLAN_MISSING');
    const baseDelta = account?.state.deltas.get(LOAD_BASE_TOKEN_ID);
    const quoteDelta = account?.state.deltas.get(LOAD_QUOTE_TOKEN_ID);
    return Boolean(baseDelta && quoteDelta && deriveDelta(
      baseDelta,
      isLeftEntity(lane.identity.entityId, options.hubIdentity.entityId),
    ).outCapacity >= plan.baseCredit && deriveDelta(
      quoteDelta,
      isLeftEntity(lane.identity.entityId, options.hubIdentity.entityId),
    ).outCapacity >= plan.quoteCredit);
  }));
  const unready = traders.runtimes.filter((_lane, index) => !traderReady[index]).map(lane => lane.laneKey);
  if (unready.length > 0) {
    throw new Error(`HLT_SWAP_POPULATION_NOT_READY:missing=${unready.length}:users=${unready.join(',')}`);
  }
  console.log(`[load] swap population ready users=${traders.runtimes.length}`);
  return {
    hubEntityId: options.hubIdentity.entityId,
    traderIdentities: traders.identities,
    traderRuntimes: traders.runtimes,
    traderPlans,
    setupTradeCount,
    distribution: realisticPlans?.distribution ?? balancedPlans?.distribution ?? {
      submittedOffers: totalOrdersPerCohort * 2,
      matchedSubmittedOffers: totalOrdersPerCohort * 2,
      matchedTrades: totalOrdersPerCohort,
      cancelledOffers: 0,
      mmOnlyTakers: 0,
      userOnlyTakers: totalOrdersPerCohort,
      partialUserMakerFills: 0,
      mmResidualTakers: 0,
      sweep2Takers: 0,
      sweep5Takers: 0,
      sweep10Takers: 0,
      sweep20Takers: 0,
    },
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
  if ((options.actionsPerFrame ?? 1) !== 1) {
    throw new Error('HLT_PACED_STREAM_REQUIRES_ONE_ACTION_PER_RUNTIME_INPUT');
  }
  // Offered load is open-loop and evenly paced across sovereign users. It
  // never waits for Hub progress, Runtime commit, or an earlier Account ACK.
  const pendingWaves: Array<Promise<Readonly<{ elapsedMs: number; error: unknown | null }>>> = [];
  let streamFailure: unknown | null = null;
  let waveIndex = 0;
  const trackWave = (
    wave: Promise<void>,
    waveStartedAt: number,
  ): void => {
    pendingWaves.push(wave.then(
      () => ({ elapsedMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error: null }),
      error => {
        streamFailure ??= error;
        return { elapsedMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error };
      },
    ));
  };
  const schedule = buildPacedOperationSchedule({
    participants: options.prepared.traderRuntimes.length,
    rounds: options.rounds,
    cadenceMs: options.cadenceMs,
  });
  for (const operation of schedule) {
    const firstRound = operation.round;
    const batchRounds = 1;
    const dueAt = startedAt + operation.dueOffsetMs;
    const remainingMs = dueAt - performance.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, remainingMs));
    if (streamFailure !== null) throw streamFailure;
    const lagMs = Math.max(0, Math.ceil(performance.now() - dueAt));
    roundSubmissionLagMs.push(lagMs);
    const index = operation.participantIndex;
    const lane = requireIndex(options.prepared.traderRuntimes, index, 'HLT_TRADER_RUNTIME_MISSING');
    const identity = requireIndex(options.prepared.traderIdentities, index, 'HLT_TRADER_IDENTITY_MISSING');
    const traderInputs = [{
        lane,
        inputs: withRoundExtraTxs(
          buildLaneRoundOfferInputs(
            [identity],
            [requireIndex(options.prepared.traderPlans, index, 'HLT_TRADER_PLAN_MISSING')],
            firstRound,
            batchRounds,
          ),
          collectRoundExtraTxs(options.extraEntityTxs, lane, identity, firstRound, batchRounds),
        ),
      }];
    const waveStartedAt = performance.now();
    const queue = (laneInputs: typeof traderInputs): Promise<void> =>
      queueLaneRuntimeInputWave(waveIndex++, laneInputs.map(({ lane, inputs }) => ({
      lane,
      input: {
        runtimeTxs: [],
        entityInputs: inputs,
      },
    })));
    trackWave(queue(traderInputs), waveStartedAt);
    if ((operation.ordinal + 1) % options.prepared.traderRuntimes.length === 0) {
      console.log(
        `[load] stream dispatched=${operation.ordinal + 1}/${schedule.length} ` +
        `round=${firstRound + 1}/${options.rounds} lagMs=${lagMs}`,
      );
    }
  }
  const sourceDispatchFinishedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
  const waveResults = await Promise.all(pendingWaves);
  const failedWave = waveResults.find(result => result.error !== null);
  if (failedWave) throw failedWave.error;
  const sourceLateRound = roundSubmissionLagMs.findIndex(lagMs => lagMs >= options.cadenceMs);
  if (sourceLateRound >= 0) {
    throw new Error(
      `HLT_SOURCE_CADENCE_MISSED:round=${sourceLateRound}:` +
      `lagMs=${roundSubmissionLagMs[sourceLateRound]}:cadenceMs=${options.cadenceMs}`,
    );
  }
  const maxWaveAckMs = Math.max(0, ...waveResults.map(result => result.elapsedMs));
  const sourceAllAckedElapsedMs = Math.max(
    sourceDispatchFinishedElapsedMs,
    Math.ceil(performance.now() - startedAt),
  );
  if (maxWaveAckMs >= options.cadenceMs) {
    throw new Error(`HLT_SOURCE_QUEUE_ACK_MISSED:maxMs=${maxWaveAckMs}:cadenceMs=${options.cadenceMs}`);
  }
  console.log(
    `[load] source asserted users=${options.prepared.traderRuntimes.length} rounds=${options.rounds} ` +
    `actions=${options.prepared.traderRuntimes.length * options.rounds} ` +
    `maxLagMs=${Math.max(0, ...roundSubmissionLagMs)} maxQueueAckMs=${maxWaveAckMs}`,
  );
  return {
    runtimeInputBatches: schedule.length,
    offersPerRound: 1,
    enqueueAckElapsedMs: Math.max(1, maxWaveAckMs),
    sourceDispatchFinishedElapsedMs,
    sourceAllAckedElapsedMs,
    commandObservedElapsedMs: sourceAllAckedElapsedMs,
    roundSubmissionLagMs,
    settlementPairs: settlementPairs(
      options.hubIdentity.entityId,
      options.prepared.traderIdentities,
      options.prepared.traderPlans,
    ),
  };
};

export const cancelPreparedRestingTail = async (
  prepared: PreparedParallelSameLoad,
): Promise<RestingTailCancellation> => {
  const submissions = prepared.traderRuntimes.flatMap((lane, index) => {
    const identity = requireIndex(prepared.traderIdentities, index, 'HLT_TRADER_IDENTITY_MISSING');
    const plan = requireIndex(prepared.traderPlans, index, 'HLT_TRADER_PLAN_MISSING');
    if (plan.cancelledOfferIds.length === 0) return [];
    return [{
      lane,
      input: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: identity.entityId,
          signerId: identity.signerId,
          entityTxs: plan.cancelledOfferIds.map(offerId => ({
            type: 'proposeCancelSwap' as const,
            data: { counterpartyEntityId: prepared.hubEntityId, offerId },
          })),
        }],
      },
    }];
  });
  const cancelledOffers = submissions.reduce(
    (sum, submission) => sum + (submission.input.entityInputs[0]?.entityTxs.length ?? 0),
    0,
  );
  if (cancelledOffers !== prepared.distribution.cancelledOffers) {
    throw new Error(`HLT_RESTING_TAIL_COUNT_MISMATCH:${cancelledOffers}:${prepared.distribution.cancelledOffers}`);
  }
  if (submissions.length === 0) return { cancelledOffers: 0, enqueueAckElapsedMs: 0 };
  const startedAt = performance.now();
  await queueLaneRuntimeInputWave(0, submissions);
  return {
    cancelledOffers,
    enqueueAckElapsedMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
  };
};
