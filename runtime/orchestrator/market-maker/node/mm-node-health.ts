#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
buildDefaultEntitySwapPairs
} from '../../../account/utils';
import { LIMITS } from '../../../config/constants';
import { crossJurisdictionBookOwnerRef } from '../../../extensions/cross-j/orderbook';
import { deriveCanonicalCrossJurisdictionMarket } from '../../../extensions/cross-j/market';
import { hasCrossJurisdictionBookOrder } from '../../../orderbook/cross-j';
import { compareStableText,safeStringify } from '../../../protocol/serialization';
import {
submitCrossJurisdictionIntent
} from '../../../runtime';
import { computeCanonicalEntityHashesFromEnv } from '../../../storage/canonical-hash';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { RuntimeReplica } from '../../../runtime/types';
import type { SwapOffer } from '../../../types/account';
import {
HUB_REQUIRED_TOKEN_COUNT,
getAccountReplica,
getBootstrapCreditAmount,
getCreditGrantedByEntity,
getEntityOutCapacity,
getEntityReplicaById,
hasCommittedAccountState,
hasPairMutualCredit,
isAccountWriteLaneIdle
} from '../../mesh/mesh-common';
import {
buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes
} from './mm-bootstrap-progress';

import {
HubProfile,
MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK,
MARKET_MAKER_CROSS_OFFERS_PER_DIRECTED_ROUTE,
MARKET_MAKER_LEVELS_PER_SIDE,
MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
MarketMakerAccountBlocker,
MarketMakerConnectivityBudget,
MarketMakerCrossRouteBlocker,
MarketMakerEntityContext,
MarketMakerHealth,
MarketMakerOfferSpec,
MarketMakerTokenIdsByContext,
buildMarketMakerCrossOfferSpecs,
buildMarketMakerCrossTokenPairs,
buildMarketMakerOfferSpecs,
collectOfferIdsForAccount,
collectPendingCrossRequestOrderIds,
consumeExpiredBootstrapIntentAttempt,
countCommittedMarketMakerOffersForHub,
countCommittedMarketMakerOffersForHubPair,
countCrossPairCoverageGaps,
countCrossSpecBootstrapProgress,
countCrossSpecBootstrapProgressByPair,
countCrossSpecVisibleOffersByPair,
emitMarketMakerBootstrapDebugEvent,
ensureMarketMakerHubConnectivity,
getCommittedSourceAccountCrossOffer,
getMarketMakerOfferLevel,
getMarketMakerRuntimeBacklogSnapshot,
getMarketMakerTokenIds,
hasCrossRouteRegistered,
hasCrossSpecBootstrapProgress,
hasFinalizedMarketMakerCrossOffer,
hasMarketMakerCrossOffer,
hasMarketMakerRuntimeBacklog,
hubRoleName,
normalizeEntityRef,
normalizePositiveTokenIds,
sameJurisdiction,
yieldMarketMakerApi,
} from './mm-node-core';

type MarketMakerCrossBootstrapWaveDebug = {
  direction: string;
  sourceHubEntityId?: string;
  candidateCount?: number;
  coverageGaps?: number;
  progress?: number;
  selectedCount?: number;
  desiredOffers?: number;
  groupedSourceHubs?: number;
  groupedTargetHubs?: number;
  side?: 'source' | 'target';
  sourceHubs?: number;
  targetHubs?: number;
  enqueuedEntityInputs?: number;
  enqueuedEntityTxs?: number;
  durationMs?: number;
  remainingNewOffers?: number;
  remainingSourceHubGroups?: number;
};

const emitMarketMakerCrossBootstrapWaveEvent = (
  event: string,
  fields: MarketMakerCrossBootstrapWaveDebug,
): void => {
  emitMarketMakerBootstrapDebugEvent(event, {
    stage: 'bootstrap-cross',
    ...fields,
  });
};

type MarketMakerCrossHealthPairExpectation = {
  bookOwnerEntityId: string;
  sourceTokenIds: number[];
  targetTokenIds: number[];
};

type MarketMakerCrossHealthRouteGroup = {
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceMmEntityId: string;
  targetMmEntityId: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  expectedPairs: Map<string, MarketMakerCrossHealthPairExpectation>;
  specs: MarketMakerOfferSpec[];
};

type MarketMakerCrossPlanSummary = {
  applicable: boolean;
  expectedJobs: number;
  expectedRoutes: number;
  expectedOffersPerRoute: number;
  expectedOffersPerPair: number;
};

const describeMarketMakerAccountBlocker = (
  env: RuntimeReplica,
  role: MarketMakerCrossRouteBlocker['role'],
  entityId: string,
  counterpartyEntityId: string,
): MarketMakerCrossRouteBlocker | null => {
  const account = getAccountReplica(env, entityId, counterpartyEntityId);
  const status = account ? String(account.status || 'active') : null;
  const currentHeight = account ? Number(account.currentHeight ?? 0) : null;
  const pendingFrame = Boolean(account?.pendingFrame);
  const mempoolLength = Number(account?.mempool?.length || 0);
  let reason: MarketMakerCrossRouteBlocker['reason'] | null = null;
  if (!account) reason = 'missing-account';
  else if (status !== 'active') reason = 'inactive-account';
  else if (Number(currentHeight ?? 0) <= 0) reason = 'height-zero';
  if (!reason) return null;
  return {
    role,
    entityId,
    counterpartyEntityId,
    reason,
    status,
    currentHeight,
    pendingFrame,
    pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
    mempoolLength,
    swapOffers: Number(account?.state.swapOffers?.size || 0),
  };
};

export const describeMarketMakerSameHubBlocker = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyEntityId: string,
): MarketMakerAccountBlocker | null => {
  const account = getAccountReplica(env, entityId, counterpartyEntityId);
  const status = account ? String(account.status || 'active') : null;
  const currentHeight = account ? Number(account.currentHeight ?? 0) : null;
  const pendingFrame = Boolean(account?.pendingFrame);
  const mempoolLength = Number(account?.mempool?.length || 0);
  let reason: MarketMakerAccountBlocker['reason'] | null = null;
  if (!account) reason = 'missing-account';
  else if (status !== 'active') reason = 'inactive-account';
  else if (Number(currentHeight ?? 0) <= 0) reason = 'height-zero';
  if (!reason) return null;
  return {
    entityId,
    counterpartyEntityId,
    reason,
    status,
    currentHeight,
    pendingFrame,
    pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
    mempoolLength,
    swapOffers: Number(account?.state.swapOffers?.size || 0),
  };
};

