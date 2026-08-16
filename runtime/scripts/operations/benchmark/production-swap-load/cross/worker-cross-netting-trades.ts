/** Deterministic cross-j trade accumulation. This module never requests rebalance. */

import type { AccountReplica } from '../../../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../../../types/cross-jurisdiction';
import type {
  CrossNettingAccountReplicaSnapshot,
  CrossNettingDirection,
  CrossNettingStateSnapshot,
  CrossNettingTradeEvidence,
} from './cross-netting-report';
import { decodeCommittedCrossRoutes, selectMarketMakerCrossRouteLevel } from './cross-boundary';
import { captureCrossNettingSnapshot } from './worker-cross-snapshot';
import { executeCrossProductionTrade } from './worker-cross-trade';
import { readLoadAccount, type ConnectedRuntime } from '../worker-runtime';

type TradeIdentity = Readonly<{ entityId: string; signerId: string }>;

export type CrossNettingTradeWorkloadOptions = Readonly<{
  hubRuntime: ConnectedRuntime;
  loadRuntime: ConnectedRuntime;
  marketMakerRuntime: ConnectedRuntime;
  bookOwnerEntityId: string;
  hubA: TradeIdentity;
  hubB: TradeIdentity;
  userA: TradeIdentity;
  userB: TradeIdentity;
  marketMakerA: TradeIdentity;
  marketMakerB: TradeIdentity;
  tokenId: number;
  marketMakerLevel: number;
  forwardTrades: number;
  reverseTrades: number;
  orderIdPrefix: string;
  onProgress?: (
    stage: string,
    details: Readonly<Record<string, unknown>>,
  ) => void;
}>;

export type CrossNettingAccumulationResult = Readonly<{
  baseline: CrossNettingStateSnapshot;
  trades: readonly CrossNettingTradeEvidence[];
  accumulated: CrossNettingStateSnapshot;
}>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const ACCUMULATION_CONVERGENCE_TIMEOUT_MS = 120_000;
const ACCUMULATION_CONVERGENCE_POLL_MS = 250;

const validateOptions = (options: CrossNettingTradeWorkloadOptions): void => {
  if (!Number.isSafeInteger(options.tokenId) || options.tokenId < 1) {
    throw new Error(`CROSS_NETTING_WORKLOAD_TOKEN_INVALID:${options.tokenId}`);
  }
  if (!Number.isSafeInteger(options.marketMakerLevel) || options.marketMakerLevel < 1) {
    throw new Error(`CROSS_NETTING_WORKLOAD_LEVEL_INVALID:${options.marketMakerLevel}`);
  }
  for (const [label, count] of [
    ['forward', options.forwardTrades],
    ['reverse', options.reverseTrades],
  ] as const) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`CROSS_NETTING_WORKLOAD_${label.toUpperCase()}_INVALID:${count}`);
    }
  }
  if (options.forwardTrades + options.reverseTrades < 1) {
    throw new Error('CROSS_NETTING_WORKLOAD_EMPTY');
  }
  if (!options.orderIdPrefix.trim()) throw new Error('CROSS_NETTING_WORKLOAD_ORDER_PREFIX_INVALID');
};

const deterministicDirections = (forward: number, reverse: number): CrossNettingDirection[] => [
  ...Array.from({ length: forward }, () => 'A_TO_B' as const),
  ...Array.from({ length: reverse }, () => 'B_TO_A' as const),
];

const readAccount = async (
  runtime: ConnectedRuntime,
  user: TradeIdentity,
  hub: TradeIdentity,
  code: string,
): Promise<AccountReplica> => {
  const account = await readLoadAccount(runtime, user.entityId, hub.entityId);
  if (!account) throw new Error(`${code}_ACCOUNT_MISSING`);
  return account;
};

