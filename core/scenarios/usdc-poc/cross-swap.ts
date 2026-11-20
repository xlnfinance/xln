import * as runtime from '../../runtime';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { requantizeRemainingSwapAtPriceForDimensions } from '../../swapbook/types';
import { isCrossJurisdictionRouteExpired } from '../../extensions/cross-j';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../extensions/cross-j/orderbook';
import { decodeEntitySummaries, selectLocalHubIdentity } from '../../scripts/operations/hlt/boundary/worker-boundary';
import { decodeCommittedCrossRouteSnapshot } from '../../scripts/operations/hlt/cross/cross-boundary';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import { connectPocHub, verifyHubCommit } from './hub-proof';
import { openPocAccount, userReplica, waitFor, type PocUser } from './user';
import { targetUser } from './journey/context';
import { readPocPayoutTimestamp, requirePayoutTerms } from './journey/payout-terms';

const sourceAmount = 1_000_000n;

export const selectPocMakerQuote = (
  routes: CrossJurisdictionSwapRoute[],
  sourceHub: string,
  targetHub: string,
  partialLiquidity: boolean,
  hubTimestamp: number,
  wallTimestamp: number,
) => {
  const observedAt = Math.max(hubTimestamp, wallTimestamp);
  const candidates = routes.filter(
    route =>
      (partialLiquidity ? route.orderId.startsWith('poc-mm-') : route.orderId.startsWith('mmx-')) &&
      (route.status === 'resting' || route.status === 'partially_filled') &&
      !isCrossJurisdictionRouteExpired(route, observedAt) &&
      route.source.counterpartyEntityId === targetHub &&
      route.target.entityId === sourceHub &&
      route.source.tokenId === 1 &&
      route.target.tokenId === 1,
  );
  candidates.sort((a, b) =>
    (a.priceTicks ?? 0n) > (b.priceTicks ?? 0n) ? -1 : (a.priceTicks ?? 0n) < (b.priceTicks ?? 0n) ? 1 : 0,
  );
  for (const maker of candidates) {
    const priceTicks = maker.priceTicks;
    if (!priceTicks) throw new Error('USDC_POC_MM_PRICE_MISSING');
    const quote = requantizeRemainingSwapAtPriceForDimensions(1, 1, sourceAmount, priceTicks, {
      giveTokenDecimals: 6,
      wantTokenDecimals: 6,
    });
    const remaining = getCrossJurisdictionRouteRemainingAmounts(maker);
    if (
      quote &&
      quote.effectiveGive === sourceAmount &&
      quote.releasedGiveDust === 0n &&
      (partialLiquidity ||
        (remaining.sourceRemaining >= quote.effectiveWant && remaining.targetRemaining >= sourceAmount))
    ) {
      return { maker, quote, priceTicks };
    }
  }
  throw new Error(`USDC_POC_EXECUTABLE_USDC_QUOTE_MISSING:candidates=${candidates.length}`);
};

const requireClosedRoute = (user: PocUser, orderId: string) => {
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(orderId);
  if (!route) return null;
  const amounts = getCrossJurisdictionRouteRemainingAmounts(route);
  return route.status === 'settled' && amounts.sourceRemaining === 0n && amounts.targetRemaining === 0n ? route : null;
};

const accountView = (user: PocUser, hub: string) => {
  const account = userReplica(user).state.accounts.get(hub);
  if (!account) throw new Error('USDC_POC_SWAP_ACCOUNT_MISSING');
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('USDC_POC_SWAP_DELTA_MISSING');
  return { account, delta, view: deriveDelta(delta, isLeftEntity(user.entityId, hub)) };
};

const closedProof = (route: CrossJurisdictionSwapRoute) => ({
  orderId: route.orderId,
  routeHash: route.routeHash,
  status: route.status,
  amounts: getCrossJurisdictionRouteRemainingAmounts(route),
  sourcePull: route.sourcePull,
  targetPull: route.targetPull,
  sourceCloseProof: route.sourceCloseProof,
  targetCloseProof: route.targetCloseProof,
  sourceRegistryRecord: route.sourceRegistryRecord,
  targetRegistryRecord: route.targetRegistryRecord,
  expiresAt: route.expiresAt,
  settledAt: route.settledAt,
});

