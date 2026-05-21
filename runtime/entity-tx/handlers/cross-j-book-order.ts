import type { EntityState, EntityTx, Env } from '../../types';
import { removeCrossJurisdictionBookOrderByRouteId } from '../../orderbook/cross-j';
import { cloneEntityState, addMessage } from '../../state-helpers';

export const handleRemoveCrossJurisdictionBookOrderEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx & { type: 'removeCrossJurisdictionBookOrder' },
) => {
  const newState = cloneEntityState(entityState);
  const removed = removeCrossJurisdictionBookOrderByRouteId(
    env,
    newState,
    entityTx.data.sourceEntityId,
    entityTx.data.orderId,
  );
  addMessage(
    newState,
    `🌉 Cross-j book remove ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''} ` +
      `${removed ? 'removed' : 'not-present'}`,
  );
  return { newState, outputs: [] };
};