const readMarketMakerLevel = async (
  runtime: ConnectedRuntime,
  bookOwnerEntityId: string,
  sourceHub: TradeIdentity,
  targetHub: TradeIdentity,
  tokenId: number,
  level: number,
): Promise<CrossJurisdictionSwapRoute> =>
  selectMarketMakerCrossRouteLevel(
    decodeCommittedCrossRoutes(
      await runtime.adapter.read<unknown>(`entity/${bookOwnerEntityId}`, {
        tokenId,
        crossSourceHubEntityId: sourceHub.entityId,
        crossTargetHubEntityId: targetHub.entityId,
      }),
    ),
    sourceHub.entityId,
    targetHub.entityId,
    tokenId,
    level,
  );

const waitForMarketMakerLevel = async (
  runtime: ConnectedRuntime,
  bookOwnerEntityId: string,
  sourceHub: TradeIdentity,
  targetHub: TradeIdentity,
  tokenId: number,
  level: number,
): Promise<CrossJurisdictionSwapRoute> => {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readMarketMakerLevel(
        runtime, bookOwnerEntityId, sourceHub, targetHub, tokenId, level,
      );
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(
    `CROSS_NETTING_MM_LEVEL_NOT_REPUBLISHED:${sourceHub.entityId}:${targetHub.entityId}:${tokenId}:${level}`,
    { cause: lastError },
  );
};

const totalR2C = (snapshot: CrossNettingStateSnapshot): number =>
  snapshot.hubA.currentR2CCount + snapshot.hubA.sentR2CCount + snapshot.hubA.recoveryR2CCount +
  snapshot.hubB.currentR2CCount + snapshot.hubB.sentR2CCount + snapshot.hubB.recoveryR2CCount;

const accountReplicaEqual = (
  left: CrossNettingAccountReplicaSnapshot,
  right: CrossNettingAccountReplicaSnapshot,
): boolean =>
  left.currentHeight === right.currentHeight &&
  left.ondelta === right.ondelta && left.offdelta === right.offdelta &&
  left.collateral === right.collateral && left.leftHold === right.leftHold &&
  left.rightHold === right.rightHold && left.requestedRebalance === right.requestedRebalance &&
  left.requestId === right.requestId && left.requestPolicyVersion === right.requestPolicyVersion &&
  left.requestFeeTokenId === right.requestFeeTokenId && left.requestFeePaid === right.requestFeePaid &&
  left.pullCount === right.pullCount;

const quiescenceBlockers = (snapshot: CrossNettingStateSnapshot): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const userReplicas: ReadonlyArray<readonly [string, string, CrossNettingAccountReplicaSnapshot]> = [
    ['userA', 'owner', snapshot.jurisdictionA.user],
    ['userA', 'hub', snapshot.jurisdictionA.hub],
    ['userB', 'owner', snapshot.jurisdictionB.user],
    ['userB', 'hub', snapshot.jurisdictionB.hub],
  ];
  const marketMakerReplicas: ReadonlyArray<readonly [string, string, CrossNettingAccountReplicaSnapshot]> = [
    ['marketMakerA', 'owner', snapshot.marketMakerA.marketMaker],
    ['marketMakerA', 'hub', snapshot.marketMakerA.hub],
    ['marketMakerB', 'owner', snapshot.marketMakerB.marketMaker],
    ['marketMakerB', 'hub', snapshot.marketMakerB.hub],
  ];
  const userBlockers = userReplicas.flatMap(([account, replica, accountState]) => {
    if (
      accountState.leftHold === '0' && accountState.rightHold === '0' &&
      !accountState.pendingFrame && accountState.pullCount === 0
    ) return [];
    return [{
      account,
      replica,
      leftHold: accountState.leftHold,
      rightHold: accountState.rightHold,
      pendingFrame: accountState.pendingFrame,
      pendingFrameHeight: accountState.pendingFrameHeight,
      pendingFrameTxTypes: accountState.pendingFrameTxTypes,
      pullCount: accountState.pullCount,
      currentHeight: accountState.currentHeight,
    }];
  });
  const marketMakerPendingBlockers = marketMakerReplicas.flatMap(([account, replica, accountState]) =>
    accountState.pendingFrame ? [{
      account,
      replica,
      reason: 'pending-frame',
      currentHeight: accountState.currentHeight,
      pendingFrameHeight: accountState.pendingFrameHeight,
      pendingFrameTxTypes: accountState.pendingFrameTxTypes,
    }] : []
  );
  const replicaBlockers = [
    ['userA', snapshot.jurisdictionA.user, snapshot.jurisdictionA.hub],
    ['userB', snapshot.jurisdictionB.user, snapshot.jurisdictionB.hub],
    ['marketMakerA', snapshot.marketMakerA.marketMaker, snapshot.marketMakerA.hub],
    ['marketMakerB', snapshot.marketMakerB.marketMaker, snapshot.marketMakerB.hub],
  ].flatMap(([account, owner, hub]) =>
    accountReplicaEqual(
      owner as CrossNettingAccountReplicaSnapshot,
      hub as CrossNettingAccountReplicaSnapshot,
    ) ? [] : [{ account, reason: 'replica-divergence' }]
  );
  return [...userBlockers, ...marketMakerPendingBlockers, ...replicaBlockers];
};

