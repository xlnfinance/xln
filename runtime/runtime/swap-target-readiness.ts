import { assertCrossJurisdictionSwapTargetReady } from '../account/swap-command-plan';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeState } from '../types';

const normalizeId = (value: string): string => value.trim().toLowerCase();

/** Resolve the target Account from the owning Runtime before invoking the pure Account check. */
export const assertCrossJurisdictionSwapTargetReadyInEnv = (
  env: RuntimeState,
  route: CrossJurisdictionSwapRoute,
): void => {
  const targetEntityId = normalizeId(route.target.counterpartyEntityId);
  const targetSignerId = normalizeId(route.targetSignerId || '');
  const hubEntityId = normalizeId(route.target.entityId);
  const replica = [...env.eReplicas.values()].find(candidate => (
    normalizeId(candidate.entityId || candidate.state?.entityId || '') === targetEntityId &&
    (!targetSignerId || normalizeId(candidate.signerId || '') === targetSignerId)
  ));
  assertCrossJurisdictionSwapTargetReady(
    route,
    replica?.state?.accounts?.get(hubEntityId) ?? null,
  );
};
