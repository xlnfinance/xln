import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { prepareEntityTxState } from '../../../state-clone';
import { handlePrepareDispute } from '../dispute';
import { normalizeEntityRef } from '../../account-key';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';

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
 * Fanout evidence names the peer on the *observed* (other) leg — never the
 * local Account to dispute. User↔user / hub↔hub fanout always has
 * observed ≠ localDisputeCounterparty by construction.
 */
const observedIsOtherLegParticipant = (
  route: CrossJurisdictionSwapRoute,
  self: string,
  observed: string,
): boolean => {
  if (!observed || observed === self) return false;
  const source = [
    normalizeEntityRef(route.source.entityId),
    normalizeEntityRef(route.source.counterpartyEntityId),
  ];
  const target = [
    normalizeEntityRef(route.target.entityId),
    normalizeEntityRef(route.target.counterpartyEntityId),
  ];
  const onSource = source.includes(self);
  const onTarget = target.includes(self);
  if (onSource && !onTarget) return target.includes(observed);
  if (onTarget && !onSource) return source.includes(observed);
  // Dual-leg participant is not a cross-j role; reject rather than guess.
  return false;
};

/**
 * Sibling-leg dispute fanout (must-close).
 *
 * Invariant: observing DisputeStarted on any live cross-j leg MUST start the
 * sibling Account's dispute clock in the same runtime. Legs are not atomic
 * 2PC — silence still settles 0 — but clocks must start together so the
 * Source and Target can each publish within the beneficiary-side window of
 * their own independently started Account dispute.
 *
 * Fail-loud (never soft-skip): missing route mirror, missing source+target
 * pulls, non-participant self, or observed peer not on the other leg. Soft-skip
 * previously left the sibling clock unstarted → economic residual disguised as
 * "ops".
 */
export const handleCrossJurisdictionForceSiblingDisputeEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: ForceSiblingDisputeTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<ForceSiblingDisputeResult> => {
  const { routeId, observedCounterpartyEntityId } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const self = normalizeEntityRef(newState.entityId);
  const route = newState.crossJurisdictionSwaps?.get(routeId);
  if (!route) {
    // Soft-skip here would break the paired-clock invariant (I1): one leg's
    // DisputeStarted must force-start the sibling. Missing route mirror after
    // a live observed dispute is a critical state-loss, not a no-op.
    throw haltRuntimeFailure("CROSS_J_SIBLING_DISPUTE_ROUTE_MISSING", `CROSS_J_SIBLING_DISPUTE_ROUTE_MISSING:${routeId}`);
  }
  if (!route.sourcePull || !route.targetPull) {
    throw haltRuntimeFailure("CROSS_J_SIBLING_DISPUTE_PULLS_MISSING", `CROSS_J_SIBLING_DISPUTE_PULLS_MISSING:${routeId}`);
  }
  const counterpartyEntityId = localDisputeCounterparty(route, self);
  if (!counterpartyEntityId) {
    throw haltRuntimeFailure("CROSS_J_SIBLING_DISPUTE_NOT_PARTICIPANT", `CROSS_J_SIBLING_DISPUTE_NOT_PARTICIPANT:${routeId}:self=${self}`);
  }
  const observed = normalizeEntityRef(observedCounterpartyEntityId || '');
  if (!observedIsOtherLegParticipant(route, self, observed)) {
    throw haltRuntimeFailure("CROSS_J_SIBLING_DISPUTE_OBSERVED_LEG_INVALID", `CROSS_J_SIBLING_DISPUTE_OBSERVED_LEG_INVALID:${routeId}:` +
      `observed=${observed}:self=${self}:local=${counterpartyEntityId}`);
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