const readCrossQuote = async (user: PocUser, sourceHub: string, apiBase: string, workDir: string, partial: boolean) => {
  const adapter = await connectPocHub(workDir, 'H1', undefined, user.hubConnection);
  try {
    const target = targetUser(user, apiBase);
    const entities = decodeEntitySummaries(await adapter.read<unknown>('entities'));
    const targetHub = selectLocalHubIdentity(entities, adapter.runtimeId, target.jurisdiction.chainId).entityId;
    const { routes, timestamp } = decodeCommittedCrossRouteSnapshot(await adapter.read<unknown>(`entity/${sourceHub}`));
    return {
      target,
      targetHub,
      hubTimestamp: timestamp,
      ...selectPocMakerQuote(routes, sourceHub, targetHub, partial, timestamp, Date.now()),
    };
  } finally {
    adapter.disconnect();
  }
};

export const inspectCrossPayout = async (user: PocUser, sourceHub: string, apiBase: string, validThrough: number) => {
  const { maker, quote, target, targetHub, hubTimestamp } = await readCrossQuote(user, sourceHub, apiBase, '', false);
  const proof = await verifyHubCommit(target, targetHub, '');
  const { account } = accountView(target, targetHub);
  if (
    account.currentFrame.stateHash !== proof.stateHash ||
    maker.expiresAt === undefined ||
    isCrossJurisdictionRouteExpired(maker, Math.max(hubTimestamp, Date.now()))
  )
    throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
  const { fee, net, policy, backingRequired } = requirePayoutTerms(
    account,
    isLeftEntity(target.entityId, targetHub),
    quote.effectiveWant,
    readPocPayoutTimestamp(user.env.state.timestamp),
    validThrough,
  );
  return {
    makerOrderId: maker.orderId,
    makerRouteHash: maker.routeHash,
    priceTicks: maker.priceTicks,
    expiresAt: maker.expiresAt,
    hubTimestamp,
    targetHub,
    gross: quote.effectiveWant,
    fee,
    net,
    backingRequired,
    policyVersion: policy.policyVersion,
    proof,
  };
};

export const requireUnchangedPocMakerQuote = async (
  user: PocUser,
  sourceHub: string,
  apiBase: string,
  expected: Pick<Awaited<ReturnType<typeof inspectCrossPayout>>, 'makerRouteHash' | 'targetHub' | 'gross'>,
  workDir = '',
) => {
  const live = await readCrossQuote(user, sourceHub, apiBase, workDir, false);
  if (
    live.maker.routeHash !== expected.makerRouteHash ||
    live.targetHub !== expected.targetHub ||
    live.quote.effectiveWant !== expected.gross
  )
    throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
};

export const executeCrossSwap = async (
  user: PocUser,
  sourceHub: string,
  apiBase: string,
  workDir: string,
  partialLiquidity = false,
  expiresInMs = 120_000,
  payoutGuard?: Readonly<{ validThrough: number; verifyBacking: (amount: bigint) => Promise<void> }>,
) => {
  const { maker, quote, priceTicks, target, targetHub } = await readCrossQuote(
    user,
    sourceHub,
    apiBase,
    workDir,
    partialLiquidity,
  );
  console.log(
    `USDC_POC_MM_QUOTE:${maker.orderId}:source=${sourceAmount}:gross=${quote.effectiveWant}:price=${maker.priceTicks}`,
  );
  await openPocAccount(target, apiBase, targetHub, quote.effectiveWant);
  await runtime.ensureGossipProfiles(user.env, [sourceHub, targetHub]);
  const { account, view: inbound } = accountView(target, targetHub);
  if (inbound.peerCreditLimit !== quote.effectiveWant || inbound.inCapacity < quote.effectiveWant) {
    throw new Error('USDC_POC_TARGET_CREDIT_INVALID');
  }
  // A valid Cross-J fill can still leave a claim below the payout floor after the signed Hub fee.
  const { backingRequired } = requirePayoutTerms(
    account,
    isLeftEntity(target.entityId, targetHub),
    quote.effectiveWant,
    readPocPayoutTimestamp(user.env.state.timestamp),
    payoutGuard?.validThrough,
  );
  if (payoutGuard) {
    await payoutGuard.verifyBacking(backingRequired);
    await requireUnchangedPocMakerQuote(
      user,
      sourceHub,
      apiBase,
      {
        makerRouteHash: maker.routeHash,
        targetHub,
        gross: quote.effectiveWant,
      },
      workDir,
    );
    if (Date.now() >= payoutGuard.validThrough) throw new Error('USDC_POC_CROSS_J_PAYOUT_GUARD_EXPIRED');
  }
  if (
    isCrossJurisdictionRouteExpired(maker, Date.now()) ||
    userReplica(target).state.accounts.get(targetHub)?.currentFrame.stateHash !== account.currentFrame.stateHash
  )
    throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
  const { route } = await runtime.submitCrossJurisdictionSwap(user.env, {
    orderId: user.orderId,
    sourceUserEntityId: user.entityId,
    sourceHubEntityId: sourceHub,
    targetHubEntityId: targetHub,
    targetUserEntityId: target.entityId,
    sourceTokenId: 1,
    targetTokenId: 1,
    sourceAmount,
    targetAmount: quote.effectiveWant,
    priceTicks,
    expiresInMs,
  });
  await waitFor('cross-j-full-execution', () =>
    Boolean(requireClosedRoute(user, route.orderId) && requireClosedRoute(target, route.orderId)),
  );
  return await verifySwap(user, target, sourceHub, targetHub, route, maker, workDir);
};