const buildExpectedMarketMakerCrossRouteGroups = (
  env: RuntimeReplica,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): Map<string, MarketMakerCrossHealthRouteGroup> => {
  const groups = new Map<string, MarketMakerCrossHealthRouteGroup>();
  for (const sourceContext of contexts) {
    const sourceJurisdictionRef = sourceContext.jurisdictionRef;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    if (!sourceJurisdictionRef || sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    for (const targetContext of contexts) {
      const targetJurisdictionRef = targetContext.jurisdictionRef;
      if (
        sourceContext.entityId === targetContext.entityId ||
        sameJurisdiction(sourceContext, targetContext) ||
        !targetJurisdictionRef
      ) {
        continue;
      }
      const targetTokenIds = getMarketMakerTokenIds(tokenIdsByContext, targetContext);
      if (targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;

      for (const spec of buildMarketMakerCrossOfferSpecs(
        env,
        sourceContext,
        targetContext,
        sourceHubs,
        targetHubs,
        sourceTokenIds,
        targetTokenIds,
      )) {
        const route = spec.crossJurisdiction;
        if (!route) continue;
        const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
        const targetHubEntityId = normalizeEntityRef(route.target.entityId);
        if (!sourceHubEntityId || !targetHubEntityId) continue;
        const key = `${sourceContext.entityId}:${targetContext.entityId}:${sourceHubEntityId}:${targetHubEntityId}`;
        const group = groups.get(key) ?? {
          sourceJurisdiction: sourceContext.jurisdictionName,
          targetJurisdiction: targetContext.jurisdictionName,
          sourceMmEntityId: sourceContext.entityId,
          targetMmEntityId: targetContext.entityId,
          sourceHubEntityId,
          targetHubEntityId,
          expectedPairs: new Map<string, MarketMakerCrossHealthPairExpectation>(),
          specs: [],
        };
        const expected = group.expectedPairs.get(spec.pairId) ?? {
          bookOwnerEntityId: normalizeEntityRef(crossJurisdictionBookOwnerRef(route)),
          sourceTokenIds: [],
          targetTokenIds: [],
        };
        const bookOwnerEntityId = normalizeEntityRef(crossJurisdictionBookOwnerRef(route));
        if (!bookOwnerEntityId || expected.bookOwnerEntityId !== bookOwnerEntityId) {
          // A venue has one authoritative orderbook owner. Accepting mixed
          // owners here would let internal Account completeness mask a public
          // split-brain book that no client can read atomically.
          throw new Error(
            `MARKET_MAKER_CROSS_BOOK_OWNER_AMBIGUOUS:pair=${spec.pairId}:` +
            `current=${expected.bookOwnerEntityId || 'missing'}:next=${bookOwnerEntityId || 'missing'}`,
          );
        }
        expected.sourceTokenIds = normalizePositiveTokenIds([
          ...expected.sourceTokenIds,
          route.source.tokenId,
        ]);
        expected.targetTokenIds = normalizePositiveTokenIds([
          ...expected.targetTokenIds,
          route.target.tokenId,
        ]);
        group.expectedPairs.set(spec.pairId, expected);
        group.specs.push(spec);
        groups.set(key, group);
      }
    }
  }
  return groups;
};

export const buildMarketMakerCrossPlanSummary = (
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): MarketMakerCrossPlanSummary => {
  let expectedJobs = 0;
  let expectedRoutes = 0;
  let maxPairsPerRoute = 0;
  for (const sourceContext of contexts) {
    const sourceJurisdictionRef = sourceContext.jurisdictionRef;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    if (!sourceJurisdictionRef || sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    for (const targetContext of contexts) {
      const targetJurisdictionRef = targetContext.jurisdictionRef;
      if (
        sourceContext.entityId === targetContext.entityId ||
        sameJurisdiction(sourceContext, targetContext) ||
        !targetJurisdictionRef
      ) {
        continue;
      }
      const targetTokenIds = getMarketMakerTokenIds(tokenIdsByContext, targetContext);
      if (targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;
      const targetByBaseName = new Map(targetHubs.map(hub => [hubRoleName(hub), hub] as const));
      let routeGroupsForJob = 0;
      for (const sourceHub of sourceHubs) {
        const targetHub = targetByBaseName.get(hubRoleName(sourceHub));
        if (!targetHub || sameJurisdiction(sourceHub, targetHub)) continue;
        routeGroupsForJob += 1;
      }
      if (routeGroupsForJob === 0) continue;
      expectedJobs += 1;
      expectedRoutes += routeGroupsForJob;
      maxPairsPerRoute = Math.max(
        maxPairsPerRoute,
        buildMarketMakerCrossTokenPairs(sourceTokenIds, targetTokenIds).length,
      );
    }
  }
  const expectedOffersPerPair = expectedRoutes > 0 ? MARKET_MAKER_LEVELS_PER_SIDE : 0;
  return {
    applicable: expectedRoutes > 0,
    expectedJobs,
    expectedRoutes,
    expectedOffersPerRoute: Math.min(
      MARKET_MAKER_CROSS_OFFERS_PER_DIRECTED_ROUTE,
      maxPairsPerRoute * expectedOffersPerPair,
    ),
    expectedOffersPerPair,
  };
};

export const buildMarketMakerCrossHealth = (
  env: RuntimeReplica,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): MarketMakerHealth['cross'] => {
  const routeGroups = buildExpectedMarketMakerCrossRouteGroups(env, contexts, visibleHubs, tokenIdsByContext);

  const expectedRouteCount = routeGroups.size;
  const routes = Array.from(routeGroups.values()).map((group) => {
    const expectedByPair = new Map<string, MarketMakerOfferSpec[]>();
    for (const spec of group.specs) {
      const pairSpecs = expectedByPair.get(spec.pairId) ?? [];
      pairSpecs.push(spec);
      expectedByPair.set(spec.pairId, pairSpecs);
    }
    const pairIds = Array.from(new Set([...group.expectedPairs.keys(), ...expectedByPair.keys()]));
    const pairs = pairIds
      .map((pairId) => {
        const specs = expectedByPair.get(pairId) ?? [];
        const expected = group.expectedPairs.get(pairId) ?? null;
        const offers = specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
        const expectedOffers = specs.length;
        // Each directional cross-j offer sells its source asset. Canonical
        // market orientation therefore decides which public side it owns:
        // source=base is an ask, source=quote is a bid. Keep both counts in
        // health so readiness proves the signed directional topology instead
        // of inventing symmetric liquidity for one-way markets.
        const expectedAskOffers = specs.filter(spec =>
          spec.crossJurisdiction && deriveCanonicalCrossJurisdictionMarket(spec.crossJurisdiction).sourceIsBase
        ).length;
        const expectedBidOffers = expectedOffers - expectedAskOffers;
        const sourceTokenIds = expected?.sourceTokenIds?.length
          ? expected.sourceTokenIds
          : normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.source.tokenId ?? 0));
        const targetTokenIds = expected?.targetTokenIds?.length
          ? expected.targetTokenIds
          : normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.target.tokenId ?? 0));
        return {
          pairId,
          bookOwnerEntityId: expected?.bookOwnerEntityId ?? '',
          offers,
          ready: expectedOffers > 0 && offers > 0,
          depthReady: expectedOffers > 0 && offers === expectedOffers,
          expectedOffers,
          expectedBidOffers,
          expectedAskOffers,
          sourceTokenIds,
          targetTokenIds,
        };
      })
      .sort((left, right) => compareStableText(left.pairId, right.pairId));
    const offers = group.specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
    const expectedOffers = pairs.reduce((sum, pair) => sum + pair.expectedOffers, 0);
    const blockers = [
      describeMarketMakerAccountBlocker(env, 'source-mm-hub', group.sourceMmEntityId, group.sourceHubEntityId),
      describeMarketMakerAccountBlocker(env, 'target-mm-hub', group.targetMmEntityId, group.targetHubEntityId),
    ].filter((blocker): blocker is MarketMakerCrossRouteBlocker => Boolean(blocker));
    return {
      sourceJurisdiction: group.sourceJurisdiction,
      targetJurisdiction: group.targetJurisdiction,
      sourceMmEntityId: group.sourceMmEntityId,
      targetMmEntityId: group.targetMmEntityId,
      sourceHubEntityId: group.sourceHubEntityId,
      targetHubEntityId: group.targetHubEntityId,
      offers,
      ready: pairs.length > 0 && pairs.every(pair => pair.ready) && blockers.length === 0,
      depthReady: expectedOffers > 0 && offers === expectedOffers && pairs.every(pair => pair.depthReady),
      blockers,
      pairs,
    };
  }).sort((left, right) =>
    compareStableText(left.sourceJurisdiction, right.sourceJurisdiction) ||
    compareStableText(left.targetJurisdiction, right.targetJurisdiction) ||
    compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
    compareStableText(left.targetHubEntityId, right.targetHubEntityId),
  );

  const expectedOffersPerRoute = expectedRouteCount > 0
    ? Math.max(0, ...Array.from(routeGroups.values()).map(group =>
        group.specs.length,
      ))
    : 0;
  const expectedOffersPerPair = expectedRouteCount > 0 ? Math.max(0, ...Array.from(routeGroups.values()).flatMap((group) => {
    const counts = new Map<string, number>();
    for (const spec of group.specs) counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
    return Array.from(counts.values());
  })) : 0;

  return {
    applicable: expectedRouteCount > 0,
    ok: expectedRouteCount === 0 || (routes.length >= expectedRouteCount && routes.every(route => route.depthReady)),
    expectedRoutes: expectedRouteCount,
    expectedOffersPerRoute,
    expectedOffersPerPair,
    routeCount: routes.length,
    routes,
  };
};

