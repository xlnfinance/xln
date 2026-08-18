import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import {
  getJReplicaByJurisdictionRef,
  getJReplicaByName,
  isJurisdictionStackRef,
} from '../jurisdiction-runtime';

/**
 * Jurisdiction height visible to an Entity reducer.
 *
 * Validator-local watchers are deliberately allowed to scan at different
 * heights. Reading `env.jReplicas[].blockNumber` during Entity replay would
 * therefore make one signed frame depend on private, non-consensus state.
 * Only the exact prefix certified into EntityState may affect a transition.
 */
export function getEntityCertifiedJurisdictionHeight(
  state: Pick<EntityState, 'lastFinalizedJHeight' | 'jHistoryFinality'>,
): number {
  const height = Number(state.lastFinalizedJHeight ?? 0);
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error(`ENTITY_J_FINALIZED_HEIGHT_INVALID:${String(state.lastFinalizedJHeight)}`);
  }
  const certifiedHeight = state.jHistoryFinality?.finalizedThroughHeight;
  if (certifiedHeight !== undefined && certifiedHeight !== height) {
    throw new Error(`ENTITY_J_FINALITY_HEIGHT_MISMATCH:state=${height}:certificate=${certifiedHeight}`);
  }
  return height;
}

const getJReplicaByJurisdictionNameOrRef = (env: RuntimeReplica, jurisdictionName?: string): ReturnType<typeof getJReplicaByName> => {
  const raw = String(jurisdictionName || '').trim();
  if (!raw) return undefined;
  return isJurisdictionStackRef(raw)
    ? getJReplicaByJurisdictionRef(env, raw)
    : getJReplicaByName(env, raw);
};

export function getRuntimeJurisdictionHeight(env: RuntimeReplica, defaultHeight = 0, jurisdictionName?: string): number {
  const baseline = Number.isFinite(defaultHeight) ? Math.max(0, Math.floor(defaultHeight)) : 0;
  if (jurisdictionName) {
    const requested = getJReplicaByJurisdictionNameOrRef(env, jurisdictionName);
    if (!requested) return baseline;
    const blockNumber = Number(requested?.blockNumber ?? 0n);
    return Number.isFinite(blockNumber) ? Math.max(0, Math.floor(blockNumber)) : baseline;
  }

  const active = env.activeJurisdiction ? env.state.jReplicas?.get(env.activeJurisdiction) : undefined;
  const candidates = active
    ? [active, ...Array.from(env.state.jReplicas?.values?.() || [])]
    : Array.from(env.state.jReplicas?.values?.() || []);
  let best = baseline;
  for (const replica of candidates) {
    const blockNumber = Number(replica?.blockNumber ?? 0n);
    if (Number.isFinite(blockNumber) && blockNumber > best) best = Math.floor(blockNumber);
  }
  return best;
}