const verifySwap = async (
  user: PocUser,
  target: PocUser,
  sourceHub: string,
  targetHub: string,
  intent: CrossJurisdictionSwapRoute,
  maker: CrossJurisdictionSwapRoute | undefined,
  workDir: string,
) => {
  const sourceProof = await verifyHubCommit(user, sourceHub, workDir);
  const targetProof = await verifyHubCommit(target, targetHub, workDir);
  const source = accountView(user, sourceHub);
  const received = accountView(target, targetHub);
  if (
    source.view.outCollateral !== 0n ||
    source.view.outPeerCredit !== 0n ||
    received.view.outPeerCredit !== intent.target.amount ||
    received.view.peerCreditLimit !== intent.target.amount ||
    received.delta.collateral !== 0n ||
    source.account.state.pulls?.size ||
    received.account.state.pulls?.size
  ) {
    throw new Error('USDC_POC_SWAP_ACCOUNTING_MISMATCH');
  }
  const sourceRoute = requireClosedRoute(user, intent.orderId);
  const targetRoute = requireClosedRoute(target, intent.orderId);
  if (!sourceRoute || !targetRoute) throw new Error('USDC_POC_FULL_CLOSE_PROOF_MISSING');
  return {
    status: 'complete',
    sourceAmount,
    grossTargetAmount: intent.target.amount,
    sourceStack: intent.source.jurisdiction,
    targetStack: intent.target.jurisdiction,
    maker: maker
      ? {
          orderId: maker.orderId,
          routeHash: maker.routeHash,
          source: maker.source,
          target: maker.target,
          priceTicks: maker.priceTicks,
        }
      : null,
    authorization: intent,
    sourceRoute: closedProof(sourceRoute),
    targetRoute: closedProof(targetRoute),
    sourceProof,
    targetProof,
    source: source.view,
    target: received.view,
    targetEntityId: target.entityId,
    targetHubEntityId: targetHub,
    externalPayout: false,
  };
};

export const resumeCrossSwap = async (user: PocUser, sourceHub: string, apiBase: string, workDir: string) => {
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  if (!route) throw new Error('USDC_POC_RESTORE_ROUTE_MISSING');
  const identity = user.identities.find(item => item.entityId === route.target.counterpartyEntityId);
  const jurisdiction = user.jurisdictions.find(item => item.chainId === identity?.chainId);
  if (!identity || !jurisdiction) throw new Error('USDC_POC_RESTORE_TARGET_MISSING');
  const target = {
    ...user,
    ...identity,
    jurisdiction: { ...jurisdiction, rpc: new URL(jurisdiction.rpc, apiBase).toString() },
  };
  await waitFor('restored-cross-j-full-execution', () =>
    Boolean(requireClosedRoute(user, route.orderId) && requireClosedRoute(target, route.orderId)),
  );
  return verifySwap(user, target, sourceHub, route.target.entityId, route, undefined, workDir);
};
