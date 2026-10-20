import type { EntityReadView } from '#lib/components/Entity/core/entity-panel-types.ts';
import type { Profile, RuntimeInput, XLNModule } from '@xln/core/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/core/api/public/runtime-module';
import { hasCertifiedEntityEncryptionKey, normalizeEntityId } from '../payment-routing';
import { buildPaymentRuntimeInput } from '@xln/core/api/payments/command';
import { quotePaymentCandidateRoutes } from '../payments/runtime/payment-route-quote';
import type { PaymentPanelView } from '../payments/payment-panel-view';
import { planSameJSwapCommand, resolveSameJSwapPartyRoles } from '../swap/commands/same-j-swap-command';
import type { SwapPanelRuntimeView } from '../swap/swap-panel-helpers';
import type { LoadTestAttemptResult, LoadTestLane } from './load-testing-scheduler';

type LoadTestRuntimeFunctions = Pick<
  XLNModule,
  | 'deriveDelta'
  | 'deriveSwapNetAuthorization'
  | 'getDefaultSwapTradingPairs'
  | 'getSwapPairOrientation'
  | 'getTokenInfo'
  | 'planSwapCommand'
  | 'readAccountCapacity'
  | 'requantizeRemainingSwapAtPrice'
>;

export type LoadTestingControllerDeps = Readonly<{
  sourceEntityId: () => string;
  selectedHubEntityId: () => string;
  paymentView: () => PaymentPanelView;
  swapView: () => SwapPanelRuntimeView | null;
  sourceReplica: () => EntityReadView | null;
  runtimeFunctions: () => LoadTestRuntimeFunctions | null;
  resolveSignerId: (entityId: string) => string;
  submitRuntimeInput: (input: RuntimeInput) => Promise<unknown> | unknown;
  random: () => number;
  bestSwapLevel: (
    hubId: string,
    pairId: string,
    makerSide: 0 | 1,
  ) => Readonly<{ priceTicks: bigint; ownerIds: readonly string[] }> | null;
}>;

type ExternalSwapLevel = Readonly<{
  priceTicks: bigint;
  stpPrevented: boolean;
}>;

const randomWholeUsd = (random: () => number, min: number, max: number): number =>
  min + Math.floor(Math.min(0.999_999, Math.max(0, random())) * (max - min + 1));

const randomIndex = (random: () => number, length: number): number =>
  Math.floor(Math.min(0.999_999, Math.max(0, random())) * length);

const rawStableAmount = (
  runtime: LoadTestRuntimeFunctions,
  random: () => number,
  minUsd: number,
  maxUsd: number,
): bigint => {
  const token = runtime.getTokenInfo(1);
  if (
    String(token.symbol || '')
      .trim()
      .toUpperCase() !== 'USDC'
  ) {
    throw new Error('LOAD_TEST_USDC_TOKEN_UNAVAILABLE');
  }
  const decimals = Number(token.decimals);
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error('LOAD_TEST_USDC_DECIMALS_INVALID');
  }
  return BigInt(randomWholeUsd(random, minUsd, maxUsd)) * 10n ** BigInt(decimals);
};

const skip = (reason: string, stpPrevented = false): LoadTestAttemptResult => ({
  status: 'skipped',
  reason,
  ...(stpPrevented ? { stpPrevented: true } : {}),
});

const isAvailablePaymentPath = (path: readonly string[], sourceEntityId: string, view: PaymentPanelView): boolean =>
  path.length >= 2 &&
  path.every((entityId, index) => {
    const normalized = normalizeEntityId(entityId);
    if (!normalized || (index === 0 && normalized !== sourceEntityId)) return false;
    if (index > 0 && view.blockedCounterpartyIds.has(normalized)) return false;
    if (index > 0 && !hasCertifiedEntityEncryptionKey(view.replicaMap, view.profiles, normalized)) return false;
    if (index > 0 && index < path.length - 1) {
      return view.profiles.some(
        profile => normalizeEntityId(profile.entityId) === normalized && profile.metadata.isHub === true,
      );
    }
    return true;
  });

export const selectExternalSwapLevel = (
  level: Readonly<{ priceTicks: bigint; ownerIds: readonly string[] }> | null,
  sourceEntityId: string,
): ExternalSwapLevel | null => {
  if (!level) return null;
  const source = normalizeEntityId(sourceEntityId);
  const owners = level.ownerIds.map(normalizeEntityId);
  if (owners.includes(source)) return { priceTicks: level.priceTicks, stpPrevented: true };
  return owners.some(owner => owner && owner !== source) ? { priceTicks: level.priceTicks, stpPrevented: false } : null;
};

const sourceJurisdiction = (replica: EntityReadView): string => {
  const state = replica.state as { config?: { jurisdiction?: Parameters<typeof getJurisdictionStackId>[0] } };
  return getJurisdictionStackId(state.config?.jurisdiction) || '';
};

const hubProfile = (view: SwapPanelRuntimeView, hubEntityId: string): Profile | null => view.getHubProfile(hubEntityId);