const getCrossRouteStatus = (
  env: RuntimeReplica,
  entityId: string,
  orderId: string,
): string | null => {
  const route = getEntityReplicaById(env, entityId)?.state?.crossJurisdictionSwaps?.get(orderId);
  return route?.status ? String(route.status) : null;
};

const hasCrossBookOrder = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const bookOwner = bookOwnerEntityId ? getEntityReplicaById(env, bookOwnerEntityId)?.state : null;
  return Boolean(bookOwner && hasCrossJurisdictionBookOrder(bookOwner, route));
};

export const buildMarketMakerCrossDebugSummary = (
  env: RuntimeReplica,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
) => Array.from(buildExpectedMarketMakerCrossRouteGroups(env, contexts, visibleHubs, tokenIdsByContext).values())
  .map((group) => {
    const finalized = group.specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
    const visible = group.specs.filter(spec => hasMarketMakerCrossOffer(env, spec)).length;
    const sourceRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.source.entityId, route.orderId) : false;
    }).length;
    const sourceHubRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId) : false;
    }).length;
    const targetHubRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.target.entityId, route.orderId) : false;
    }).length;
    const targetRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.target.counterpartyEntityId, route.orderId) : false;
    }).length;
    const bookOrders = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossBookOrder(env, route) : false;
    }).length;
    const missingFinalized = group.specs
      .filter(spec => !hasFinalizedMarketMakerCrossOffer(env, spec))
      .slice(0, 8)
      .map((spec) => {
        const route = spec.crossJurisdiction!;
        return {
          orderId: route.orderId,
          pairId: spec.pairId,
          sourceStatus: getCrossRouteStatus(env, route.source.entityId, route.orderId),
          sourceHubStatus: getCrossRouteStatus(env, route.source.counterpartyEntityId, route.orderId),
          targetHubStatus: getCrossRouteStatus(env, route.target.entityId, route.orderId),
          targetStatus: getCrossRouteStatus(env, route.target.counterpartyEntityId, route.orderId),
          bookOrder: hasCrossBookOrder(env, route),
        };
      });
    return {
      sourceJurisdiction: group.sourceJurisdiction,
      targetJurisdiction: group.targetJurisdiction,
      sourceHubEntityId: group.sourceHubEntityId,
      targetHubEntityId: group.targetHubEntityId,
      expected: group.specs.length,
      finalized,
      visible,
      sourceRoutes,
      sourceHubRoutes,
      targetHubRoutes,
      targetRoutes,
      bookOrders,
      missingFinalized,
    };
  })
  .sort((left, right) =>
    compareStableText(left.sourceJurisdiction, right.sourceJurisdiction) ||
    compareStableText(left.targetJurisdiction, right.targetJurisdiction) ||
    compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
    compareStableText(left.targetHubEntityId, right.targetHubEntityId),
  );

export const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth['cross'] => ({
  applicable,
  ok: !applicable,
  expectedRoutes: 0,
  expectedOffersPerRoute: 0,
  expectedOffersPerPair: 0,
  routeCount: 0,
  routes: [],
});

export const buildPlannedMarketMakerCrossHealth = (plan: MarketMakerCrossPlanSummary): MarketMakerHealth['cross'] => ({
  applicable: plan.applicable,
  ok: !plan.applicable,
  expectedRoutes: plan.expectedRoutes,
  expectedOffersPerRoute: plan.expectedOffersPerRoute,
  expectedOffersPerPair: plan.expectedOffersPerPair,
  routeCount: plan.expectedRoutes,
  routes: [],
});

type PendingCrossRequestLookup = (entityId: string) => Set<string>;

