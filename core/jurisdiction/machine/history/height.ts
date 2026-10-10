import type { EntityState } from '../../../entity/types';

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
