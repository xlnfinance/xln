/**
 * XLN Identity System
 *
 * Canonical addressing for entities and replicas across jurisdictions.
 * Runtime is single source of truth - frontend imports from here.
 *
 * Entity Types:
 * - Numbered: entityId < 1,000,000 (display as #1, #2, etc.)
 * - Lazy: entityId = keccak256(governance_structure) (display as abc123...)
 */

// =============================================================================
// BRANDED TYPES - Compile-time type safety
// =============================================================================

declare const EntityIdBrand: unique symbol;
declare const SignerIdBrand: unique symbol;
declare const JIdBrand: unique symbol;
declare const RuntimeIdBrand: unique symbol;

/** Entity identifier - 32-byte hex string (0x + 64 chars) */
export type EntityId = string & { readonly [EntityIdBrand]: typeof EntityIdBrand };

/** Signer identifier - wallet address or named signer */
export type SignerId = string & { readonly [SignerIdBrand]: typeof SignerIdBrand };

/** Jurisdiction ID - EVM chainId or lazy hash for local jurisdictions */
export type JId = string & { readonly [JIdBrand]: typeof JIdBrand };

/** Runtime transport identity - canonical lowercase 20-byte EVM address. */
export type RuntimeId = string & { readonly [RuntimeIdBrand]: typeof RuntimeIdBrand };

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity number for "numbered" entities (vs lazy hash entities) */
export const MAX_NUMBERED_ENTITY = 1_000_000n;

// =============================================================================
// REPLICA KEY - Structured, type-safe
// =============================================================================

/** Structured replica key - NO MORE string splitting! */
export interface ReplicaKey {
  readonly entityId: EntityId;
  readonly signerId: SignerId;
}

// =============================================================================
// TYPE GUARDS & VALIDATORS
// =============================================================================

/** Check if string is valid EntityId format (0x + 64 hex chars) */
export const isValidEntityId = (s: string): s is EntityId => {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{64}$/.test(s);
};

/** Check if string is valid SignerId (non-empty string) */
export const isValidSignerId = (s: string): s is SignerId => {
  return typeof s === 'string' && s.length > 0;
};

/** Check if string is valid JId (chainId number or hash) */
const isValidJId = (s: string): s is JId => {
  return typeof s === 'string' && s.length > 0;
};

/** Runtime IDs are canonical lowercase EVM addresses at every routing boundary. */
export const isValidRuntimeId = (s: string): s is RuntimeId =>
  /^0x[0-9a-f]{40}$/.test(s);

// =============================================================================
// CONSTRUCTORS - Validate at source, trust at use
// =============================================================================

/** Create validated EntityId - throws if invalid */
export const toEntityId = (s: string): EntityId => {
  if (!isValidEntityId(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid EntityId format: ${s}`);
  }
  return s;
};

/** Create validated SignerId - throws if invalid */
export const toSignerId = (s: string): SignerId => {
  if (!isValidSignerId(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid SignerId: ${s}`);
  }
  return s;
};

/** Create validated JId - throws if invalid */
export const toJId = (s: string): JId => {
  if (!isValidJId(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid JId: ${s}`);
  }
  return s;
};

export const toRuntimeId = (s: string): RuntimeId => {
  if (!isValidRuntimeId(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid RuntimeId: ${s}`);
  }
  return s;
};

// =============================================================================
// REPLICA KEY OPERATIONS - Replace all split(':') patterns
// =============================================================================

/**
 * Parse replica key string "entityId:signerId" → ReplicaKey.
 * This is the only place string splitting should happen.
 */
export const parseReplicaKey = (keyString: string): ReplicaKey => {
  const colonIndex = keyString.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`FINTECH-SAFETY: Invalid replica key format (no colon): ${keyString}`);
  }

  const entityIdRaw = keyString.slice(0, colonIndex);
  const signerIdRaw = keyString.slice(colonIndex + 1);

  if (!entityIdRaw || !signerIdRaw) {
    throw new Error(`FINTECH-SAFETY: Invalid replica key format (empty parts): ${keyString}`);
  }

  return {
    entityId: toEntityId(entityIdRaw),
    signerId: toSignerId(signerIdRaw),
  };
};

/**
 * Format ReplicaKey → storage key string "entityId:signerId".
 */
export const formatReplicaKey = (key: ReplicaKey): string => {
  return `${key.entityId}:${key.signerId}`;
};

/**
 * Create ReplicaKey from parts (validates at construction)
 */
export const createReplicaKey = (entityId: string, signerId: string): ReplicaKey => ({
  entityId: toEntityId(entityId),
  signerId: toSignerId(signerId),
});

/**
 * Extract just entityId from a replica key string.
 */
export const extractEntityId = (keyString: string): EntityId => {
  return parseReplicaKey(keyString).entityId;
};

/**
 * Extract just signerId from a replica key string.
 */
export const extractSignerId = (keyString: string): SignerId => {
  return parseReplicaKey(keyString).signerId;
};

// =============================================================================
// ENTITY TYPE DETECTION
// =============================================================================

export type EntityType = 'numbered' | 'lazy' | 'named';

/**
 * Detect entity type from entityId
 * - numbered: small integers (1-999,999) stored as 0x-padded hex
 * - lazy: keccak256 hashes of governance structure
 * - named: reserved for future on-chain name registry
 */
export const detectEntityType = (entityId: EntityId): EntityType => {
  try {
    const num = BigInt(entityId);
    if (num > 0n && num < MAX_NUMBERED_ENTITY) {
      return 'numbered';
    }
    return 'lazy';
  } catch {
    return 'lazy';
  }
};

/**
 * Check if entityId is a numbered entity
 */
export const isNumberedEntity = (entityId: EntityId): boolean => {
  return detectEntityType(entityId) === 'numbered';
};
