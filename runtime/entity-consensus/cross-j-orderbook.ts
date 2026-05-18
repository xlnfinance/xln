import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../types';
import {
  normalizeSwapOfferForOrderbook,
  type SwapCancelEvent,
} from '../entity-tx/handlers/account';
import { type OrderbookExtState } from '../orderbook';
import { removeBookOrderById } from '../orderbook/cross-j';
import {
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  withCanonicalCrossJurisdictionRouteHash,
} from '../cross-jurisdiction';

export type OrderbookOfferForMatch = ReturnType<typeof normalizeSwapOfferForOrderbook>;

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const deterministicEntityTimestamp = (state: EntityState, env?: Env): number =>
  Number(state.timestamp || env?.timestamp || 0);

export const applyCommittedSwapCancelsToOrderbook = (
  env: Env,
  state: EntityState,
  cancels: SwapCancelEvent[],
): void => {
  if (cancels.length === 0) return;
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return;
  console.log(`📊 ENTITY-ORCHESTRATOR: Applying ${cancels.length} committed swap cancels to orderbook`);
  for (const { accountId, offerId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;
    if (removeBookOrderById(env, state, namespacedOrderId)) {
      console.log(`📊 ORDERBOOK: Removed committed cancelled order ${offerId.slice(-8)}`);
    }
  }
};

export const findEntityStateById = (env: Env, entityId: string): EntityState | null => {
  const target = normalizeEntityRef(entityId);
  for (const replica of env.eReplicas?.values?.() || []) {
    const candidate = normalizeEntityRef(replica?.state?.entityId || replica?.entityId || '');
    if (candidate === target) return replica.state;
  }
  return null;
};

export const findAccountByCounterparty = (state: EntityState | null | undefined, counterpartyId: string) => {
  if (!state?.accounts) return null;
  const target = normalizeEntityRef(counterpartyId);
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeEntityRef(accountId) === target) return account;
  }
  return null;
};

const isCrossJurisdictionReadinessTx = (tx: unknown): boolean => {
  const typed = tx as { type?: string; data?: { crossJurisdiction?: unknown } } | null | undefined;
  return typed?.type === 'pull_lock' ||
    typed?.type === 'pull_resolve' ||
    typed?.type === 'pull_cancel' ||
    typed?.type === 'cross_swap_fill_ack' ||
    (typed?.type === 'swap_offer' && Boolean(typed.data?.crossJurisdiction));
};

export const accountInputCommitsCrossJurisdictionReadiness = (
  currentEntityState: EntityState,
  entityTx: EntityTx,
): boolean => {
  if (entityTx.type !== 'accountInput') return false;
  const accountTxs = entityTx.data?.newAccountFrame?.accountTxs;
  if (accountTxs?.some(isCrossJurisdictionReadinessTx)) return true;

  // Proposer-side pull locks/offers become committed when the counterparty ACKs
  // our pending frame. That ACK carries no newAccountFrame, so the orderbook must
  // explicitly wake up from the pending frame that just became live.
  if (!entityTx.data?.prevHanko || entityTx.data?.height === undefined) return false;
  const account = findAccountByCounterparty(currentEntityState, entityTx.data.fromEntityId);
  return Boolean(account?.pendingFrame?.accountTxs?.some(isCrossJurisdictionReadinessTx));
};

type PendingCrossSwapAckData = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>['data'];

const findPendingCrossSwapAckData = (
  account: ReturnType<typeof findAccountByCounterparty>,
  offerId: string,
): PendingCrossSwapAckData | null => {
  if (!account) return null;
  const mempoolAck = (account.mempool ?? []).find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId);
  if (mempoolAck?.type === 'cross_swap_fill_ack') return mempoolAck.data;
  const pendingAck = (account.pendingFrame?.accountTxs ?? []).find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId);
  return pendingAck?.type === 'cross_swap_fill_ack' ? pendingAck.data : null;
};

export const collectSiblingCrossJurisdictionOffers = (
  env: Env,
  currentEntityState: EntityState,
): OrderbookOfferForMatch[] => {
  const currentId = normalizeEntityRef(currentEntityState.entityId);
  const now = deterministicEntityTimestamp(currentEntityState, env);
  const offers: OrderbookOfferForMatch[] = [];
  for (const replica of env.eReplicas?.values?.() || []) {
    const siblingState = replica?.state;
    if (!siblingState?.accounts) continue;
    if (normalizeEntityRef(siblingState.entityId) === currentId) continue;
    for (const [accountId, account] of siblingState.accounts.entries()) {
      for (const [offerId, offer] of account.swapOffers.entries()) {
        if (!offer?.crossJurisdiction) continue;
        const pendingCrossSwapAck = findPendingCrossSwapAckData(account, String(offerId));
        let route;
        try {
          route = withCanonicalCrossJurisdictionRouteHash(offer.crossJurisdiction);
        } catch {
          continue;
        }
        if (normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId) !== currentId) continue;
        if (route.status !== 'resting' && route.status !== 'partially_filled') continue;
        if (isCrossJurisdictionRouteExpired(route, now) || isCrossJurisdictionPullExpired(route, 'source', now)) continue;
        const normalizedOffer = normalizeSwapOfferForOrderbook(
          {
            offerId: String(offerId),
            makerIsLeft: offer.makerIsLeft,
            fromEntity: account.leftEntity,
            toEntity: account.rightEntity,
            createdHeight: offer.createdHeight,
            giveTokenId: offer.giveTokenId,
            giveAmount: offer.giveAmount,
            wantTokenId: offer.wantTokenId,
            wantAmount: offer.wantAmount,
            priceTicks: offer.priceTicks,
            timeInForce: offer.timeInForce,
            minFillRatio: offer.minFillRatio,
            crossJurisdiction: route,
          },
          String(accountId),
        );
        offers.push(pendingCrossSwapAck ? { ...normalizedOffer, pendingCrossSwapAck } : normalizedOffer);
      }
    }
  }
  return offers;
};