export const createLoadTestingController = (
  deps: LoadTestingControllerDeps,
): Readonly<{
  attempt: (lane: LoadTestLane, signal: AbortSignal) => Promise<LoadTestAttemptResult>;
}> => {
  let swapSequence = 0;

  const attemptPayment = async (signal: AbortSignal): Promise<LoadTestAttemptResult> => {
    const runtime = deps.runtimeFunctions();
    const view = deps.paymentView();
    const source = normalizeEntityId(deps.sourceEntityId());
    if (!runtime || !source || !view.networkGraph) return skip('Payment projection is not ready');
    const targets = view.knownRecipientEntities.map(normalizeEntityId).filter(target => target && target !== source);
    if (targets.length === 0) return skip('No payment recipient is currently available');
    const target = targets[randomIndex(deps.random, targets.length)]!;
    const amount = rawStableAmount(runtime, deps.random, 1, 5);
    const paths = ((await view.networkGraph.findPaths?.(source, target, amount, 1)) ?? [])
      .map(route => route.path)
      .filter(path => isAvailablePaymentPath(path, source, view));
    if (paths.length === 0) return skip('No currently available encrypted payment route');
    const routes = quotePaymentCandidateRoutes({
      paths,
      canonicalIds: new Map(),
      replicaMap: view.replicaMap,
      profiles: view.profiles,
      deriveDelta: runtime.deriveDelta,
      tokenId: 1,
      recipientAmount: amount,
      defaultUnknownHopFeePPM: 1,
    }).sort((left, right) =>
      left.totalFee === right.totalFee ? left.path.length - right.path.length : left.totalFee < right.totalFee ? -1 : 1,
    );
    const route = routes[0];
    if (!route) return skip('No payment route has current capacity');
    // Stop may occur while pathfinding awaits. Never admit a new command after cancellation.
    if (signal.aborted) return skip('Stopped before command admission');
    await deps.submitRuntimeInput(
      buildPaymentRuntimeInput({
        entityId: source,
        signerId: deps.resolveSignerId(source),
        targetEntityId: target,
        tokenId: 1,
        deliveryMode: 'instant',
        description: 'Load testing',
        route,
      }),
    );
    return { status: 'submitted', reason: 'USDC payment submitted' };
  };

  const attemptSwap = async (signal: AbortSignal): Promise<LoadTestAttemptResult> => {
    const runtime = deps.runtimeFunctions();
    const view = deps.swapView();
    const replica = deps.sourceReplica();
    const source = normalizeEntityId(deps.sourceEntityId());
    const hub = normalizeEntityId(deps.selectedHubEntityId());
    if (!runtime || !view || !replica || !source || !hub) return skip('Swap projection is not ready');
    const account = replica.state.accounts.get(hub);
    if (!account) return skip('Selected hub Account is not committed');
    const jurisdiction = sourceJurisdiction(replica);
    const profile = hubProfile(view, hub);
    if (!jurisdiction || !profile) return skip('Selected hub jurisdiction profile is unavailable');
    const amount = rawStableAmount(runtime, deps.random, 10, 15);
    const pairs = runtime
      .getDefaultSwapTradingPairs()
      .filter(pair => pair.baseTokenId === 1 || pair.quoteTokenId === 1);
    for (const pair of pairs) {
      const orientation = runtime.getSwapPairOrientation(pair.baseTokenId, pair.quoteTokenId);
      const wantTokenId = orientation.baseTokenId === 1 ? orientation.quoteTokenId : orientation.baseTokenId;
      const makerSide: 0 | 1 = orientation.baseTokenId === 1 ? 0 : 1;
      const level = selectExternalSwapLevel(deps.bestSwapLevel(hub, orientation.pairId, makerSide), source);
      if (!level) continue;
      if (level.stpPrevented) return skip('Self order blocks external liquidity', true);
      const prepared = runtime.requantizeRemainingSwapAtPrice(1, wantTokenId, amount, level.priceTicks);
      if (!prepared) continue;
      const capacity = runtime.readAccountCapacity({
        account: account.state,
        ownerEntityId: source,
        counterpartyEntityId: hub,
        tokenId: 1,
      });
      if (!capacity.tokenActive || capacity.outCapacity < prepared.effectiveGive) {
        return skip('Swap source Account has insufficient current capacity');
      }
      const roles = resolveSameJSwapPartyRoles({
        sourceEntityId: source,
        hubEntityId: hub,
        hubProfile: profile,
        committedRoles: view.committedRoles,
        label: 'SOURCE',
      });
      swapSequence += 1;
      const plan = planSameJSwapCommand({
        committedSourceReplica: replica,
        runtimeView: view,
        source: {
          entityId: source,
          signerId: deps.resolveSignerId(source),
          jurisdiction,
        },
        hub: {
          entityId: hub,
          signerId: deps.resolveSignerId(hub),
          profile,
        },
        roles,
        tokens: {
          giveTokenId: 1,
          giveTokenDecimals: Number(runtime.getTokenInfo(1).decimals),
          wantTokenId,
          wantTokenDecimals: Number(runtime.getTokenInfo(wantTokenId).decimals),
        },
        giveAmount: amount,
        priceTicks: level.priceTicks,
        routeValue: `load-test:same:${orientation.pairId}:${swapSequence}`,
        expectedWantAmount: prepared.effectiveWant,
        logicalClock: {
          logicalTimestamp: replica.state.timestamp,
          logicalHeight: replica.state.height,
        },
        runtimeFunctions: runtime,
      });
      if (signal.aborted) return skip('Stopped before command admission');
      await deps.submitRuntimeInput(plan.runtimeInput);
      return { status: 'submitted', reason: 'Same-j USDC swap submitted' };
    }
    return skip('No external same-j liquidity is currently available');
  };

  return {
    attempt: async (lane, signal) =>
      signal.aborted
        ? skip('Stopped before command admission')
        : lane === 'pay'
          ? attemptPayment(signal)
          : attemptSwap(signal),
  };
};
