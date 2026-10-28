/**
 * Canonical Entity identifier ordering shared by every RJEA layer.
 *
 * Bilateral Account consensus relies on this exact lexicographic order:
 * the lower canonical Entity ID is LEFT. Never replace it with local signer,
 * connection direction, or proposal arrival order; those differ across peers.
 */
import { toEntityId, type EntityId } from './index';


export const compareEntityIds = (first: EntityId, second: EntityId): number => {
  if (first === second) return 0;
  return first < second ? -1 : 1;
};

export const isLeftEntity = (entityId: string, counterpartyId: string): boolean =>
  compareEntityIds(toEntityId(entityId), toEntityId(counterpartyId)) < 0;