const reportBoundaryProgress = (
  options: CrossNettingTradeWorkloadOptions,
  snapshot: CrossNettingStateSnapshot,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  const blockers = quiescenceBlockers(snapshot);
  options.onProgress?.('accumulation-boundary', {
    sequence: snapshot.sequence,
    snapshotStage: snapshot.stage,
    quiescent: blockers.length === 0,
    blockers,
    reserveA: snapshot.hubA.reserve,
    reserveB: snapshot.hubB.reserve,
    r2cOperations: totalR2C(snapshot),
    ...details,
    marketMakerLiquidity: {
      jurisdictionA: {
        leftHold: snapshot.marketMakerA.marketMaker.leftHold,
        rightHold: snapshot.marketMakerA.marketMaker.rightHold,
        pullCount: snapshot.marketMakerA.marketMaker.pullCount,
      },
      jurisdictionB: {
        leftHold: snapshot.marketMakerB.marketMaker.leftHold,
        rightHold: snapshot.marketMakerB.marketMaker.rightHold,
        pullCount: snapshot.marketMakerB.marketMaker.pullCount,
      },
    },
  });
};

const assertAccumulationSafety = (
  baseline: CrossNettingStateSnapshot,
  snapshot: CrossNettingStateSnapshot,
): void => {
  if (snapshot.jurisdictionA.user.requestedRebalance !== '0' ||
      snapshot.jurisdictionB.user.requestedRebalance !== '0' ||
      snapshot.marketMakerA.marketMaker.requestedRebalance !== '0' ||
      snapshot.marketMakerB.marketMaker.requestedRebalance !== '0') {
    throw new Error(`CROSS_NETTING_REBALANCE_STARTED_EARLY:${snapshot.sequence}`);
  }
  if (snapshot.jurisdictionA.user.collateral !== baseline.jurisdictionA.user.collateral ||
      snapshot.jurisdictionB.user.collateral !== baseline.jurisdictionB.user.collateral ||
      snapshot.marketMakerA.marketMaker.collateral !== baseline.marketMakerA.marketMaker.collateral ||
      snapshot.marketMakerB.marketMaker.collateral !== baseline.marketMakerB.marketMaker.collateral ||
      snapshot.hubA.reserve !== baseline.hubA.reserve || snapshot.hubB.reserve !== baseline.hubB.reserve ||
      snapshot.hubA.accountSettledEventCount !== baseline.hubA.accountSettledEventCount ||
      snapshot.hubB.accountSettledEventCount !== baseline.hubB.accountSettledEventCount ||
      totalR2C(snapshot) !== 0) {
    throw new Error(`CROSS_NETTING_PHYSICAL_SETTLEMENT_STARTED_EARLY:${snapshot.sequence}`);
  }
};

const assertAccumulationBoundary = (
  baseline: CrossNettingStateSnapshot,
  candidate: CrossNettingStateSnapshot,
): void => {
  assertAccumulationSafety(baseline, candidate);
  if (quiescenceBlockers(candidate).length > 0) {
    throw new Error(`CROSS_NETTING_ACCUMULATION_NOT_QUIESCENT:${candidate.sequence}`);
  }
};