type CrossQuoteMaintenanceContext = {
  env: RuntimeReplica;
  sourceContext: MarketMakerEntityContext;
  targetContext: MarketMakerEntityContext;
  sourceHubs: HubProfile[];
  targetHubs: HubProfile[];
  sourceTokenIds: number[];
  targetTokenIds: number[];
  maxOffersPerAccount: number;
  maxNewOffersTotal: number;
  shouldContinue: () => boolean;
  maxSourceHubGroups: number;
  direction: string;
  startedAt: number;
  /**
   * offerId -> attempt timestamp (ms). A cross-j offerId is stable for a whole
   * MARKET_MAKER_CROSS_EXPIRY_MS generation, so this must expire (see
   * MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS) rather than blacklist forever: a
   * permanent Set here means one rejected/stale attempt starves that book slot
   * for the rest of the run, because no durable progress was ever recorded for
   * `hasCrossSpecBootstrapProgress` to find.
   */
  attemptedBootstrapIntentOrderIds: Map<string, number>;
};

const createPendingCrossRequestLookup = (env: RuntimeReplica): PendingCrossRequestLookup => {
  const cache = new Map<string, Set<string>>();
  return (entityId: string): Set<string> => {
    const normalizedEntityId = normalizeEntityRef(entityId);
    const cached = cache.get(normalizedEntityId);
    if (cached) return cached;
    const ids = collectPendingCrossRequestOrderIds(env, normalizedEntityId);
    cache.set(normalizedEntityId, ids);
    return ids;
  };
};

const selectEligibleCrossOfferSpecs = (
  context: CrossQuoteMaintenanceContext,
  specs: MarketMakerOfferSpec[],
  getPendingCrossRequestOrderIds: PendingCrossRequestLookup,
  excludedOfferIds?: ReadonlySet<string>,
): MarketMakerOfferSpec[] => {
  const { env, sourceContext, targetContext, attemptedBootstrapIntentOrderIds } = context;
  const visibleByPair = countCrossSpecVisibleOffersByPair(env, specs);
  const progressByPair = countCrossSpecBootstrapProgressByPair(env, specs, getPendingCrossRequestOrderIds);
  return specs
    .filter(spec => {
      const route = spec.crossJurisdiction;
      if (!route) return false;
      if (excludedOfferIds?.has(spec.offerId)) return false;
      if (
        excludedOfferIds &&
        consumeExpiredBootstrapIntentAttempt(attemptedBootstrapIntentOrderIds, spec.offerId)
      ) return false;
      if (hasCrossSpecBootstrapProgress(env, spec, getPendingCrossRequestOrderIds)) return false;
      const targetAccount = getAccountReplica(env, targetContext.entityId, route.target.entityId);
      if (!targetAccount || String(targetAccount.status || 'active') !== 'active') return false;
      if (!isAccountWriteLaneIdle(targetAccount)) return false;
      return (
        !hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId) &&
        !getPendingCrossRequestOrderIds(route.source.entityId).has(route.orderId) &&
        hasPairMutualCredit(
          env,
          sourceContext.entityId,
          route.source.counterpartyEntityId,
          route.source.tokenId,
          route.source.amount,
        ) &&
        hasPairMutualCredit(
          env,
          targetContext.entityId,
          route.target.entityId,
          route.target.tokenId,
          route.target.amount,
        )
      );
    })
    .sort(
      (left, right) =>
        (visibleByPair.get(left.pairId) || 0) - (visibleByPair.get(right.pairId) || 0) ||
        (progressByPair.get(left.pairId) || 0) - (progressByPair.get(right.pairId) || 0) ||
        getMarketMakerOfferLevel(left) - getMarketMakerOfferLevel(right) ||
        compareStableText(left.pairId, right.pairId) ||
        compareStableText(left.offerId, right.offerId),
    );
};

const maintainBootstrapCrossQuotes = async (
  context: CrossQuoteMaintenanceContext,
): Promise<boolean> => {
  const {
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
    maxOffersPerAccount,
    maxNewOffersTotal,
    maxSourceHubGroups,
    shouldContinue,
    direction,
    startedAt,
    attemptedBootstrapIntentOrderIds,
  } = context;
  const getPendingCrossRequestOrderIds = createPendingCrossRequestLookup(env);
  let submittedIntentCount = 0;
  let desiredOffersSeen = 0;
  let remainingNewOffers = Math.max(1, Math.floor(maxNewOffersTotal));
  let remainingSourceHubGroups = Math.max(1, Math.floor(maxSourceHubGroups));
  const sortedTargetHubs = [...targetHubs].sort((left, right) => compareStableText(left.entityId, right.entityId));
  const orderedSourceHubs = [...sourceHubs].sort((left, right) => compareStableText(left.entityId, right.entityId));

  emitMarketMakerCrossBootstrapWaveEvent('cross-wave-start', {
    direction,
    groupedSourceHubs: orderedSourceHubs.length,
    groupedTargetHubs: sortedTargetHubs.length,
    remainingNewOffers,
    remainingSourceHubGroups,
  });

  for (const sourceHub of orderedSourceHubs) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    if (remainingNewOffers <= 0 || remainingSourceHubGroups <= 0) break;
    const sourceHubEntityId = sourceHub.entityId;
    const account = getAccountReplica(env, sourceContext.entityId, sourceHubEntityId);
    if (!account || String(account.status || 'active') !== 'active' || !isAccountWriteLaneIdle(account)) continue;
    const sourceHubSpecs = buildMarketMakerCrossOfferSpecs(
      env,
      sourceContext,
      targetContext,
      [sourceHub],
      sortedTargetHubs,
      sourceTokenIds,
      targetTokenIds,
    );
    if (sourceHubSpecs.length === 0) continue;
    const coverageGaps = countCrossPairCoverageGaps(env, sourceHubSpecs);
    const progress = countCrossSpecBootstrapProgress(env, sourceHubSpecs, getPendingCrossRequestOrderIds);
    const existingOfferIds = collectOfferIdsForAccount(account);
    const perAccountLimit = Math.max(1, Math.floor(maxOffersPerAccount));
    let selectedForSourceHub = 0;
    let candidateCount = 0;
    const specsByTargetHub = new Map<string, MarketMakerOfferSpec[]>();
    for (const spec of sourceHubSpecs) {
      const route = spec.crossJurisdiction;
      if (!route) continue;
      const targetAccount = getAccountReplica(env, targetContext.entityId, route.target.entityId);
      if (!targetAccount || String(targetAccount.status || 'active') !== 'active') continue;
      if (!isAccountWriteLaneIdle(targetAccount)) continue;
      desiredOffersSeen += 1;
      const targetHubEntityId = normalizeEntityRef(route.target.entityId);
      const targetSpecs = specsByTargetHub.get(targetHubEntityId) ?? [];
      targetSpecs.push(spec);
      specsByTargetHub.set(targetHubEntityId, targetSpecs);
    }
    for (const [, targetSpecs] of [...specsByTargetHub.entries()].sort(
      (left, right) => compareStableText(left[0], right[0]),
    )) {
      await yieldMarketMakerApi();
      if (!shouldContinue()) return false;
      if (remainingNewOffers <= 0 || selectedForSourceHub >= perAccountLimit) break;
      const allowedNewOffers = Math.min(
        perAccountLimit - selectedForSourceHub,
        Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size),
        remainingNewOffers,
      );
      if (allowedNewOffers <= 0) continue;
      const candidates = selectEligibleCrossOfferSpecs(
        context,
        targetSpecs,
        getPendingCrossRequestOrderIds,
        existingOfferIds,
      );
      candidateCount += candidates.length;
      for (const spec of candidates.slice(0, allowedNewOffers)) {
        await submitCrossJurisdictionIntent(env, spec.crossJurisdiction!);
        attemptedBootstrapIntentOrderIds.set(spec.offerId, Date.now());
        existingOfferIds.add(spec.offerId);
        submittedIntentCount += 1;
        selectedForSourceHub += 1;
        remainingNewOffers -= 1;
      }
    }
    const wave = {
      direction,
      sourceHubEntityId,
      candidateCount,
      coverageGaps,
      progress,
      remainingNewOffers,
      remainingSourceHubGroups,
      selectedCount: selectedForSourceHub,
      durationMs: Date.now() - startedAt,
    };
    emitMarketMakerCrossBootstrapWaveEvent('cross-wave-source-hub', wave);
    if (selectedForSourceHub > 0) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-select', wave);
      remainingSourceHubGroups -= 1;
    }
  }
  return desiredOffersSeen > 0 && submittedIntentCount > 0;
};

