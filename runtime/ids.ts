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

/** Entity identifier - 32-byte hex string (0x + 64 chars) */
export type EntityId = string & { readonly [EntityIdBrand]: typeof EntityIdBrand };

/** Signer identifier - wallet address or named signer */
export type SignerId = string & { readonly [SignerIdBrand]: typeof SignerIdBrand };

/** Jurisdiction ID - EVM chainId or lazy hash for local jurisdictions */
export type JId = string & { readonly [JIdBrand]: typeof JIdBrand };

/** EntityProvider contract address - 20-byte hex (0x + 40 chars) */
export type EntityProviderAddress = string & { readonly [EntityProviderAddressBrand]: typeof EntityProviderAddressBrand };

declare const TokenIdBrand: unique symbol;
/** Token identifier - non-negative integer */
export type TokenId = number & { readonly [TokenIdBrand]: typeof TokenIdBrand };

declare const LockIdBrand: unique symbol;
/** HTLC lock identifier */
export type LockId = string & { readonly [LockIdBrand]: typeof LockIdBrand };

declare const AccountKeyBrand: unique symbol;
/** Bilateral account key - canonical sorted entity pair "leftId:rightId" */
export type AccountKey = string & { readonly [AccountKeyBrand]: typeof AccountKeyBrand };

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity number for "numbered" entities (vs lazy hash entities) */
export const MAX_NUMBERED_ENTITY = 1_000_000n;

/** URI scheme for XLN addresses */
export const XLN_URI_SCHEME = 'xln://';

/** Default runtime host (for local single-runtime setup) */
export const DEFAULT_RUNTIME_HOST = 'localhost:8080';

/** Coordinator for cross-runtime messaging (future) */
export const XLN_COORDINATOR = 'xln.finance';

/** Well-known EVM chain IDs */
export const CHAIN_IDS = {
  mainnet: '1',
  sepolia: '11155111',
  polygon: '137',
  arbitrum: '42161',
  local: 'local', // For local dev/testing
} as const;

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

/** Check if number is valid TokenId (non-negative integer) */
export const isValidTokenId = (n: number): n is TokenId =>
  Number.isInteger(n) && n >= 0;

/** Create validated TokenId - throws if invalid */
export const toTokenId = (n: number): TokenId => {
  if (!isValidTokenId(n)) {
    throw new Error(`FINTECH-SAFETY: Invalid TokenId: ${n}`);
  }
  return n;
};

/** Check if string is valid LockId (non-empty string) */
export const isValidLockId = (s: string): s is LockId =>
  typeof s === 'string' && s.length > 0;

/** Create validated LockId - throws if invalid */
export const toLockId = (s: string): LockId => {
  if (!isValidLockId(s)) {
    throw new Error(`FINTECH-SAFETY: Invalid LockId: ${s}`);
  }
  return s;
};

/** Check if string is valid AccountKey (contains colon separator) */
export const isValidAccountKey = (s: string): s is AccountKey =>
  typeof s === 'string' && s.includes(':');

/** Create AccountKey from two entity IDs (canonical sorted order: left < right) */
export const toAccountKey = (entityA: string, entityB: string): AccountKey => {
  const sorted = entityA < entityB ? `${entityA}:${entityB}` : `${entityB}:${entityA}`;
  return sorted as AccountKey;
};

// =============================================================================
// REPLICA KEY OPERATIONS - Replace all split(':') patterns
// =============================================================================

/**
 * Parse legacy replica key string "entityId:signerId" → ReplicaKey
 * This is the ONLY place string splitting should happen!
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
 * Format ReplicaKey → legacy string "entityId:signerId"
 * Use for IndexedDB keys and Map lookups (temporary until full migration)
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
 * Extract just entityId from legacy key string
 * Convenience for cases where only entityId is needed
 */
export const extractEntityId = (keyString: string): EntityId => {
  return parseReplicaKey(keyString).entityId;
};

