import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { deterministicEntityTimestamp } from '../../../../orderbook/cross-j/orderbook';
import {
  isCrossJurisdictionRouteExpired,
  isCrossJurisdictionTerminalStatus,
} from '../../../../extensions/cross-j/index';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import type { AccountTxTarget } from '../account';
import { handleRequestCrossJurisdictionClearEntityTx } from './clear';

type CrossJurisdictionSweepTx = Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>;

type CrossJurisdictionSweepResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
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

  for (const [orderId, route] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
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
    if (!sourceHubId) throw haltRuntimeFailure("CROSS_J_SWEEP_SOURCE_HUB_MISSING", `CROSS_J_SWEEP_SOURCE_HUB_MISSING:${orderId}`);
    if (String(newState.entityId || '').toLowerCase() !== sourceHubId) {
      waitingRoutes++;
      continue;
    }
    // An unmaterialized intent (no pulls) holds no book order or lock: there is
    // nothing to clear, and clearing it was a CROSS_J_CLEAR_CORRUPT_ROUTE halt.
    // Counted as expired exactly as before, so committed sweep events replay.
    if (!route.sourcePull || !route.targetPull) continue;
    const clear = handleRequestCrossJurisdictionClearEntityTx(
      env,
      newState,
      { type: 'requestCrossJurisdictionClear', data: { orderId, cancelRemainder: true } },
      storageChanges,
      true,
    );
    outputs.push(...clear.outputs);
    accountTxs.push(...(clear.accountTxs ?? []));
    if (clear.accountTxs?.some(operation => operation.tx.type === 'cross_pull_close')) closedOffers++;
  }
  addMessage(
    newState,
    `🌉 Cross-j orderbook sweep${entityTx.data?.reason ? `: ${entityTx.data.reason}` : ''} ` +
    `expired=${expiredRoutes} closedOffers=${closedOffers} waiting=${waitingRoutes}`,
  );
  return { newState, outputs, accountTxs };
};