const maintainSteadyCrossQuotes = async (
  context: CrossQuoteMaintenanceContext,
): Promise<boolean> => {
  const {
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
    maxOffersPerAccount,
    maxNewOffersTotal,
    maxSourceHubGroups,
    shouldContinue,
  } = context;
  const desiredOffers = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
  );
  if (desiredOffers.length === 0) return false;
  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const specs = grouped.get(spec.hubEntityId) ?? [];
    specs.push(spec);
    grouped.set(spec.hubEntityId, specs);
  }
  const getPendingCrossRequestOrderIds = createPendingCrossRequestLookup(env);
  const groupedEntries = [...grouped.entries()].sort(
    (left, right) =>
      countCrossPairCoverageGaps(env, right[1]) - countCrossPairCoverageGaps(env, left[1]) ||
      countCrossSpecBootstrapProgress(env, left[1], getPendingCrossRequestOrderIds) -
        countCrossSpecBootstrapProgress(env, right[1], getPendingCrossRequestOrderIds) ||
      compareStableText(left[0], right[0]),
  );
  let submittedIntentCount = 0;
  let remainingNewOffers = Math.max(1, Math.floor(maxNewOffersTotal));
  let remainingSourceHubGroups = Math.max(1, Math.floor(maxSourceHubGroups));
  for (const [sourceHubEntityId, specs] of groupedEntries) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    const account = getAccountReplica(env, sourceContext.entityId, sourceHubEntityId);
    if (!account || String(account.status || 'active') !== 'active' || !isAccountWriteLaneIdle(account)) continue;
    const existingOfferIds = collectOfferIdsForAccount(account);
    const allowedNewOffers = Math.min(
      Math.max(1, Math.floor(maxOffersPerAccount)),
      Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size),
      remainingNewOffers,
    );
    if (allowedNewOffers <= 0) continue;
    const selected = selectEligibleCrossOfferSpecs(context, specs, getPendingCrossRequestOrderIds).slice(
      0,
      allowedNewOffers,
    );
    for (const spec of selected) {
      await submitCrossJurisdictionIntent(env, spec.crossJurisdiction!);
      submittedIntentCount += 1;
    }
    remainingNewOffers -= selected.length;
    if (selected.length > 0) remainingSourceHubGroups -= 1;
    if (remainingSourceHubGroups <= 0) break;
  }
  return submittedIntentCount > 0;
};

export const maintainMarketMakerCrossQuotes = async (
  env: RuntimeReplica,
  sourceContext: MarketMakerEntityContext,
  targetContext: MarketMakerEntityContext,
  sourceHubs: HubProfile[],
  targetHubs: HubProfile[],
  sourceTokenIds: number[],
  targetTokenIds: number[],
  maxOffersPerAccount = Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
  maxNewOffersTotal = Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
  connectivityBudget: MarketMakerConnectivityBudget = { remainingTxs: MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK },
  shouldContinue: () => boolean = () => true,
  maxSourceHubGroups = Number.MAX_SAFE_INTEGER,
  emitBootstrapWaveEvents = false,
  attemptedBootstrapIntentOrderIds: Map<string, number> = new Map(),
): Promise<boolean> => {
  const startedAt = Date.now();
  const direction = `${sourceContext.jurisdictionName}->${targetContext.jurisdictionName}`;
  const maintenanceContext: CrossQuoteMaintenanceContext = {
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
    maxOffersPerAccount,
    maxNewOffersTotal,
    shouldContinue,
    maxSourceHubGroups,
    direction,
    startedAt,
    attemptedBootstrapIntentOrderIds,
  };
  if (
    sourceHubs.length === 0 ||
    targetHubs.length === 0 ||
    sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
    targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
    sourceContext.entityId === targetContext.entityId ||
    sameJurisdiction(sourceContext, targetContext)
  ) {
    return false;
  }
  if (!shouldContinue()) return false;

  const sourceHubEntityIds = sourceHubs.map(profile => profile.entityId);
  const targetHubEntityIds = targetHubs.map(profile => profile.entityId);
  if (await ensureMarketMakerHubConnectivity(
    env,
    sourceContext.entityId,
    sourceContext.signerId,
    sourceHubEntityIds,
    sourceTokenIds,
    connectivityBudget,
  )) {
    if (emitBootstrapWaveEvents) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-connectivity', {
        direction,
        side: 'source',
        sourceHubs: sourceHubEntityIds.length,
        targetHubs: targetHubEntityIds.length,
      });
    }
    return true;
  }
  if (!shouldContinue()) return false;
  if (await ensureMarketMakerHubConnectivity(
    env,
    targetContext.entityId,
    targetContext.signerId,
    targetHubEntityIds,
    targetTokenIds,
    connectivityBudget,
  )) {
    if (emitBootstrapWaveEvents) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-connectivity', {
        direction,
        side: 'target',
        sourceHubs: sourceHubEntityIds.length,
        targetHubs: targetHubEntityIds.length,
      });
    }
    return true;
  }
  if (!shouldContinue()) return false;

  return emitBootstrapWaveEvents
    ? maintainBootstrapCrossQuotes(maintenanceContext)
    : maintainSteadyCrossQuotes(maintenanceContext);
};

