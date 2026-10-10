import { detectEntityType, type EntityId } from './';

/** Human-readable Entity label. Consensus code must keep using the full ID. */
export const formatEntityDisplay = (entityId: EntityId): string => {
  if (detectEntityType(entityId) === 'numbered') {
    return `#${Number(BigInt(entityId))}`;
  }
  return `${entityId.slice(2, 10)}...`;
};
