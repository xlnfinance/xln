import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { handlePrepareDispute } from './dispute';
import { normalizeEntityRef } from '../account-key';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { RuntimeOverlayRecord } from '../../../types/account';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';

type ForceSiblingDisputeTx = Extract<EntityTx, { type: 'crossJurisdictionForceSiblingDispute' }>;

type ForceSiblingDisputeResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

/**
 * Resolve the local Account counterparty this entity must dispute for the
 * named route. Returns null when this entity is not a route participant.
 */
const localDisputeCounterparty = (
  route: CrossJurisdictionSwapRoute,
  self: string,
): string | null => {
  if (normalizeEntityRef(route.source.entityId) === self) {
    return normalizeEntityRef(route.source.counterpartyEntityId);
  }
  if (normalizeEntityRef(route.source.counterpartyEntityId) === self) {
    return normalizeEntityRef(route.source.entityId);
  }
  if (normalizeEntityRef(route.target.counterpartyEntityId) === self) {
    return normalizeEntityRef(route.target.entityId);
  }
  if (normalizeEntityRef(route.target.entityId) === self) {
    return normalizeEntityRef(route.target.counterpartyEntityId);
  }
  return null;
};

/**
 * Sibling-leg dispute fanout. Seeing a dispute on any route leg is the signal
 * to start the sibling clock: each participant preparesDispute on its own
 * Account so reveals and ports can land before either chain's T expires.
 */
export const handleCrossJurisdictionForceSiblingDisputeEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: ForceSiblingDisputeTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<ForceSiblingDisputeResult> => {
  const { routeId } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const self = normalizeEntityRef(newState.entityId);
  const route = newState.crossJurisdictionSwaps?.get(routeId);
  if (!route) {
    addMessage(newState, `⚔️ Sibling dispute fanout ${routeId} skipped: route missing`);
    return { newState, outputs: [] };
  }
  const counterpartyEntityId = localDisputeCounterparty(route, self);
  if (!counterpartyEntityId) {
    addMessage(newState, `⚔️ Sibling dispute fanout ${routeId} skipped: not a participant`);
    return { newState, outputs: [] };
  }
  const prepared = await handlePrepareDispute(
    newState,
    {
      type: 'prepareDispute',
      data: {
        counterpartyEntityId,
        description: `sibling-dispute:${routeId}`,
        crossJurisdictionRouteId: routeId,
      },
    },
    env,
    storageChanges,
    true,
  );
  return { newState: prepared.newState, outputs: prepared.outputs };
};