export const getMarketMakerHealth = (
  env: RuntimeReplica,
  mmEntityId: string | null,
  hubEntityIds: string[],
  tokenIds: number[],
  crossOptions?: {
    contexts: MarketMakerEntityContext[];
    visibleHubs: HubProfile[];
    tokenIdsByContext: MarketMakerTokenIdsByContext;
  },
  crossOverride?: MarketMakerHealth['cross'],
): MarketMakerHealth => {
  const pairs = buildDefaultEntitySwapPairs(tokenIds);
  const desiredSpecs = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const cross = crossOverride ?? (crossOptions
    ? buildMarketMakerCrossHealth(env, crossOptions.contexts, crossOptions.visibleHubs, crossOptions.tokenIdsByContext)
    : {
        applicable: false,
        ok: true,
        expectedRoutes: 0,
        expectedOffersPerRoute: 0,
        expectedOffersPerPair: 0,
        routes: [],
      });
  const expectedOffersByHub = new Map<string, number>();
  const expectedOffersByHubPair = new Map<string, number>();
  for (const spec of desiredSpecs) {
    expectedOffersByHub.set(spec.hubEntityId, (expectedOffersByHub.get(spec.hubEntityId) || 0) + 1);
    const pairKey = `${spec.hubEntityId}:${spec.pairId}`;
    expectedOffersByHubPair.set(pairKey, (expectedOffersByHubPair.get(pairKey) || 0) + 1);
  }
  const expectedOffersPerHub = hubEntityIds.reduce(
    (max, hubEntityId) => Math.max(max, expectedOffersByHub.get(hubEntityId) || 0),
    0,
  );
  const expectedOffersPerPair = Math.max(
    ...pairs.map((pair) =>
      Math.max(...hubEntityIds.map((hubEntityId) => expectedOffersByHubPair.get(`${hubEntityId}:${pair.pairId}`) || 0), 0),
    ),
    0,
  );
  if (!mmEntityId || hubEntityIds.length === 0 || expectedOffersPerHub <= 0) {
    return {
      enabled: false,
      ok: false,
      entityId: mmEntityId,
      expectedOffersPerHub: Math.max(0, expectedOffersPerHub),
      expectedOffersPerPair,
      hubs: [],
      cross,
    };
  }

  const hubs = hubEntityIds.map((hubEntityId) => {
    const account = getAccountReplica(env, mmEntityId, hubEntityId);
    const blocker = describeMarketMakerSameHubBlocker(env, mmEntityId, hubEntityId);
    const accountReady = !blocker && hasCommittedAccountState(account);
    const offers = countCommittedMarketMakerOffersForHub(env, mmEntityId, hubEntityId);
    const expectedHubOffers = expectedOffersByHub.get(hubEntityId) || 0;
    const pairHealth = pairs.map((pair) => {
      const pairOffers = countCommittedMarketMakerOffersForHubPair(env, mmEntityId, hubEntityId, pair);
      const expectedPairOffers = expectedOffersByHubPair.get(`${hubEntityId}:${pair.pairId}`) || 0;
      return {
        pairId: pair.pairId,
        offers: pairOffers,
        ready: accountReady && expectedPairOffers > 0 && pairOffers > 0,
        depthReady: accountReady && expectedPairOffers > 0 && pairOffers === expectedPairOffers,
        expectedOffers: expectedPairOffers,
      };
    });
    return {
      hubEntityId,
      offers,
      ready: accountReady && expectedHubOffers > 0 && pairHealth.every((pair) => pair.ready),
      depthReady: accountReady && expectedHubOffers > 0 && offers === expectedHubOffers && pairHealth.every((pair) => pair.depthReady),
      blockers: blocker ? [blocker] : [],
      pairs: pairHealth,
    };
  });

  const connectivity = hubEntityIds.map((hubEntityId) => {
    const account = getAccountReplica(env, mmEntityId, hubEntityId);
    return {
      hubEntityId,
      accountReady: isAccountWriteLaneIdle(account),
      status: account ? String(account.status || 'active') : null,
      currentHeight: account ? Number(account.currentHeight ?? 0) : null,
      mempoolLength: Number(account?.mempool?.length || 0),
      pendingFrame: Boolean(account?.pendingFrame),
      swapOffers: Number(account?.state.swapOffers?.size || 0),
      tokens: tokenIds.map((tokenId) => ({
        tokenId,
        mmGranted: account ? getCreditGrantedByEntity(account, mmEntityId, tokenId).toString() : '0',
        hubGranted: account ? getCreditGrantedByEntity(account, hubEntityId, tokenId).toString() : '0',
        mmOutCapacity: account ? getEntityOutCapacity(account, mmEntityId, tokenId).toString() : '0',
        hubOutCapacity: account ? getEntityOutCapacity(account, hubEntityId, tokenId).toString() : '0',
        mutualReady: hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, getBootstrapCreditAmount(tokenId)),
      })),
    };
  });

  const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);
  const crossDepthReady = !cross.applicable || (
    cross.expectedRoutes > 0 &&
    cross.routes.length >= cross.expectedRoutes &&
    cross.routes.every((route) => route.depthReady)
  );

  return {
    enabled: true,
    ok: hubsDepthReady && crossDepthReady,
    entityId: mmEntityId,
    connectivity,
    expectedOffersPerHub,
    expectedOffersPerPair,
    hubs,
    cross,
  };
};

export const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {
  if (!health?.enabled || !health.ok) return false;
  if (health.hubs.length === 0 || !health.hubs.every((hub) => hub.depthReady)) return false;
  if (!health.cross.applicable) return true;
  return (
    health.cross.expectedRoutes > 0 &&
    health.cross.routes.length >= health.cross.expectedRoutes &&
    health.cross.routes.every((route) => route.depthReady)
  );
};

export const isMarketMakerFullDepthComplete = (health: MarketMakerHealth | null): boolean => {
  if (!health?.enabled) return false;
  if (health.hubs.length === 0 || !health.hubs.every((hub) => hub.depthReady)) return false;
  if (!health.cross.applicable) return true;
  return (
    health.cross.expectedRoutes > 0 &&
    health.cross.routes.length >= health.cross.expectedRoutes &&
    health.cross.routes.every((route) => route.depthReady)
  );
};

