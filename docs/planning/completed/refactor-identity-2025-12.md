# XLN Identity System Refactor Plan

## Status: PHASE 1 COMPLETE
- Created: 2025-12-03
- Phase 1 Completed: 2025-12-03
- Author: Claude (Opus 4.5)

### Completed:
- [x] `runtime/ids.ts` - Core identity system (~520 lines)
- [x] `runtime/runtime.ts` - Imports and exports all ids.ts functions
- [x] `xlnStore.ts` - Migrated 2 split patterns, exposed functions via xlnFunctions

### Remaining (Phase 2):
- [ ] ~26 split(':') patterns in frontend components (gradual migration)

---

## Executive Summary

Complete overhaul of entity/replica identification system. Current `entityId:signerId` string concatenation is error-prone and lacks jurisdiction context. New system uses structured types with URI-based addressing.

---

## Current Problems

### 1. String Splitting Everywhere
```typescript
// CURRENT: Error-prone, no type safety
const replicaKey = `${entityId}:${signerId}`;
const [entityId, signerId] = replicaKey.split(':');  // Can be [0] or [1] - bugs!
```

Found 25+ instances of `split(':')` across:
- `runtime/runtime.ts:742,812`
- `runtime/entity-consensus.ts:103,222`
- `runtime/state-helpers.ts:236,247`
- `frontend/src/lib/stores/xlnStore.ts:118,148`
- `frontend/src/lib/view/panels/Graph3DPanel.svelte`
- And more...

### 2. No Jurisdiction Context
- `entityId` alone is ambiguous across jurisdictions
- Same numbered entity `#1` exists in every jurisdiction
- No way to reference entity across J-machines

### 3. Inconsistent Display Logic
- `formatEntityDisplay()` exists in multiple places
- Numbered vs lazy detection duplicated
- No single source of truth for UI rendering

### 4. Missing Runtime Context
- For multi-runtime scenarios (future), no way to identify which runtime
- WebSocket connections need full addressing

---

## New Architecture

### Core Principle: URI-Based Addressing

```
xln://{runtimeHost}:{port}/{chainId}/{entityProviderAddress}/{entityId}/{signerId}
```

Example:
```
xln://localhost:8080/1/0x5FbDB2315678afecb367f032d93F642f64180aa3/0x0000000000000000000000000000000000000000000000000000000000000001/alice_proposer
```

Shortened for display:
```
xln://localhost:8080/1/0x5FbD.../1/alice_proposer
```

---

## New File: `runtime/ids.ts`

