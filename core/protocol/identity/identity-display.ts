import {
  detectEntityType,
  MAX_NUMBERED_ENTITY,
  type EntityId,
  type ReplicaKey,
  type SignerId,
} from './';

/** Human-readable Entity label. Consensus code must keep using the full ID. */
export const formatEntityDisplay = (entityId: EntityId): string => {
  if (detectEntityType(entityId) === 'numbered') {
    return `#${Number(BigInt(entityId))}`;
  }
  return `${entityId.slice(2, 10)}...`;
};

/** Stable display/sort number; never use this lossy projection for identity. */
export const getEntityDisplayNumber = (entityId: EntityId): number => {
  try {
    const numericId = BigInt(entityId);
    if (numericId > 0n && numericId < MAX_NUMBERED_ENTITY) {
      return Number(numericId);
    }
    return (parseInt(entityId.slice(-8), 16) % 9_000_000) + 1_000_000;
  } catch {
    throw new Error(`FINTECH-SAFETY: Invalid entityId for display: ${entityId}`);
  }
};

export const formatSignerDisplay = (signerId: SignerId): string =>
  signerId.startsWith('0x') && signerId.length === 42
    ? `${signerId.slice(0, 6)}...${signerId.slice(-4)}`
    : signerId;

export const formatReplicaDisplay = (key: ReplicaKey): string =>
  `${formatEntityDisplay(key.entityId)}:${formatSignerDisplay(key.signerId)}`;
