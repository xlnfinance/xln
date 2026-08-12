/**
 * XLN Identity System
 *
 * Canonical addressing for entities and replicas across jurisdictions.
 * Runtime is single source of truth - frontend imports from here.
 *
 * URI Format: xln://{host}:{port}/{jId}/{epAddress}/{entityId}/{signerId}
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
declare const EntityProviderAddressBrand: unique symbol;
declare const AccountKeyBrand: unique symbol;
declare const LockIdBrand: unique symbol;
declare const ProposalIdBrand: unique symbol;
declare const JurisdictionNameBrand: unique symbol;

/** Entity identifier - 32-byte hex string (0x + 64 chars) */
export type EntityId = string & { readonly [EntityIdBrand]: typeof EntityIdBrand };

/** Signer identifier - wallet address or named signer */
export type SignerId = string & { readonly [SignerIdBrand]: typeof SignerIdBrand };

/** Jurisdiction ID - EVM chainId or lazy hash for local jurisdictions */
export type JId = string & { readonly [JIdBrand]: typeof JIdBrand };

/** EntityProvider contract address - 20-byte hex (0x + 40 chars) */
export type EntityProviderAddress = string & { readonly [EntityProviderAddressBrand]: typeof EntityProviderAddressBrand };

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity number for "numbered" entities (vs lazy hash entities) */
export const MAX_NUMBERED_ENTITY = 1_000_000n;

/** URI scheme for XLN addresses */
export const XLN_URI_SCHEME = 'xln://';

/** Default runtime host (for local single-runtime setup) */
export const DEFAULT_RUNTIME_HOST = 'localhost:8080';

// =============================================================================
// REPLICA KEY - Structured, type-safe
// =============================================================================

/** Structured replica key - NO MORE string splitting! */
export interface ReplicaKey {
  readonly entityId: EntityId;
  readonly signerId: SignerId;
}

/** Full address including jurisdiction context */
export interface FullReplicaAddress extends ReplicaKey {
  readonly jId: JId;
  readonly epAddress: EntityProviderAddress;
}

/** Complete URI with runtime host for networking */
export interface ReplicaUri extends FullReplicaAddress {
  readonly runtimeHost: string; // host:port
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
export const isValidJId = (s: string): s is JId => {
  return typeof s === 'string' && s.length > 0;
};

/** Check if string is valid EntityProviderAddress (0x + 40 hex chars) */
export const isValidEpAddress = (s: string): s is EntityProviderAddress => {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(s);
};

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

/** Create validated EntityProviderAddress - throws if invalid */
export const toEpAddress = (s: string): EntityProviderAddress => {
  if (!isValidEpAddress(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid EntityProviderAddress: ${s}`);
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

/**
 * Check if entityId is a lazy entity (hash-based)
 */
export const isLazyEntity = (entityId: EntityId): boolean => {
  return detectEntityType(entityId) === 'lazy';
};

// =============================================================================
// TOLERANT API BOUNDARY HELPERS
// =============================================================================