```typescript
/**
 * XLN Identity System
 *
 * Canonical addressing for entities and replicas across jurisdictions.
 *
 * URI Format: xln://{host}:{port}/{chainId}/{epAddress}/{entityId}/{signerId}
 *
 * Entity Types:
 * - Numbered: entityId < 1,000,000 (display as #1, #2, etc.)
 * - Lazy: entityId = keccak256(governance_structure) (display as abc123...)
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity number for "numbered" entities (vs lazy hash entities) */
export const MAX_NUMBERED_ENTITY = 1_000_000n;

/** URI scheme for XLN addresses */
export const XLN_URI_SCHEME = 'xln://';

// =============================================================================
// ENTITY TYPES
// =============================================================================

/**
 * Entity type discriminator
 * - numbered: Small integers (1, 2, 3...) - registered on-chain, show as #N
 * - lazy: keccak256 hash of governance structure - show truncated
 */
export type EntityType = 'numbered' | 'lazy';

/**
 * Chain/Jurisdiction identifier
 * Maps to EVM chainId or demo identifier
 */
export interface ChainId {
  /** Numeric chain ID (1 = mainnet, 31337 = hardhat, etc.) */
  readonly id: number;
  /** Human-readable name (optional, for display) */
  readonly name?: string;
}

/** Well-known chain IDs */
export const CHAINS = {
  MAINNET: { id: 1, name: 'Ethereum Mainnet' },
  SEPOLIA: { id: 11155111, name: 'Sepolia' },
  HARDHAT: { id: 31337, name: 'Hardhat Local' },
  BROWSERVM: { id: 0, name: 'BrowserVM Demo' },
} as const satisfies Record<string, ChainId>;

// =============================================================================
// BRANDED TYPES (Nominal Typing for Type Safety)
// =============================================================================

/**
 * Branded type for EntityId - prevents mixing with other hex strings
 * Format: 0x + 64 hex chars (bytes32)
 */
export type EntityId = string & { readonly __brand: 'EntityId' };

/**
 * Branded type for SignerId - prevents mixing with other strings
 * Format: human-readable identifier (e.g., "alice_proposer", "bank_validator")
 */
export type SignerId = string & { readonly __brand: 'SignerId' };

/**
 * Branded type for EntityProviderAddress - EVM contract address
 * Format: 0x + 40 hex chars (20 bytes)
 */
export type EntityProviderAddress = string & { readonly __brand: 'EntityProviderAddress' };

/**
 * Branded type for ReplicaKey - legacy format, being phased out
 * Format: {entityId}:{signerId}
 */
export type ReplicaKey = string & { readonly __brand: 'ReplicaKey' };

// =============================================================================
// ADDRESS STRUCTURES
// =============================================================================

/**
 * Jurisdiction Address - identifies a J-machine deployment
 * Unique per (chainId, entityProviderAddress) tuple
 */
export interface JurisdictionAddress {
  /** Chain ID (1 = mainnet, 31337 = hardhat, 0 = browservm) */
  readonly chainId: number;
  /** EntityProvider contract address on this chain */
  readonly entityProviderAddress: EntityProviderAddress;
}

/**
 * Entity Address - identifies an entity within a jurisdiction
 * Globally unique when combined with JurisdictionAddress
 */
export interface EntityAddress extends JurisdictionAddress {
  /** Entity ID (numbered: 0x000...001, lazy: 0xabc123...) */
  readonly entityId: EntityId;
}

/**
 * Replica Address - identifies a specific replica of an entity
 * A replica is an entity + signer combination (who's running the state machine)
 */
export interface ReplicaAddress extends EntityAddress {
  /** Signer running this replica (e.g., "alice_proposer") */
  readonly signerId: SignerId;
}

/**
 * Full Replica URI - includes runtime location
 * Used for multi-runtime scenarios and WebSocket addressing
 */
export interface ReplicaURI extends ReplicaAddress {
  /** Runtime host (e.g., "localhost", "node1.xln.io") */
  readonly runtimeHost: string;
  /** Runtime port (e.g., 8080) */
  readonly runtimePort: number;
}

// =============================================================================
// TYPE GUARDS & VALIDATORS
// =============================================================================

/**
 * Validate and brand an entity ID
 * @throws Error if invalid format
 */
export function validateEntityId(id: string): EntityId {
  if (!id.startsWith('0x')) {
    throw new Error(`Invalid EntityId: must start with 0x, got: ${id}`);
  }
  if (id.length !== 66) {
    throw new Error(`Invalid EntityId: must be 66 chars (0x + 64 hex), got ${id.length}: ${id}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error(`Invalid EntityId: invalid hex characters: ${id}`);
  }
  return id as EntityId;
}

/**
 * Validate and brand a signer ID
 * @throws Error if invalid format
 */
export function validateSignerId(id: string): SignerId {
  if (!id || id.length === 0) {
    throw new Error('Invalid SignerId: cannot be empty');
  }
  if (id.includes(':')) {
    throw new Error(`Invalid SignerId: cannot contain ':' delimiter: ${id}`);
  }
  if (id.length > 64) {
    throw new Error(`Invalid SignerId: too long (max 64 chars): ${id}`);
  }
  return id as SignerId;
}

/**
 * Validate and brand an EntityProvider address
 * @throws Error if invalid format
 */
