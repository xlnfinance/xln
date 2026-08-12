import { deterministicEntityTimestamp } from '../../../../orderbook/cross-j/orderbook';
import {
  isCrossJurisdictionRouteExpired,
  isCrossJurisdictionTerminalStatus,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../../extensions/cross-j/index';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import {
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../../cross-jurisdiction-helpers';
import type { AccountTxTarget } from '../account';
import { handleRequestCrossJurisdictionClearEntityTx } from './clear';

type CrossJurisdictionSweepTx = Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>;

type CrossJurisdictionSweepResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};


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

export const handleOrderbookSweepCrossJurisdictionEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionSweepTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): CrossJurisdictionSweepResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const now = deterministicEntityTimestamp(newState, env);
  let expiredRoutes = 0;
  let closedOffers = 0;
  let waitingRoutes = 0;

  for (const [orderId, storedRoute] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
    const route = refreshSweepRoute(newState, orderId, storedRoute);
    if (isCrossJurisdictionTerminalStatus(route.status)) continue;

    // Book TTL sweep only — pull reveal deadlines are not sealed into the route.
    // Settlement finality is dispute-relative seconds on L1.
    const routeExpired = isCrossJurisdictionRouteExpired(route, now);
    if (!routeExpired) {
      waitingRoutes++;
      continue;
    }

    expiredRoutes++;
    const sourceHubId = String(route.source.counterpartyEntityId || '').toLowerCase();
    if (!sourceHubId) throw new Error(`CROSS_J_SWEEP_SOURCE_HUB_MISSING:${orderId}`);
    if (String(newState.entityId || '').toLowerCase() !== sourceHubId) {
      waitingRoutes++;
      continue;
    }
    const clear = handleRequestCrossJurisdictionClearEntityTx(
      env,
      newState,
      { type: 'requestCrossJurisdictionClear', data: { orderId, cancelRemainder: true } },
      storageChanges,
      true,
    );
    outputs.push(...clear.outputs);
    accountTxs.push(...(clear.accountTxs ?? []));
    if (clear.accountTxs?.some(operation => operation.tx.type === 'cross_swap_fill_ack')) closedOffers++;
  }
  addMessage(
    newState,
    `🌉 Cross-j orderbook sweep${entityTx.data?.reason ? `: ${entityTx.data.reason}` : ''} ` +
    `expired=${expiredRoutes} closedOffers=${closedOffers} waiting=${waitingRoutes}`,
  );
  return { newState, outputs, accountTxs };
};