/**
 * Extract just signerId from legacy key string
 * Convenience for cases where only signerId is needed
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
// DISPLAY FORMATTING
// =============================================================================

/**
 * Format entityId for display
 * - Numbered: "#42"
 * - Lazy: "a1b2c3d4..." (first 8 chars of hash)
 */
export const formatEntityDisplay = (entityId: EntityId): string => {
  const type = detectEntityType(entityId);

  if (type === 'numbered') {
    const num = Number(BigInt(entityId));
    return `#${num}`;
  }

  // Lazy: show truncated hash (skip 0x, take first 8 chars)
  return entityId.slice(2, 10) + '...';
};

/**
 * Get numeric representation for display/sorting
 * - Numbered: actual number (1, 2, 3...)
 * - Lazy: deterministic number from hash suffix (for consistent display)
 */
export const getEntityDisplayNumber = (entityId: EntityId): number => {
  try {
    const num = BigInt(entityId);

    if (num > 0n && num < MAX_NUMBERED_ENTITY) {
      return Number(num);
    }

    // Lazy: use last 4 bytes for deterministic display number
    const hashSuffix = entityId.slice(-8);
    return (parseInt(hashSuffix, 16) % 9000000) + 1000000; // 1M-10M range
  } catch {
    throw new Error(`FINTECH-SAFETY: Invalid entityId for display: ${entityId}`);
  }
};

/**
 * Format signerId for display
 * - Wallet address: truncated "0x1234...abcd"
 * - Named signer: as-is "alice_proposer"
 */
export const formatSignerDisplay = (signerId: SignerId): string => {
  if (signerId.startsWith('0x') && signerId.length === 42) {
    return `${signerId.slice(0, 6)}...${signerId.slice(-4)}`;
  }
  return signerId;
};

/**
 * Format full ReplicaKey for display
 * Example: "#42:alice" or "a1b2c3d4...:0x1234...abcd"
 */
export const formatReplicaDisplay = (key: ReplicaKey): string => {
  return `${formatEntityDisplay(key.entityId)}:${formatSignerDisplay(key.signerId)}`;
};

// =============================================================================
// URI OPERATIONS (For future networking)
// =============================================================================

/**
 * Format full URI for cross-runtime addressing
 * xln://localhost:8080/1/0x5FbD.../0x0000...0001/alice
 */
export const formatReplicaUri = (uri: ReplicaUri): string => {
  return `${XLN_URI_SCHEME}${uri.runtimeHost}/${uri.jId}/${uri.epAddress}/${uri.entityId}/${uri.signerId}`;
};

/**
 * Parse URI string into ReplicaUri
 */
export const parseReplicaUri = (uriString: string): ReplicaUri => {
  if (!uriString.startsWith(XLN_URI_SCHEME)) {
    throw new Error(`FINTECH-SAFETY: Invalid URI scheme: ${uriString}`);
  }

  const rest = uriString.slice(XLN_URI_SCHEME.length);
  const parts = rest.split('/');

  if (parts.length < 5) {
    throw new Error(`FINTECH-SAFETY: Invalid URI format: ${uriString}`);
  }

  const [runtimeHost, jId, epAddress, entityId, signerId] = parts;

  return {
    runtimeHost: runtimeHost!,
    jId: toJId(jId!),
    epAddress: toEpAddress(epAddress!),
    entityId: toEntityId(entityId!),
    signerId: toSignerId(signerId!),
  };
};

/**
 * Create local URI (uses default runtime host)
 */
export const createLocalUri = (
  jId: JId,
  epAddress: EntityProviderAddress,
  entityId: EntityId,
  signerId: SignerId,
): ReplicaUri => ({
  runtimeHost: DEFAULT_RUNTIME_HOST,
  jId,
  epAddress,
  entityId,
  signerId,
});

// =============================================================================
// TYPE-SAFE COLLECTIONS
// =============================================================================