export const isMarketMakerCrossDepthComplete = (health: MarketMakerHealth | null): boolean => {
  if (!health?.enabled) return false;
  if (!health.cross.applicable) return true;
  return (
    health.cross.expectedRoutes > 0 &&
    health.cross.routes.length >= health.cross.expectedRoutes &&
    health.cross.routes.every((route) => route.depthReady)
  );
};

export const isMarketMakerSameDepthComplete = (health: MarketMakerHealth | null): boolean =>
  Boolean(health?.enabled && health.hubs.length > 0 && health.hubs.every((hub) => hub.depthReady));

const canonicalJurisdictionRole = (
  value: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionRef'>,
): string => {
  const ref = String(value.jurisdictionRef || '').trim().toLowerCase() || 'unknown';
  return `j:${ref}`;
};

const canonicalMarketMakerRole = (context: MarketMakerEntityContext): string =>
  `mm:${canonicalJurisdictionRole(context)}`;

const canonicalHubRole = (profile: HubProfile): string =>
  `hub:${canonicalJurisdictionRole(profile)}:${hubRoleName(profile)}`;

const buildUniqueRoleMap = <T>(
  entries: T[],
  getId: (entry: T) => string,
  getRole: (entry: T) => string,
  label: string,
): Map<string, string> => {
  const byId = new Map<string, string>();
  const seenRoles = new Set<string>();
  for (const entry of entries) {
    const id = normalizeEntityRef(getId(entry));
    const role = getRole(entry);
    if (!id) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_MISSING_${label}_ID`);
    if (seenRoles.has(role)) {
      throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_DUPLICATE_${label}_ROLE:${role}`);
    }
    seenRoles.add(role);
    byId.set(id, role);
  }
  return byId;
};

const requireCanonicalRole = (roles: Map<string, string>, entityId: string, label: string): string => {
  const role = roles.get(normalizeEntityRef(entityId));
  if (!role) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNKNOWN_${label}:${entityId}`);
  return role;
};

const canonicalSwapOfferEconomics = (offer: SwapOffer): Record<string, unknown> => ({
  giveTokenId: Number(offer.giveTokenId),
  giveAmount: String(offer.giveAmount),
  wantTokenId: Number(offer.wantTokenId),
  wantAmount: String(offer.wantAmount),
  priceTicks: offer.priceTicks === undefined ? null : String(offer.priceTicks),
  timeInForce: Number(offer.timeInForce ?? 0),
  quantizedGive: offer.quantizedGive === undefined ? null : String(offer.quantizedGive),
  quantizedWant: offer.quantizedWant === undefined ? null : String(offer.quantizedWant),
});

const parseMarketMakerSameOfferId = (
  offerId: string,
): { baseTokenId: number; quoteTokenId: number; side: 'ask' | 'bid'; level: number } => {
  const match = String(offerId || '').match(/^mm-[^-]+-(\d+)-(\d+)-(ask|bid)-(\d+)$/);
  if (!match) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNPARSEABLE_SAME_OFFER:${offerId}`);
  return {
    baseTokenId: Number(match[1]),
    quoteTokenId: Number(match[2]),
    side: match[3] as 'ask' | 'bid',
    level: Number(match[4]),
  };
};

