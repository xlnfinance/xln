import {
  buildCrossJurisdictionCloseProof,
  hasCrossJurisdictionCommittedFill,
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import {
  buildCrossJurisdictionCancelAck,
  markCrossJurisdictionBookAdmissionClosed,
} from '../../../extensions/cross-j/orderbook';
import { removeBookOrderById } from '../../../orderbook/cross-j';
import { cloneEntityState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import type {
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
  RuntimeOverlayRecord,
} from '../../../types';
import { formatEntityId } from '../../../utils';
import { findAccountKey } from '../account-key';
import {
  accountHasCrossSwapAckQueued,
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../cross-jurisdiction-helpers';
import type { AccountTxTarget } from './account';

type CrossJurisdictionSweepTx = Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>;

type CrossJurisdictionSweepResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const deterministicEntityTimestamp = (state: EntityState, env: RuntimeState): number =>
  Number(state.timestamp || env.timestamp || 0);

const cancelOrderbookOfferIfPresent = (
  state: EntityState,
  accountId: string,
  offerId: string,
  storageChanges: RuntimeOverlayRecord[],
): boolean => removeBookOrderById(state, `${accountId}:${offerId}`, storageChanges);

const refreshSweepRoute = (
  state: EntityState,
  orderId: string,
  storedRoute: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  const offerRoute = findCrossJurisdictionOfferRoute(state, orderId);
  if (!offerRoute) return storedRoute;
  // A conflicting Account/Entity route is consensus corruption, not a cleanup
  // condition. Sweeping a fallback copy could close the wrong financial leg.
  const route = mergeCrossJurisdictionRoute(
    storedRoute,
    withCanonicalCrossJurisdictionRouteHash(offerRoute.route),
  );
  state.crossJurisdictionSwaps?.set(orderId, route);
  return route;
};

const queueExpiredOfferClosure = (
  state: EntityState,
  orderId: string,
  route: CrossJurisdictionSwapRoute,
  now: number,
  storageChanges: RuntimeOverlayRecord[],
  accountTxs: AccountTxTarget[],
): number => {
  const sourceEntityId = route.source.entityId;
  const accountId = findAccountKey(state, sourceEntityId);
  const account = accountId ? state.accounts.get(accountId) : undefined;
  if (accountId && account?.swapOffers?.has(orderId)) {
    cancelOrderbookOfferIfPresent(state, accountId, orderId, storageChanges);
    markCrossJurisdictionBookAdmissionClosed(
      state,
      sourceEntityId,
      orderId,
      now,
      'sweep_expired',
    );
    if (accountHasCrossSwapAckQueued(account, orderId)) return 0;
    accountTxs.push({ accountId, tx: buildCrossJurisdictionCancelAck(orderId, route) });
    return 1;
  }
  addMessage(
    state,
    accountId
      ? `🌉 Cross-j sweep ${orderId}: no live source offer in ${formatEntityId(accountId)}`
      : `🌉 Cross-j sweep ${orderId}: no source account for ${formatEntityId(sourceEntityId)}`,
  );
  return 0;
};

const transitionExpiredRoute = (
  state: EntityState,
  orderId: string,
  route: CrossJurisdictionSwapRoute,
  now: number,
  accountTxs: AccountTxTarget[],
): void => {
  const accountId = findAccountKey(state, route.source.entityId);
  const account = accountId ? state.accounts.get(accountId) : undefined;
  if (!hasCrossJurisdictionCommittedFill(route)) {
    const proof = buildCrossJurisdictionCloseProof(route, '0x');
    route.sourceCloseProof = proof;
    const pullId = route.sourcePull?.pullId;
    if (accountId && pullId && account?.pulls?.has(pullId)) {
      accountTxs.push({
        accountId,
        tx: { type: 'cross_pull_close', data: { pullId, binary: '0x', proof } },
      });
    }
    transitionCrossJurisdictionRouteStatus(route, 'expired', now);
  } else {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', now);
    route.pendingClearRequestedAt = now;
  }
  route.clearingPolicy = 'cancel_and_clear';
  state.crossJurisdictionSwaps?.set(orderId, route);
};

export const handleOrderbookSweepCrossJurisdictionEntityTx = (
  env: RuntimeState,
  entityState: EntityState,
  entityTx: CrossJurisdictionSweepTx,
  storageChanges: RuntimeOverlayRecord[] = [],
): CrossJurisdictionSweepResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const now = deterministicEntityTimestamp(newState, env);
  let expiredRoutes = 0;
  let closedOffers = 0;
  let waitingRoutes = 0;

  for (const [orderId, storedRoute] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
    const route = refreshSweepRoute(newState, orderId, storedRoute);
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;

    const routeExpired = isCrossJurisdictionRouteExpired(route, now);
    const sourceExpired = isCrossJurisdictionPullExpired(route, 'source', now);
    const targetExpired = isCrossJurisdictionPullExpired(route, 'target', now);
    if (!routeExpired && !sourceExpired && !targetExpired) {
      waitingRoutes++;
      continue;
    }

    expiredRoutes++;
    const sourceEntityId = (route.source as { entityId?: string } | undefined)?.entityId;
    if (!sourceEntityId) {
      transitionCrossJurisdictionRouteStatus(route, 'failed', now);
      newState.crossJurisdictionSwaps?.set(orderId, route);
      addMessage(newState, `🌉 Cross-j sweep ${orderId}: failed malformed route without source entity`);
      continue;
    }

    closedOffers += queueExpiredOfferClosure(
      newState,
      orderId,
      route,
      now,
      storageChanges,
      accountTxs,
    );
    transitionExpiredRoute(newState, orderId, route, now, accountTxs);
  }

  if (expiredRoutes > 0) {
    const firstValidator = entityState.config.validators[0];
    if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  }
  addMessage(
    newState,
    `🌉 Cross-j orderbook sweep${entityTx.data?.reason ? `: ${entityTx.data.reason}` : ''} ` +
    `expired=${expiredRoutes} closedOffers=${closedOffers} waiting=${waitingRoutes}`,
  );
  return { newState, outputs, accountTxs };
};