const snapshot = (
  options: CrossNettingTradeWorkloadOptions,
  stage: 'baseline' | 'post_trade' | 'accumulated',
  sequence: number,
): Promise<CrossNettingStateSnapshot> => captureCrossNettingSnapshot({
  hubRuntime: options.hubRuntime,
  loadRuntime: options.loadRuntime,
  marketMakerRuntime: options.marketMakerRuntime,
  stage,
  sequence,
  tokenId: options.tokenId,
  userA: options.userA,
  hubA: options.hubA,
  userB: options.userB,
  hubB: options.hubB,
  marketMakerA: options.marketMakerA,
  marketMakerB: options.marketMakerB,
});

type MarketMakerReplacement = Readonly<{
  sourceHub: TradeIdentity;
  targetHub: TradeIdentity;
  replacedOrderId: string;
}>;

const waitForAccumulationBoundary = async (
  options: CrossNettingTradeWorkloadOptions,
  baseline: CrossNettingStateSnapshot,
  stage: 'post_trade' | 'accumulated',
  sequence: number,
  replacement?: MarketMakerReplacement,
): Promise<CrossNettingStateSnapshot> => {
  const startedAt = Date.now();
  const deadline = Date.now() + ACCUMULATION_CONVERGENCE_TIMEOUT_MS;
  let lastSnapshot: CrossNettingStateSnapshot | null = null;
  let lastRouteError: unknown;
  let lastQuoteRestored = !replacement;
  let lastReplacementOrderId: string | null = null;
  let lastReciprocalOrderId: string | null = null;
  let lastProgressSignature = '';
  while (Date.now() < deadline) {
    const candidate = await snapshot(options, stage, sequence);
    assertAccumulationSafety(baseline, candidate);
    const blockers = quiescenceBlockers(candidate);
    let replacementOrderId: string | null = null;
    let reciprocalOrderId: string | null = null;
    lastRouteError = undefined;
    if (replacement) {
      try {
        const route = await readMarketMakerLevel(
          options.hubRuntime,
          options.bookOwnerEntityId,
          replacement.sourceHub,
          replacement.targetHub,
          options.tokenId,
          options.marketMakerLevel,
        );
        if (route.orderId !== replacement.replacedOrderId) replacementOrderId = route.orderId;
      } catch (error) {
        lastRouteError = error;
      }
      try {
        const reciprocal = await readMarketMakerLevel(
          options.hubRuntime,
          options.bookOwnerEntityId,
          replacement.targetHub,
          replacement.sourceHub,
          options.tokenId,
          options.marketMakerLevel,
        );
        reciprocalOrderId = reciprocal.orderId;
      } catch (error) {
        lastRouteError ??= error;
      }
    }
    const quoteRestored = !replacement ||
      (replacementOrderId !== null && reciprocalOrderId !== null);
    lastQuoteRestored = quoteRestored;
    lastReplacementOrderId = replacementOrderId;
    lastReciprocalOrderId = reciprocalOrderId;
    const signature = JSON.stringify({
      blockers, quoteRestored, replacementOrderId, reciprocalOrderId,
    });
    if (signature !== lastProgressSignature) {
      reportBoundaryProgress(options, candidate, {
        convergence: 'waiting',
        convergenceElapsedMs: Date.now() - startedAt,
        quoteRestored,
        replacementOrderId,
        reciprocalOrderId,
      });
      lastProgressSignature = signature;
    }
    if (blockers.length === 0 && quoteRestored) {
      assertAccumulationBoundary(baseline, candidate);
      reportBoundaryProgress(options, candidate, {
        convergence: 'complete',
        convergenceElapsedMs: Date.now() - startedAt,
        quoteRestored,
        replacementOrderId,
        reciprocalOrderId,
      });
      return candidate;
    }
    lastSnapshot = candidate;
    await sleep(ACCUMULATION_CONVERGENCE_POLL_MS);
  }
  if (lastSnapshot) {
    reportBoundaryProgress(options, lastSnapshot, {
      convergence: 'timeout',
      convergenceElapsedMs: Date.now() - startedAt,
      quoteRestored: lastQuoteRestored,
      replacementOrderId: lastReplacementOrderId,
      reciprocalOrderId: lastReciprocalOrderId,
      routeError: lastRouteError instanceof Error ? lastRouteError.message : String(lastRouteError ?? ''),
    });
  }
  throw new Error(`CROSS_NETTING_ACCUMULATION_CONVERGENCE_TIMEOUT:${sequence}`, {
    cause: lastRouteError,
  });
};

