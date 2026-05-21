import {
  isCrossJurisdictionPullExpired,
  isCrossJurisdictionRouteExpired,
  isCrossJurisdictionTerminalStatus,
  transitionCrossJurisdictionRouteStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import { buildCrossJurisdictionCancelAck } from '../../cross-jurisdiction-orderbook';
import { removeBookOrderById } from '../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { findAccountKey } from '../account-key';
import {
  accountHasCrossSwapAckQueued,
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../cross-jurisdiction-helpers';
import { pushCrossJurisdictionEntityOutput } from '../cross-j-outputs';
import type { MempoolOp } from './account';

type CrossJurisdictionSweepTx = Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>;

type CrossJurisdictionSweepResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);

const cancelOrderbookOfferIfPresent = (
  env: Env,
  state: EntityState,
  accountId: string,
  offerId: string,
): boolean => removeBookOrderById(env, state, `${accountId}:${offerId}`);

const pushCrossJOutput = (
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs);
};

export const handleOrderbookSweepCrossJurisdictionEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CrossJurisdictionSweepTx,
): CrossJurisdictionSweepResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const now = deterministicEntityTimestamp(newState, env);
  let expiredRoutes = 0;
  let closedOffers = 0;
  let waitingRoutes = 0;

  for (const [orderId, storedRoute] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
    let route = storedRoute;
    const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
    if (offerRoute) {
      try {
        route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
        newState.crossJurisdictionSwaps?.set(orderId, route);
      } catch {
        // The expiry cleanup below will still fail closed on the entity-level route.
      }
    }
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

    const accountId = findAccountKey(newState, sourceEntityId);
    const account = accountId ? newState.accounts.get(accountId) : undefined;
    const hasFilledAmount =
      Number(route.cumulativeFillRatio || route.claimedRatio || 0) > 0 ||
      (route.filledSourceAmount ?? route.sourceClaimed ?? 0n) > 0n ||
      (route.filledTargetAmount ?? route.targetClaimed ?? 0n) > 0n;

    if (accountId && account?.swapOffers?.has(orderId)) {
      cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
      if (!accountHasCrossSwapAckQueued(account, orderId)) {
        mempoolOps.push({
          accountId,
          tx: buildCrossJurisdictionCancelAck(orderId, route),
        });
        closedOffers++;
      }
    } else if (!accountId) {
      addMessage(newState, `🌉 Cross-j sweep ${orderId}: no source account for ${formatEntityId(sourceEntityId)}`);
    } else {
      addMessage(newState, `🌉 Cross-j sweep ${orderId}: no live source offer in ${formatEntityId(accountId)}`);
    }

    if (!hasFilledAmount) {
      if (accountId && account?.pulls?.has(route.sourcePull?.pullId || '')) {
        const sourcePullId = route.sourcePull!.pullId;
        mempoolOps.push({
          accountId,
          tx: {
            type: 'pull_cancel',
            data: {
              pullId: sourcePullId,
              reason: 'expired',
            },
          },
        });
      }
      if (route.targetPull && route.target?.counterpartyEntityId && route.target?.entityId) {
        pushCrossJOutput(env, outputs, route.target.counterpartyEntityId, [{
          type: 'cancelPull',
          data: {
            counterpartyEntityId: route.target.entityId,
            pullId: route.targetPull.pullId,
            description: `Cross-j ${orderId} sweep cancel target pull`,
          },
        }]);
      }
      transitionCrossJurisdictionRouteStatus(route, 'expired', now);
    } else {
      if (sourceExpired) {
        throw new Error(`CROSS_J_FILLED_ROUTE_SOURCE_PULL_EXPIRED: route=${orderId}`);
      }
      transitionCrossJurisdictionRouteStatus(route, 'failed', now);
    }
    route.clearingPolicy = hasFilledAmount ? 'manual' : 'cancel_and_clear';
    newState.crossJurisdictionSwaps?.set(orderId, route);
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
  return { newState, outputs, mempoolOps };
};
