import { assertCrossJurisdictionSwapTargetReady } from './swap-command-plan';
import { normalizeEntityRef } from '../../support/boundary-guards';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { RuntimeReplica } from '../types';

/** Resolve the target Account from the owning Runtime before invoking the pure Account check. */
export const assertCrossJurisdictionSwapTargetReadyInEnv = (
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
): void => {
  const targetEntityId = normalizeEntityRef(route.target.counterpartyEntityId);
  const targetSignerId = normalizeEntityRef(route.targetSignerId || '');
  const hubEntityId = normalizeEntityRef(route.target.entityId);
  const replica = [...env.state.eReplicas.values()].find(candidate => (
    normalizeEntityRef(candidate.entityId || candidate.state?.entityId || '') === targetEntityId &&
    (!targetSignerId || normalizeEntityRef(candidate.signerId || '') === targetSignerId)
  ));
  assertCrossJurisdictionSwapTargetReady(
    route,
    replica?.state?.accounts?.get(hubEntityId)?.state ?? null,
  );
};