/**
 * Type-safe Map for replicas keyed by ReplicaKey
 * Uses string keys internally for IndexedDB compatibility
 */
export class ReplicaMap<T> {
  private readonly map = new Map<string, T>();

  get(key: ReplicaKey): T | undefined {
    return this.map.get(formatReplicaKey(key));
  }

  set(key: ReplicaKey, value: T): this {
    this.map.set(formatReplicaKey(key), value);
    return this;
  }

  has(key: ReplicaKey): boolean {
    return this.map.has(formatReplicaKey(key));
  }

  delete(key: ReplicaKey): boolean {
    return this.map.delete(formatReplicaKey(key));
  }

  get size(): number {
    return this.map.size;
  }

  *entries(): IterableIterator<[ReplicaKey, T]> {
    for (const [keyString, value] of this.map.entries()) {
      yield [parseReplicaKey(keyString), value];
    }
  }

  *keys(): IterableIterator<ReplicaKey> {
    for (const keyString of this.map.keys()) {
      yield parseReplicaKey(keyString);
    }
  }

  *values(): IterableIterator<T> {
    yield* this.map.values();
  }

  forEach(callback: (value: T, key: ReplicaKey, map: ReplicaMap<T>) => void): void {
    this.map.forEach((value, keyString) => {
      callback(value, parseReplicaKey(keyString), this);
    });
  }

  /** Get underlying Map for serialization */
  toMap(): Map<string, T> {
    return new Map(this.map);
  }

  /** Create from existing Map */
  static fromMap<T>(map: Map<string, T>): ReplicaMap<T> {
    const rm = new ReplicaMap<T>();
    for (const [k, v] of map.entries()) {
      rm.map.set(k, v);
    }
    return rm;
  }
}

/**
 * Type-safe Map for entities keyed by EntityId
 */
export class EntityMap<T> {
  private readonly map = new Map<EntityId, T>();

  get(key: EntityId): T | undefined {
    return this.map.get(key);
  }

  set(key: EntityId, value: T): this {
    this.map.set(key, value);
    return this;
  }

  has(key: EntityId): boolean {
    return this.map.has(key);
  }

  delete(key: EntityId): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  *entries(): IterableIterator<[EntityId, T]> {
    yield* this.map.entries();
  }

  *keys(): IterableIterator<EntityId> {
    yield* this.map.keys();
  }

  *values(): IterableIterator<T> {
    yield* this.map.values();
  }

  forEach(callback: (value: T, key: EntityId, map: EntityMap<T>) => void): void {
    this.map.forEach((value, key) => callback(value, key, this));
  }
}

// =============================================================================
// JURISDICTION HELPERS
// =============================================================================

/** Well-known jurisdiction configurations */
export interface JurisdictionInfo {
  jId: JId;
  name: string;
  chainId?: number; // For EVM chains
  rpcUrl?: string;
}

/** Create JId from EVM chainId */
export const jIdFromChainId = (chainId: number): JId => {
  return toJId(chainId.toString());
};

/** Create lazy JId for local/test jurisdictions */
export const createLazyJId = (name: string): JId => {
  // Simple hash for now - could use keccak256 for stronger uniqueness
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return toJId(`lazy_${Math.abs(hash).toString(16)}`);
};

// =============================================================================
// MIGRATION HELPERS (temporary - remove after full migration)
// =============================================================================

/**
 * Safely parse replica key with fallback for invalid data
 * Use ONLY during migration - prefer parseReplicaKey for validated code paths
 */
export const safeParseReplicaKey = (keyString: string): ReplicaKey | null => {
  try {
    return parseReplicaKey(keyString);
  } catch {
    console.warn(`[ids] Invalid replica key during migration: ${keyString}`);
    return null;
  }
};

/**
 * Extract entityId from legacy key string with fallback
 * Use ONLY during migration
 */
export const safeExtractEntityId = (keyString: string): EntityId | null => {
  const key = safeParseReplicaKey(keyString);
  return key?.entityId ?? null;
};