const parseMarketMakerCrossOfferId = (
  offerId: string,
): { sourceTokenId: number; targetTokenId: number; side: 'sell'; level: number } => {
  const match = String(offerId || '').match(
    /^mmx-[0-9a-f]{6}-[0-9a-f]{6}-(\d+)-(\d+)-[0-9a-f]{64}-sell-(\d+)$/,
  );
  if (!match) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNPARSEABLE_CROSS_OFFER:${offerId}`);
  return {
    sourceTokenId: Number(match[1]),
    targetTokenId: Number(match[2]),
    side: 'sell',
    level: Number(match[3]),
  };
};

const collectCommittedMarketMakerOfferFingerprintsForHub = (
  env: RuntimeReplica,
  mmEntityId: string,
  hubEntityId: string,
  hubRole: string,
): Array<Record<string, unknown>> => {
  const account = getAccountReplica(env, mmEntityId, hubEntityId);
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  return Array.from(account?.state.swapOffers?.entries?.() ?? [])
    .filter(([offerId]) => String(offerId).startsWith(prefix))
    .map(([offerId, offer]) => {
      const parsed = parseMarketMakerSameOfferId(String(offerId));
      return {
        offer: `mm:${hubRole}:${parsed.baseTokenId}/${parsed.quoteTokenId}:${parsed.side}:${parsed.level}`,
        hub: hubRole,
        baseTokenId: parsed.baseTokenId,
        quoteTokenId: parsed.quoteTokenId,
        side: parsed.side,
        level: parsed.level,
        ...canonicalSwapOfferEconomics(offer),
      };
    })
    .sort((left, right) => compareStableText(String(left.offer), String(right.offer)));
};

const collectCommittedMarketMakerCrossOfferFingerprints = (
  env: RuntimeReplica,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  contextRoles: Map<string, string>,
  hubRoles: Map<string, string>,
): Array<Record<string, unknown>> => {
  const committed: Array<Record<string, unknown>> = [];
  for (const sourceContext of contexts) {
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    for (const targetContext of contexts) {
      if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;
      const specs = buildMarketMakerCrossOfferSpecs(
        env,
        sourceContext,
        targetContext,
        sourceHubs,
        targetHubs,
        sourceTokenIds,
        getMarketMakerTokenIds(tokenIdsByContext, targetContext),
      );
      for (const spec of specs) {
        if (!spec.crossJurisdiction || !hasFinalizedMarketMakerCrossOffer(env, spec)) continue;
        const offer = getCommittedSourceAccountCrossOffer(env, spec.crossJurisdiction);
        if (!offer) continue;
        const parsed = parseMarketMakerCrossOfferId(spec.offerId);
        const sourceMmRole = requireCanonicalRole(contextRoles, spec.crossJurisdiction.source.entityId, 'MM');
        const targetMmRole = requireCanonicalRole(contextRoles, spec.crossJurisdiction.target.counterpartyEntityId, 'MM');
        const sourceHubRole = requireCanonicalRole(hubRoles, spec.crossJurisdiction.source.counterpartyEntityId, 'HUB');
        const targetHubRole = requireCanonicalRole(hubRoles, spec.crossJurisdiction.target.entityId, 'HUB');
        committed.push({
          offer: `mmx:${sourceMmRole}->${targetMmRole}:${sourceHubRole}->${targetHubRole}:${parsed.sourceTokenId}/${parsed.targetTokenId}:${parsed.side}:${parsed.level}`,
          sourceMm: sourceMmRole,
          targetMm: targetMmRole,
          sourceHub: sourceHubRole,
          targetHub: targetHubRole,
          sourceTokenId: parsed.sourceTokenId,
          targetTokenId: parsed.targetTokenId,
          side: parsed.side,
          level: parsed.level,
          routeStatus: spec.crossJurisdiction.status,
          ...canonicalSwapOfferEconomics(offer),
        });
      }
    }
  }
  return committed.sort((left, right) =>
    compareStableText(String(left['offer']), String(right['offer'])),
  );
};

export const buildMarketMakerBootstrapFingerprint = (
  env: RuntimeReplica,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  health: MarketMakerHealth,
): { hash: string; payload: Record<string, unknown> } => {
  const contextRoles = buildUniqueRoleMap(
    contexts,
    context => context.entityId,
    canonicalMarketMakerRole,
    'MM',
  );
  const hubRoles = buildUniqueRoleMap(
    visibleHubs,
    profile => profile.entityId,
    canonicalHubRole,
    'HUB',
  );
  const payload = {
    schema: 'market-maker-bootstrap-v1',
    expectedOffersPerHub: health.expectedOffersPerHub,
    expectedOffersPerPair: health.expectedOffersPerPair,
    marketMakers: contexts
      .map(context => ({
        role: requireCanonicalRole(contextRoles, context.entityId, 'MM'),
        chainId: Number(context.chainId || 0),
        jurisdictionRef: String(context.jurisdictionRef || '').trim().toLowerCase(),
        tokenIds: getMarketMakerTokenIds(tokenIdsByContext, context),
      }))
      .sort((left, right) => compareStableText(left.role, right.role)),
    hubs: health.hubs
      .map(hub => ({
        role: requireCanonicalRole(hubRoles, hub.hubEntityId, 'HUB'),
        offers: hub.offers,
        offersCommitted: health.entityId
          ? collectCommittedMarketMakerOfferFingerprintsForHub(
              env,
              health.entityId,
              hub.hubEntityId,
              requireCanonicalRole(hubRoles, hub.hubEntityId, 'HUB'),
            )
          : [],
        pairs: hub.pairs.map(pair => ({
          pairId: pair.pairId,
          offers: pair.offers,
          expectedOffers: pair.expectedOffers,
        })).sort((left, right) => compareStableText(left.pairId, right.pairId)),
      }))
      .sort((left, right) => compareStableText(left.role, right.role)),
    cross: {
      applicable: health.cross.applicable,
      expectedRoutes: health.cross.expectedRoutes,
      expectedOffersPerRoute: health.cross.expectedOffersPerRoute,
      expectedOffersPerPair: health.cross.expectedOffersPerPair,
      routes: health.cross.routes
        .map(route => ({
          sourceMm: requireCanonicalRole(contextRoles, route.sourceMmEntityId, 'MM'),
          targetMm: requireCanonicalRole(contextRoles, route.targetMmEntityId, 'MM'),
          sourceHub: requireCanonicalRole(hubRoles, route.sourceHubEntityId, 'HUB'),
          targetHub: requireCanonicalRole(hubRoles, route.targetHubEntityId, 'HUB'),
          offers: route.offers,
          pairs: route.pairs.map(pair => ({
            sourceTokenIds: pair.sourceTokenIds,
            targetTokenIds: pair.targetTokenIds,
            offers: pair.offers,
            expectedOffers: pair.expectedOffers,
          })).sort((left, right) =>
            compareStableText(left.sourceTokenIds.join(','), right.sourceTokenIds.join(',')) ||
            compareStableText(left.targetTokenIds.join(','), right.targetTokenIds.join(',')),
          ),
        }))
        .sort((left, right) =>
          compareStableText(left.sourceMm, right.sourceMm) ||
          compareStableText(left.targetMm, right.targetMm) ||
          compareStableText(left.sourceHub, right.sourceHub) ||
          compareStableText(left.targetHub, right.targetHub),
        ),
      offersCommitted: health.cross.expectedRoutes > 0
        ? collectCommittedMarketMakerCrossOfferFingerprints(
            env,
            contexts,
            visibleHubs,
            tokenIdsByContext,
            contextRoles,
            hubRoles,
          )
        : [],
    },
  };
  const encoded = safeStringify(payload);
  return {
    hash: createHash('sha256').update(encoded).digest('hex'),
    payload,
  };
};

export const buildMarketMakerBootstrapEntityStateHash = (env: RuntimeReplica): string =>
  buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes(
    computeCanonicalEntityHashesFromEnv(env),
  );

export const assertMarketMakerBootstrapFinalized = (
  env: RuntimeReplica,
  health: MarketMakerHealth | null,
): MarketMakerHealth => {
  const blockers: unknown[] = [];
  if (!health || !isMarketMakerDepthComplete(health)) {
    blockers.push({
      scope: 'health',
      enabled: health?.enabled ?? false,
      ok: health?.ok ?? false,
      expectedOffersPerHub: health?.expectedOffersPerHub ?? null,
      hubs: health?.hubs.map(hub => ({
        hubEntityId: hub.hubEntityId,
        offers: hub.offers,
        depthReady: hub.depthReady,
        blockers: hub.blockers,
      })) ?? [],
      cross: {
        applicable: health?.cross.applicable ?? null,
        ok: health?.cross.ok ?? null,
        expectedRoutes: health?.cross.expectedRoutes ?? null,
        routes: health?.cross.routes.map(route => ({
          sourceHubEntityId: route.sourceHubEntityId,
          targetHubEntityId: route.targetHubEntityId,
          offers: route.offers,
          ready: route.ready,
          depthReady: route.depthReady,
          blockers: route.blockers,
        })) ?? [],
      },
    });
  }
  for (const hub of health?.hubs ?? []) {
    for (const blocker of hub.blockers) {
      blockers.push({ scope: 'same-chain-account', hubEntityId: hub.hubEntityId, ...blocker });
    }
  }
  for (const route of health?.cross.routes ?? []) {
    for (const blocker of route.blockers) {
      blockers.push({
        scope: 'cross-account',
        sourceHubEntityId: route.sourceHubEntityId,
        targetHubEntityId: route.targetHubEntityId,
        ...blocker,
      });
    }
  }
  if (hasMarketMakerRuntimeBacklog(env)) {
    blockers.push({
      scope: 'runtime-backlog',
      ...getMarketMakerRuntimeBacklogSnapshot(env),
    });
  }
  if (blockers.length > 0) {
    throw new Error(`MARKET_MAKER_BOOTSTRAP_INCOMPLETE: ${safeStringify(blockers)}`);
  }
  if (!health) {
    throw new Error('MARKET_MAKER_BOOTSTRAP_INCOMPLETE: null health');
  }
  return health;
};
