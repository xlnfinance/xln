/**
 * Core types shared across all layers (R/E/A/J)
 */

import type { EntityId, SignerId } from '../ids';

// ═══════════════════════════════════════════════════════════════
// RESULT TYPE - Discriminated success/failure
// ═══════════════════════════════════════════════════════════════

export type Result<T, E> = { _tag: 'Ok'; value: T } | { _tag: 'Err'; error: E };
export const Ok = <T>(value: T): Result<T, never> => ({ _tag: 'Ok', value });
export const Err = <E>(error: E): Result<never, E> => ({ _tag: 'Err', error });
export const isOk = <T, E>(r: Result<T, E>): r is { _tag: 'Ok'; value: T } => r._tag === 'Ok';
export const isErr = <T, E>(r: Result<T, E>): r is { _tag: 'Err'; error: E } => r._tag === 'Err';

// ═══════════════════════════════════════════════════════════════
// CONSENSUS CONFIG
// ═══════════════════════════════════════════════════════════════

export interface ConsensusConfig {
  mode: 'proposer-based' | 'gossip-based';
  threshold: bigint;
  validators: string[];
  shares: { [validatorId: string]: bigint };
  jurisdiction?: JurisdictionConfig;
}

export interface JurisdictionConfig {
  address: string;
  name: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
}

// ═══════════════════════════════════════════════════════════════
// HANKO BYTES SYSTEM (Cryptographic signatures)
// ═══════════════════════════════════════════════════════════════

export interface HankoBytes {
  placeholders: Buffer[]; // Entity IDs that failed to sign (index 0..N-1)
  packedSignatures: Buffer; // EOA signatures → yesEntities (index N..M-1)
  claims: HankoClaim[]; // Entity claims to verify (index M..∞)
}

export interface HankoClaim {
  entityId: Buffer;
  entityIndexes: number[];
  weights: number[];
  threshold: number;
  // NOTE: NO expectedQuorumHash - EP.sol reconstructs board hash from recovered signers
}

// Hanko in string format (hex-encoded ABI bytes)
export type HankoString = string;

// ═══════════════════════════════════════════════════════════════
// HASH SIGNING
// ═══════════════════════════════════════════════════════════════

/** Hash type for entity-level signing */
export type HashType = 'entityFrame' | 'accountFrame' | 'dispute' | 'settlement' | 'profile';

/** Hash with type info for entity-level signing */
export interface HashToSign {
  hash: string;
  type: HashType;
  context: string;  // e.g., "account:0002:frame:1" or "account:0002:dispute"
}

// Entity types - canonical definition in ids.ts
export { type EntityType } from '../ids';