export function validateEntityProviderAddress(addr: string): EntityProviderAddress {
  if (!addr.startsWith('0x')) {
    throw new Error(`Invalid EntityProviderAddress: must start with 0x, got: ${addr}`);
  }
  if (addr.length !== 42) {
    throw new Error(`Invalid EntityProviderAddress: must be 42 chars, got ${addr.length}: ${addr}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`Invalid EntityProviderAddress: invalid hex: ${addr}`);
  }
  return addr as EntityProviderAddress;
}

/**
 * Check if a value is a valid EntityId (without throwing)
 */
export function isValidEntityId(id: unknown): id is EntityId {
  if (typeof id !== 'string') return false;
  return /^0x[0-9a-fA-F]{64}$/.test(id);
}

/**
 * Check if a value is a valid SignerId (without throwing)
 */
export function isValidSignerId(id: unknown): id is SignerId {
  if (typeof id !== 'string') return false;
  return id.length > 0 && id.length <= 64 && !id.includes(':');
}

// =============================================================================
// ENTITY TYPE DETECTION
// =============================================================================

/**
 * Detect if an entity is numbered (small int) or lazy (hash)
 */
export function getEntityType(entityId: EntityId): EntityType {
  try {
    const num = BigInt(entityId);
    return num > 0n && num < MAX_NUMBERED_ENTITY ? 'numbered' : 'lazy';
  } catch {
    return 'lazy';
  }
}

/**
 * Get the numeric value of a numbered entity
 * @returns number if numbered entity, null if lazy
 */
export function getEntityNumber(entityId: EntityId): number | null {
  const type = getEntityType(entityId);
  if (type !== 'numbered') return null;
  return Number(BigInt(entityId));
}

/**
 * Check if entity is numbered type
 */
export function isNumberedEntity(entityId: EntityId): boolean {
  return getEntityType(entityId) === 'numbered';
}

/**
 * Check if entity is lazy type
 */
export function isLazyEntity(entityId: EntityId): boolean {
  return getEntityType(entityId) === 'lazy';
}

// =============================================================================
// ENTITY ID GENERATION
// =============================================================================

/**
 * Generate a numbered entity ID from a number
 * @param num - Entity number (1, 2, 3, ...)
 * @returns bytes32 hex string with left-padded zeros
 */
export function generateNumberedEntityId(num: number): EntityId {
  if (num <= 0 || num >= Number(MAX_NUMBERED_ENTITY)) {
    throw new Error(`Invalid entity number: must be 1-${MAX_NUMBERED_ENTITY - 1n}, got ${num}`);
  }
  const hex = num.toString(16).padStart(64, '0');
  return `0x${hex}` as EntityId;
}

/**
 * Generate a lazy entity ID from governance structure
 * Uses keccak256 hash of the serialized quorum configuration
 */
export function generateLazyEntityId(
  validators: string[],
  threshold: number
): EntityId {
  // Import dynamically to avoid circular deps
  const { keccak256, toUtf8Bytes } = require('ethers');
  const quorumData = { validators: validators.sort(), threshold };
  const serialized = JSON.stringify(quorumData);
  const hash = keccak256(toUtf8Bytes(serialized));
  return hash as EntityId;
}

// =============================================================================
// REPLICA KEY (LEGACY COMPATIBILITY LAYER)
// =============================================================================

/**
 * Create a replica key from entity and signer IDs
 * Format: {entityId}:{signerId}
 *
 * NOTE: This is the legacy format. Prefer using ReplicaAddress for new code.
 */
export function createReplicaKey(entityId: EntityId, signerId: SignerId): ReplicaKey {
  return `${entityId}:${signerId}` as ReplicaKey;
}

/**
 * Parse a replica key into its components
 * @throws Error if invalid format
 */
export function parseReplicaKey(key: string): { entityId: EntityId; signerId: SignerId } {
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid ReplicaKey: missing ':' delimiter: ${key}`);
  }

  const entityId = key.slice(0, colonIndex);
  const signerId = key.slice(colonIndex + 1);

  if (!entityId || !signerId) {
    throw new Error(`Invalid ReplicaKey: empty entityId or signerId: ${key}`);
  }

  return {
    entityId: validateEntityId(entityId),
    signerId: validateSignerId(signerId),
  };
}

/**
 * Check if a string is a valid replica key format
 */