export const accumulateCrossNettingTrades = async (
  options: CrossNettingTradeWorkloadOptions,
): Promise<CrossNettingAccumulationResult> => {
  validateOptions(options);
  options.onProgress?.('baseline-capture', { sequence: 0 });
  const baseline = await snapshot(options, 'baseline', 0);
  reportBoundaryProgress(options, baseline);
  assertAccumulationBoundary(baseline, baseline);
  const trades: CrossNettingTradeEvidence[] = [];

  for (const [index, direction] of deterministicDirections(
    options.forwardTrades, options.reverseTrades,
  ).entries()) {
    const sequence = index + 1;
    // Taking routes run opposite the resting MM route. An A->B user trade
    // therefore consumes the renewable B->A MM quote slot, and vice versa.
    const aToB = direction === 'A_TO_B';
    options.onProgress?.('trade-start', {
      sequence,
      totalTrades: options.forwardTrades + options.reverseTrades,
      direction,
    });
    const sourceHub = aToB ? options.hubB : options.hubA;
    const targetHub = aToB ? options.hubA : options.hubB;
    const sourceUser = aToB ? options.userB : options.userA;
    const targetUser = aToB ? options.userA : options.userB;
    const marketMakerRoute = await waitForMarketMakerLevel(
      options.hubRuntime, options.bookOwnerEntityId,
      sourceHub, targetHub, options.tokenId, options.marketMakerLevel,
    );
    const [sourceAccount, targetAccount] = await Promise.all([
      readAccount(options.loadRuntime, sourceUser, sourceHub, `CROSS_NETTING_TRADE_${sequence}_SOURCE`),
      readAccount(options.loadRuntime, targetUser, targetHub, `CROSS_NETTING_TRADE_${sequence}_TARGET`),
    ]);
    const orderId = `${options.orderIdPrefix}-${sequence}-${marketMakerRoute.orderId}`;
    const result = await executeCrossProductionTrade({
      hubRuntime: options.hubRuntime,
      loadRuntime: options.loadRuntime,
      marketMakerRoute,
      sourceHub,
      targetHub,
      sourceUser,
      targetUser,
      sourceAccount,
      targetAccount,
      orderId,
      createdAt: Date.now(),
    });
    options.onProgress?.('trade-settled', {
      sequence,
      totalTrades: options.forwardTrades + options.reverseTrades,
      direction,
      orderId,
      filledSourceAmount: result.settled.filledSourceAmount!.toString(),
      filledTargetAmount: result.settled.filledTargetAmount!.toString(),
      economicCompletionElapsedMs: result.economicCompletionElapsedMs,
    });
    const after = await waitForAccumulationBoundary(
      options,
      baseline,
      'post_trade',
      sequence,
      { sourceHub, targetHub, replacedOrderId: marketMakerRoute.orderId },
    );
    trades.push({
      sequence,
      direction,
      orderId,
      sourceRouteStatus: 'settled',
      targetRouteStatus: 'settled',
      filledSourceAmount: result.settled.filledSourceAmount!.toString(),
      filledTargetAmount: result.settled.filledTargetAmount!.toString(),
      economicCompletionElapsedMs: result.economicCompletionElapsedMs,
      after,
    });
  }

  const accumulated = await waitForAccumulationBoundary(
    options, baseline, 'accumulated', trades.length,
  );
  return { baseline, trades, accumulated };
};