export const collectLocalCrossJurisdictionOffers = (
  currentEntityState: EntityState,
): OrderbookOfferForMatch[] => {
  const now = deterministicEntityTimestamp(currentEntityState);
  const offers: OrderbookOfferForMatch[] = [];
  for (const [accountId, account] of currentEntityState.accounts.entries()) {
    for (const [offerId, offer] of account.swapOffers.entries()) {
      if (!offer?.crossJurisdiction) continue;
      const pendingCrossSwapAck = findPendingCrossSwapAckData(account, String(offerId));
      let route;
      try {
        route = withCanonicalCrossJurisdictionRouteHash(offer.crossJurisdiction);
      } catch {
        continue;
      }
      if (normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId) !== normalizeEntityRef(currentEntityState.entityId)) continue;
      if (route.status !== 'resting' && route.status !== 'partially_filled') continue;
      if (isCrossJurisdictionRouteExpired(route, now) || isCrossJurisdictionPullExpired(route, 'source', now)) continue;
      const normalizedOffer = normalizeSwapOfferForOrderbook(
        {
          offerId: String(offerId),
          makerIsLeft: offer.makerIsLeft,
          fromEntity: account.leftEntity,
          toEntity: account.rightEntity,
          createdHeight: offer.createdHeight,
          giveTokenId: offer.giveTokenId,
          giveAmount: offer.giveAmount,
          wantTokenId: offer.wantTokenId,
          wantAmount: offer.wantAmount,
          priceTicks: offer.priceTicks,
          timeInForce: offer.timeInForce,
          minFillRatio: offer.minFillRatio,
          crossJurisdiction: route,
        },
        String(accountId),
      );
      offers.push(pendingCrossSwapAck ? { ...normalizedOffer, pendingCrossSwapAck } : normalizedOffer);
    }
  }
  return offers;
};

export const findSwapOfferOwnerState = (
  env: Env,
  currentEntityState: EntityState,
  accountId: string,
  offerId: string,
): EntityState | null => {
  const account = findAccountByCounterparty(currentEntityState, accountId);
  if (account?.swapOffers?.has(offerId)) return currentEntityState;
  const currentId = normalizeEntityRef(currentEntityState.entityId);
  for (const replica of env.eReplicas?.values?.() || []) {
    const state = replica?.state;
    if (!state || normalizeEntityRef(state.entityId) === currentId) continue;
    const remoteAccount = findAccountByCounterparty(state, accountId);
    if (remoteAccount?.swapOffers?.has(offerId)) return state;
  }
  return null;
};

export const crossJurisdictionPullsReady = (
  env: Env,
  route: NonNullable<OrderbookOfferForMatch['crossJurisdiction']>,
  now: number,
): boolean => {
  if (!route.sourcePull || !route.targetPull) return false;
  if (isCrossJurisdictionRouteExpired(route, now)) return false;
  if (isCrossJurisdictionPullExpired(route, 'source', now) || isCrossJurisdictionPullExpired(route, 'target', now)) return false;
  // The orderbook runs in hub runtimes. Remote user sibling entities usually
  // are not present in this env, so readiness is checked against the hub-side
  // account state. A pull is present there only after the bilateral frame was
  // accepted/acked by the user side.
  const sourceHubState = findEntityStateById(env, route.source.counterpartyEntityId);
  const targetHubState = findEntityStateById(env, route.target.entityId);
  const sourceAccount = findAccountByCounterparty(sourceHubState, route.source.entityId);
  const targetAccount = findAccountByCounterparty(targetHubState, route.target.counterpartyEntityId);
  return Boolean(
    sourceAccount?.pulls?.has(route.sourcePull.pullId) &&
    targetAccount?.pulls?.has(route.targetPull.pullId),
  );
};

export const crossJurisdictionBookOwnerRef = (
  route: NonNullable<OrderbookOfferForMatch['crossJurisdiction']>,
): string => normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId || '');

export const queueCrossJurisdictionBookOwnerWake = (
  env: Env,
  outputs: EntityInput[],
  ownerRef: string,
  reason: string,
): void => {
  if (!ownerRef) return;
  const ownerState = findEntityStateById(env, ownerRef);
  const firstValidator = ownerState?.config?.validators?.[0];
  if (!ownerState || !firstValidator) {
    console.warn(`🌉 ORDERBOOK CROSS-J: unable to wake book owner ${ownerRef.slice(-8)} reason=${reason}`);
    return;
  }
  const alreadyQueued = outputs.some(output =>
    normalizeEntityRef(output.entityId) === normalizeEntityRef(ownerState.entityId) &&
    output.entityTxs?.some(tx => tx.type === 'orderbookSweepCrossJurisdiction'),
  );
  if (alreadyQueued) return;
  outputs.push({
    entityId: ownerState.entityId,
    signerId: firstValidator,
    entityTxs: [{
      type: 'orderbookSweepCrossJurisdiction',
      data: { reason },
    }],
  });
};