export function isValidReplicaKey(key: unknown): key is ReplicaKey {
  if (typeof key !== 'string') return false;
  try {
    parseReplicaKey(key);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// ADDRESS CONSTRUCTORS
// =============================================================================

/**
 * Create a JurisdictionAddress
 */
export function createJurisdictionAddress(
  chainId: number,
  entityProviderAddress: string
): JurisdictionAddress {
  return {
    chainId,
    entityProviderAddress: validateEntityProviderAddress(entityProviderAddress),
  };
}

/**
 * Create an EntityAddress
 */
export function createEntityAddress(
  chainId: number,
  entityProviderAddress: string,
  entityId: string
): EntityAddress {
  return {
    chainId,
    entityProviderAddress: validateEntityProviderAddress(entityProviderAddress),
    entityId: validateEntityId(entityId),
  };
}

/**
 * Create a ReplicaAddress
 */
export function createReplicaAddress(
  chainId: number,
  entityProviderAddress: string,
  entityId: string,
  signerId: string
): ReplicaAddress {
  return {
    chainId,
    entityProviderAddress: validateEntityProviderAddress(entityProviderAddress),
    entityId: validateEntityId(entityId),
    signerId: validateSignerId(signerId),
  };
}

/**
 * Create a full ReplicaURI
 */
export function createReplicaURI(
  runtimeHost: string,
  runtimePort: number,
  chainId: number,
  entityProviderAddress: string,
  entityId: string,
  signerId: string
): ReplicaURI {
  return {
    runtimeHost,
    runtimePort,
    chainId,
    entityProviderAddress: validateEntityProviderAddress(entityProviderAddress),
    entityId: validateEntityId(entityId),
    signerId: validateSignerId(signerId),
  };
}

// =============================================================================
// URI SERIALIZATION
// =============================================================================

/**
 * Serialize a ReplicaURI to string format
 * Format: xln://{host}:{port}/{chainId}/{epAddress}/{entityId}/{signerId}
 */
export function serializeReplicaURI(uri: ReplicaURI): string {
  return `${XLN_URI_SCHEME}${uri.runtimeHost}:${uri.runtimePort}/${uri.chainId}/${uri.entityProviderAddress}/${uri.entityId}/${uri.signerId}`;
}

/**
 * Parse a URI string into ReplicaURI
 * @throws Error if invalid format
 */
export function parseReplicaURI(uriString: string): ReplicaURI {
  if (!uriString.startsWith(XLN_URI_SCHEME)) {
    throw new Error(`Invalid ReplicaURI: must start with ${XLN_URI_SCHEME}: ${uriString}`);
  }

  const withoutScheme = uriString.slice(XLN_URI_SCHEME.length);
  const match = withoutScheme.match(/^([^:]+):(\d+)\/(\d+)\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{64})\/(.+)$/);

  if (!match) {
    throw new Error(`Invalid ReplicaURI format: ${uriString}`);
  }

  const [, host, port, chainId, epAddress, entityId, signerId] = match;

  return createReplicaURI(
    host,
    parseInt(port, 10),
    parseInt(chainId, 10),
    epAddress,
    entityId,
    signerId
  );
}

/**
 * Serialize EntityAddress to compact string (for Map keys, etc.)
 * Format: {chainId}/{epAddress}/{entityId}
 */
export function serializeEntityAddress(addr: EntityAddress): string {
  return `${addr.chainId}/${addr.entityProviderAddress}/${addr.entityId}`;
}

/**
 * Serialize ReplicaAddress to compact string (for Map keys, etc.)
 * Format: {chainId}/{epAddress}/{entityId}/{signerId}
 */
export function serializeReplicaAddress(addr: ReplicaAddress): string {
  return `${addr.chainId}/${addr.entityProviderAddress}/${addr.entityId}/${addr.signerId}`;
}

// =============================================================================
// DISPLAY FORMATTING
// =============================================================================

/**
 * Format entity ID for display
 * - Numbered: "#1", "#42", "#999"
 * - Lazy: "abc123ef..." (first 8 chars of hash)
 */
export function formatEntityId(entityId: EntityId): string {
  const type = getEntityType(entityId);
  if (type === 'numbered') {
    return `#${Number(BigInt(entityId))}`;
  }
  // Lazy: show first 8 hex chars after 0x
  return entityId.slice(2, 10) + '...';
}

/**
 * Format entity ID with full detail
 * - Numbered: "#1 (0x000...001)"
 * - Lazy: "abc123ef... (0xabc123ef...)"
 */
export function formatEntityIdFull(entityId: EntityId): string {
  const short = formatEntityId(entityId);
  return `${short} (${entityId.slice(0, 10)}...${entityId.slice(-4)})`;
}

/**
 * Format signer ID for display
 * Handles special suffixes like _proposer, _validator
 */
export function formatSignerId(signerId: SignerId): string {
  // Remove common suffixes for cleaner display
  return signerId
    .replace(/_proposer$/, ' (P)')
    .replace(/_validator$/, ' (V)');
}

/**
 * Format replica address for display
 * Example: "#1:alice (P)" or "abc123...:bank (V)"
 */
export function formatReplicaAddress(addr: ReplicaAddress): string {
  return `${formatEntityId(addr.entityId)}:${formatSignerId(addr.signerId)}`;
}

/**
 * Format full replica URI for display (truncated)
 * Example: "xln://localhost:8080/1/0x5FbD.../#1/alice"
 */
export function formatReplicaURI(uri: ReplicaURI): string {
  const epShort = uri.entityProviderAddress.slice(0, 6) + '...';
  const entityShort = formatEntityId(uri.entityId);
  return `${XLN_URI_SCHEME}${uri.runtimeHost}:${uri.runtimePort}/${uri.chainId}/${epShort}/${entityShort}/${uri.signerId}`;
}

// =============================================================================
// ENTITY DISPLAY INFO (FOR UI COMPONENTS)
// =============================================================================

/**
 * Complete display information for an entity
 * Used by UI components to render entity references
 */
export interface EntityDisplayInfo {
  /** Entity type discriminator */
  readonly type: EntityType;
  /** Short display string (e.g., "#1" or "abc123...") */
  readonly shortId: string;
  /** Full entity ID (0x...) */
  readonly fullId: EntityId;
  /** Numeric value if numbered, null if lazy */
  readonly number: number | null;
  /** Human-assigned name if available */
  readonly name?: string;
}

/**
 * Get complete display info for an entity
 */
export function getEntityDisplayInfo(entityId: EntityId, name?: string): EntityDisplayInfo {
  const type = getEntityType(entityId);
  return {
    type,
    shortId: formatEntityId(entityId),
    fullId: entityId,
    number: type === 'numbered' ? Number(BigInt(entityId)) : null,
    name,
  };
}

/**
 * Complete display information for a replica
 */
export interface ReplicaDisplayInfo extends EntityDisplayInfo {
  /** Signer ID */
  readonly signerId: SignerId;
  /** Formatted signer display */
  readonly signerDisplay: string;
  /** Is this the proposer replica? */
  readonly isProposer: boolean;
}

/**
 * Get complete display info for a replica
 */
export function getReplicaDisplayInfo(
  addr: ReplicaAddress,
  entityName?: string
): ReplicaDisplayInfo {
  const entityInfo = getEntityDisplayInfo(addr.entityId, entityName);
  return {
    ...entityInfo,
    signerId: addr.signerId,
    signerDisplay: formatSignerId(addr.signerId),
    isProposer: addr.signerId.endsWith('_proposer'),
  };
}

// =============================================================================
// COMPARISON & EQUALITY
// =============================================================================

/**
 * Check if two entity addresses are equal
 */
export function entityAddressEquals(a: EntityAddress, b: EntityAddress): boolean {
  return (
    a.chainId === b.chainId &&
    a.entityProviderAddress === b.entityProviderAddress &&
    a.entityId === b.entityId
  );
}

/**
 * Check if two replica addresses are equal
 */
export function replicaAddressEquals(a: ReplicaAddress, b: ReplicaAddress): boolean {
  return entityAddressEquals(a, b) && a.signerId === b.signerId;
}

/**
 * Check if two replica URIs are equal
 */
export function replicaURIEquals(a: ReplicaURI, b: ReplicaURI): boolean {
  return (
    a.runtimeHost === b.runtimeHost &&
    a.runtimePort === b.runtimePort &&
    replicaAddressEquals(a, b)
  );
}

// =============================================================================
// MAP KEY HELPERS
// =============================================================================

/**
 * Type-safe Map with ReplicaAddress keys
 */
export class ReplicaMap<V> {
  private readonly map = new Map<string, V>();

  get(addr: ReplicaAddress): V | undefined {
    return this.map.get(serializeReplicaAddress(addr));
  }

  set(addr: ReplicaAddress, value: V): this {
    this.map.set(serializeReplicaAddress(addr), value);
    return this;
  }

  has(addr: ReplicaAddress): boolean {
    return this.map.has(serializeReplicaAddress(addr));
  }

  delete(addr: ReplicaAddress): boolean {
    return this.map.delete(serializeReplicaAddress(addr));
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  *entries(): IterableIterator<[string, V]> {
    yield* this.map.entries();
  }

  *values(): IterableIterator<V> {
    yield* this.map.values();
  }

  *keys(): IterableIterator<string> {
    yield* this.map.keys();
  }
}

/**
 * Type-safe Map with EntityAddress keys
 */
export class EntityMap<V> {
  private readonly map = new Map<string, V>();

  get(addr: EntityAddress): V | undefined {
    return this.map.get(serializeEntityAddress(addr));
  }

  set(addr: EntityAddress, value: V): this {
    this.map.set(serializeEntityAddress(addr), value);
    return this;
  }

  has(addr: EntityAddress): boolean {
    return this.map.has(serializeEntityAddress(addr));
  }

  delete(addr: EntityAddress): boolean {
    return this.map.delete(serializeEntityAddress(addr));
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// =============================================================================
// EXPORTS SUMMARY
// =============================================================================

/*
Types:
- EntityType
- ChainId
- EntityId (branded)
- SignerId (branded)
- EntityProviderAddress (branded)
- ReplicaKey (branded, legacy)
- JurisdictionAddress
- EntityAddress
- ReplicaAddress
- ReplicaURI
- EntityDisplayInfo
- ReplicaDisplayInfo

Constants:
- MAX_NUMBERED_ENTITY
- XLN_URI_SCHEME
- CHAINS

Validators:
- validateEntityId()
- validateSignerId()
- validateEntityProviderAddress()
- isValidEntityId()
- isValidSignerId()
- isValidReplicaKey()

Entity Type Detection:
- getEntityType()
- getEntityNumber()
- isNumberedEntity()
- isLazyEntity()

ID Generation:
- generateNumberedEntityId()
- generateLazyEntityId()

Replica Key (Legacy):
- createReplicaKey()
- parseReplicaKey()

Address Constructors:
- createJurisdictionAddress()
- createEntityAddress()
- createReplicaAddress()
- createReplicaURI()

Serialization:
- serializeReplicaURI()
- parseReplicaURI()
- serializeEntityAddress()
- serializeReplicaAddress()

Display Formatting:
- formatEntityId()
- formatEntityIdFull()
- formatSignerId()
- formatReplicaAddress()
- formatReplicaURI()

Display Info:
- getEntityDisplayInfo()
- getReplicaDisplayInfo()

Comparison:
- entityAddressEquals()
- replicaAddressEquals()
- replicaURIEquals()

Collections:
- ReplicaMap<V>
- EntityMap<V>
*/
```

---

## Updated Types: `runtime/types.ts`

### Changes to EntityReplica

```typescript
// BEFORE:
export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  // ...
}

// AFTER:
import type { EntityId, SignerId, ReplicaAddress } from './ids';

export interface EntityReplica {
  /** Full replica address with jurisdiction context */
  address: ReplicaAddress;

  /** Entity state machine */
  state: EntityState;

  /** Pending transactions in mempool */
  mempool: EntityTx[];

  /** Current proposal being voted on */
  proposal?: ProposedEntityFrame;

  /** Frame this validator is locked/precommitted to */
  lockedFrame?: ProposedEntityFrame;

  /** Is this replica the proposer? */
  isProposer: boolean;

  /** Number of txs sent to proposer but not yet committed */
  sentTransitions?: number;

  /** Position relative to J-machine (for 3D visualization) */
  position?: RelativePosition;
}

/** Position relative to J-machine center */
export interface RelativePosition {
  x: number;
  y: number;
  z: number;
}
```

### Changes to Env

```typescript
// BEFORE:
export interface Env {
  replicas: Map<string, EntityReplica>;
  // ...
}

// AFTER:
import { ReplicaMap } from './ids';

export interface Env {
  /** All replicas indexed by ReplicaAddress */
  replicas: ReplicaMap<EntityReplica>;

  /** Current block height */
  height: number;

  /** Current timestamp (unix ms) */
  timestamp: number;

  /** Merged runtime inputs */
  runtimeInput: RuntimeInput;

  /** Time machine snapshots */
  history: EnvSnapshot[];

  /** Gossip layer for network profiles */
  gossip: any;

  /** Jurisdiction system */
  jurisdictions: Map<number, JurisdictionConfig>;  // chainId -> config

  /** Active jurisdiction chainId */
  activeChainId: number;

  /** Disable automatic snapshots (for demos) */
  disableAutoSnapshots?: boolean;
}

export interface JurisdictionConfig {
  chainId: number;
  name: string;
  entityProviderAddress: EntityProviderAddress;
  depositoryAddress: string;
  jMachine: JMachineState;
}
```

### Changes to EntityInput

```typescript
// BEFORE:
export interface EntityInput {
  entityId: string;
  signerId?: string;
  // ...
}

// AFTER:
export interface EntityInput {
  /** Target entity address */
  entityAddress: EntityAddress;

  /** Signer (if known at input time) */
  signerId?: SignerId;

  /** Entity layer transactions */
  entityTxs?: EntityTx[];

  /** Account layer settlements */
  accountTxs?: AccountSettlementRequest[];

  /** Gossip messages to process */
  gossip?: GossipInput;
}
```

---

## Migration Guide

### Phase 1: Add `runtime/ids.ts`
1. Create the file with all types and helpers
2. Add to runtime.ts exports
3. No breaking changes - parallel system

### Phase 2: Update Core Types
1. Update `EntityReplica` to use `address: ReplicaAddress`
2. Update `Env.replicas` to use `ReplicaMap`
3. Update `EntityInput` to use `entityAddress`

### Phase 3: Migrate Runtime Code

#### `runtime/runtime.ts`

```typescript
// BEFORE:
const replicaKey = `${runtimeTx.entityId}:${runtimeTx.signerId}`;
env.replicas.set(replicaKey, replica);

// AFTER:
const replicaAddr = createReplicaAddress(
  env.activeChainId,
  jurisdiction.entityProviderAddress,
  runtimeTx.entityId,
  runtimeTx.signerId
);
env.replicas.set(replicaAddr, replica);
```

```typescript
// BEFORE:
for (const [replicaKey, replica] of env.replicas.entries()) {
  const [entityId, signerId] = replicaKey.split(':');
  // ...
}

// AFTER:
for (const [, replica] of env.replicas.entries()) {
  const { entityId, signerId, chainId } = replica.address;
  // ...
}
```

#### `runtime/entity-consensus.ts`

```typescript
// BEFORE:
if (!replica.entityId || !replica.signerId) {
  log.error(`❌ Invalid replica IDs: ${replica.entityId}:${replica.signerId}`);
}

// AFTER:
// No need - ReplicaAddress is always valid by construction
// Validation happens at address creation time
```

### Phase 4: Migrate Frontend

#### `frontend/src/lib/stores/xlnStore.ts`

```typescript
// BEFORE:
const entityId = replicaKey.split(':')[0];

// AFTER:
import { parseReplicaKey } from '/runtime.js';
const { entityId } = parseReplicaKey(replicaKey);
```

#### `frontend/src/lib/view/panels/Graph3DPanel.svelte`

```typescript
// BEFORE:
const replicaKey = Array.from(currentReplicas.keys()).find(
  key => key.startsWith(profile.entityId + ':')
);

// AFTER:
// With ReplicaMap, lookup by entity directly:
const replica = findReplicaByEntity(currentReplicas, profile.entityAddress);
```

### Phase 5: Update Display Functions

All UI components should use:
- `formatEntityId(entityId)` → "#1" or "abc123..."
- `formatSignerId(signerId)` → "alice (P)" or "bank (V)"
- `formatReplicaAddress(addr)` → "#1:alice (P)"
- `getEntityDisplayInfo(entityId)` → full display object

---

## Files to Modify

### Runtime (Core)
1. `runtime/ids.ts` - NEW FILE
2. `runtime/types.ts` - Update interfaces
3. `runtime/runtime.ts` - Use new address types
4. `runtime/entity-consensus.ts` - Use new address types
5. `runtime/entity-factory.ts` - Update ID generation
6. `runtime/state-helpers.ts` - Update replica iteration
7. `runtime/snapshot-coder.ts` - Serialize new types
8. `runtime/prepopulate.ts` - Use new address types
9. `runtime/prepopulate-ahb.ts` - Use new address types

### Frontend (Stores)
10. `frontend/src/lib/stores/xlnStore.ts` - Update position capture

### Frontend (Panels)
11. `frontend/src/lib/view/panels/Graph3DPanel.svelte` - Update position lookup
12. `frontend/src/lib/view/panels/EntitiesPanel.svelte` - Use formatEntityId
13. `frontend/src/lib/view/panels/AccountsPanel.svelte` - Use formatEntityId
14. `frontend/src/lib/view/panels/ArchitectPanel.svelte` - Use formatEntityId
15. `frontend/src/lib/view/panels/JurisdictionPanel.svelte` - Use new types

---

## Testing Strategy

### Unit Tests for `ids.ts`

```typescript
// ids.test.ts
import { describe, test, expect } from 'bun:test';
import * as ids from './ids';

describe('validateEntityId', () => {
  test('accepts valid numbered entity', () => {
    const id = ids.validateEntityId('0x' + '0'.repeat(63) + '1');
    expect(id).toBe('0x' + '0'.repeat(63) + '1');
  });

  test('rejects invalid length', () => {
    expect(() => ids.validateEntityId('0x123')).toThrow();
  });

  test('rejects non-hex', () => {
    expect(() => ids.validateEntityId('0x' + 'g'.repeat(64))).toThrow();
  });
});

describe('getEntityType', () => {
  test('detects numbered entity', () => {
    const id = ids.generateNumberedEntityId(1);
    expect(ids.getEntityType(id)).toBe('numbered');
  });

  test('detects lazy entity', () => {
    const id = ids.generateLazyEntityId(['alice', 'bob'], 2);
    expect(ids.getEntityType(id)).toBe('lazy');
  });
});

describe('parseReplicaKey', () => {
  test('parses valid key', () => {
    const entityId = ids.generateNumberedEntityId(1);
    const key = `${entityId}:alice_proposer`;
    const result = ids.parseReplicaKey(key);
    expect(result.entityId).toBe(entityId);
    expect(result.signerId).toBe('alice_proposer');
  });

  test('rejects missing delimiter', () => {
    expect(() => ids.parseReplicaKey('invalid')).toThrow();
  });
});

describe('formatEntityId', () => {
  test('formats numbered as #N', () => {
    const id = ids.generateNumberedEntityId(42);
    expect(ids.formatEntityId(id)).toBe('#42');
  });

  test('formats lazy as truncated hash', () => {
    const id = ids.generateLazyEntityId(['alice'], 1);
    expect(ids.formatEntityId(id)).toMatch(/^[a-f0-9]{8}\.\.\.$/);
  });
});
```

---

## Estimated Effort

| Phase | Files | Complexity | Est. Time |
|-------|-------|------------|-----------|
| 1. Create ids.ts | 1 | Medium | 1 hour |
| 2. Update types.ts | 1 | Medium | 30 min |
| 3. Migrate runtime | 8 | High | 3 hours |
| 4. Migrate frontend | 5 | Medium | 2 hours |
| 5. Update displays | 5 | Low | 1 hour |
| 6. Add tests | 1 | Medium | 1 hour |
| **Total** | **21** | | **~8.5 hours** |

---

## Open Questions

1. **Serialization Format**: Should history snapshots use full URI strings or structured objects?
   - Recommendation: Structured objects in memory, URI strings in JSON exports

2. **IndexedDB Keys**: Should we change the DB schema for replicas?
   - Recommendation: Yes, migrate to `chainId/epAddress/entityId/signerId` composite key

3. **WebSocket Protocol**: Should we define a message format using these URIs?
   - Recommendation: Defer until multi-runtime is needed

---

## Success Criteria

1. ✅ No more `split(':')` patterns in codebase
2. ✅ All entity IDs validated at creation time
3. ✅ Consistent display format across all panels
4. ✅ Type-safe replica lookups with branded types
5. ✅ All tests pass
6. ✅ No runtime errors in demo scenarios
