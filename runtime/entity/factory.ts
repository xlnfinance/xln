/**
 * XLN Entity Factory
 * Entity creation, ID generation, and entity utility functions
 */

import { ethers } from 'ethers';

import { getSignerAddress } from '../account/crypto';
import { DEBUG } from '../infra/debug-flags';
import { createStructuredLogger, shortId } from '../infra/logger';
import type { ConsensusConfig, JurisdictionConfig } from './types';
import type { RuntimeState } from '../types';
import type { EntityType } from '../protocol/identity';

// Extend globalThis to include our entity counter
declare global {
  // eslint-disable-next-line no-var
  var _entityCounter: number | undefined;
}

let namedRequestCounter = 0;
const factoryLog = createStructuredLogger('entity.factory');

// Entity encoding utilities
type BoardSignerContext = Pick<RuntimeState, 'runtimeSeed'>;

export type BoardMemberInput = string | Readonly<{
  name: string;
  weight: number | bigint;
}>;

type NormalizedBoardMember = Readonly<{ name: string; weight: bigint }>;

const normalizeBoardMembers = (members: readonly BoardMemberInput[]): NormalizedBoardMember[] => {
  if (members.length === 0) throw new Error('Board must contain at least one member');
  const seen = new Set<string>();
  return members.map((member, index) => {
    const name = (typeof member === 'string' ? member : member.name).trim();
    const weight = typeof member === 'string' ? 1n : BigInt(member.weight);
    const key = name.toLowerCase();
    if (!name) throw new Error(`Board member missing: index=${index}`);
    if (seen.has(key)) throw new Error(`Board member duplicate: ${name}`);
    if (weight <= 0n || weight > 0xffffn) {
      throw new Error(`Board voting power out of range: ${name}=${weight.toString()}`);
    }
    seen.add(key);
    return { name, weight };
  });
};

const boardConfig = (
  members: readonly NormalizedBoardMember[],
  threshold: bigint,
  jurisdiction?: JurisdictionConfig,
): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold,
  validators: members.map((member) => member.name),
  shares: Object.fromEntries(members.map((member) => [member.name, member.weight])),
  // Consensus configs are values, not alias graphs. Keeping the caller's
  // object here lets Bun 1.3 corrupt a later repeated jurisdiction during a
  // structured clone of a multi-entity registration request.
  ...(jurisdiction ? { jurisdiction: structuredClone(jurisdiction) } : {}),
});

const resolveValidatorAddress = (validator: string, env?: BoardSignerContext): string => {
  if (validator.startsWith('0x') && validator.length === 42) {
    return ethers.getAddress(validator);
  }
  if (validator.startsWith('0x') && (validator.length === 68 || validator.length === 132)) {
    return ethers.computeAddress(validator);
  }
  const derived = env ? getSignerAddress(env, validator) : null;
  if (!derived) {
    throw new Error(
      `BOARD_VALIDATOR_ADDRESS_REQUIRED:${validator}` +
        (env ? '' : ':numeric aliases require explicit RuntimeState'),
    );
  }
  return ethers.getAddress(derived);
};

const toBoardEntityId = (validator: string, env?: BoardSignerContext): string => {
  if (/^0x[0-9a-f]{64}$/i.test(validator)) {
    return validator.toLowerCase();
  }
  const address = resolveValidatorAddress(validator, env);
  return ethers.zeroPadValue(address, 32);
};

const toUint16 = (value: bigint, label: string): number => {
  if (value < 0n || value > 0xffffn) {
    throw new Error(`Board ${label} out of range: ${value.toString()}`);
  }
  return Number(value);
};

export const encodeBoard = (config: ConsensusConfig, env?: BoardSignerContext): string => {
  if (config.validators.length === 0) throw new Error('Board must contain at least one member');
  const normalizedValidators = new Set<string>();
  for (const validator of config.validators) {
    const normalized = validator.trim().toLowerCase();
    if (!normalized || normalizedValidators.has(normalized)) {
      throw new Error(`Board validator duplicate or empty: ${validator}`);
    }
    normalizedValidators.add(normalized);
  }
  const proposer = config.validators[0]!;
  if (!/^0x[0-9a-f]{40}$/i.test(proposer)) {
    throw new Error(`BOARD_PROPOSER_EOA_REQUIRED:${proposer}`);
  }
  ethers.getAddress(proposer);
  const normalizedShares = new Map<string, bigint>();
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = rawSignerId.trim().toLowerCase();
    if (!signerId || normalizedShares.has(signerId)) {
      throw new Error(`Board share signer duplicate or empty: ${rawSignerId}`);
    }
    if (!normalizedValidators.has(signerId)) {
      throw new Error(`Board share signer is not a validator: ${rawSignerId}`);
    }
    if (typeof share !== 'bigint' || share <= 0n) {
      throw new Error(`Board voting power must be positive: ${rawSignerId}`);
    }
    normalizedShares.set(signerId, share);
  }
  const entityIds = config.validators.map((validator) => toBoardEntityId(validator, env));
  const votingPowers = config.validators.map((validator) => {
    const share = normalizedShares.get(validator.trim().toLowerCase());
    if (share === undefined) throw new Error(`Board voting power missing: ${validator}`);
    return toUint16(share, `weight(${validator})`);
  });
  if (config.threshold <= 0n) throw new Error(`Board threshold must be positive: ${config.threshold}`);
  const threshold = toUint16(config.threshold, 'threshold');

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[threshold, entityIds, votingPowers, 0, 0, 0]]
  );
};

export const hashBoard = (encodedBoard: string): string => {
  if (encodedBoard.startsWith('0x')) {
    return ethers.keccak256(encodedBoard);
  }
  return ethers.keccak256(ethers.toUtf8Bytes(encodedBoard));
};

export const generateLazyEntityId = (
  validators: readonly BoardMemberInput[],
  threshold: bigint,
  env?: BoardSignerContext,
): string => {
  const members = normalizeBoardMembers(validators);
  const encodedBoard = encodeBoard(boardConfig(members, threshold), env);
  return hashBoard(encodedBoard);
};

export const generateNumberedEntityId = (entityNumber: number): string => {
  // Convert number to bytes32 (left-padded with zeros)
  return `0x${entityNumber.toString(16).padStart(64, '0')}`;
};

export const generateNamedEntityId = (name: string): string => {
  // For named entities: entityId resolved via name lookup on-chain
  // This is just for client-side preview
  return hashBoard(name);
};

export const detectEntityType = (entityId: string): EntityType => {
  // Check if this is a hex string (0x followed by hex digits)
  if (entityId.startsWith('0x') && entityId.length === 66) {
    try {
      const num = BigInt(entityId);

      // Small positive numbers = numbered entities
      if (num > 0n && num < 1000000n) {
        return 'numbered';
      }

      // Very large numbers are lazy entity hashes
      return 'lazy';
    } catch {
      return 'lazy';
    }
  }

  // Check if this is a numeric string before trying BigInt conversion
  if (/^[0-9]+$/.test(entityId)) {
    try {
      const num = BigInt(entityId);

      // Small positive numbers = numbered entities
      if (num > 0n && num < 1000000n) {
        return 'numbered';
      }

      // Very large numbers might be lazy entity hashes
      return 'lazy';
    } catch {
      return 'lazy';
    }
  }

  // Non-numeric, non-hex strings are lazy entities
  return 'lazy';
};

export const extractNumberFromEntityId = (entityId: string): number => {
  if (!entityId || typeof entityId !== 'string') {
    throw new Error(`FINTECH-SAFETY: Invalid entityId type: ${typeof entityId}`);
  }

  // Check if this is a hex string (0x followed by hex digits)
  if (entityId.startsWith('0x') && entityId.length === 66) {
    try {
      const num = BigInt(entityId);

      // Check if it's a numbered entity (small positive number)
      if (num > 0n && num < 1000000n) {
        return Number(num);
      }

      // For lazy entities: generate deterministic display number from hash
      // Take last 4 bytes and convert to display number (always positive)
      const hashSuffix = entityId.slice(-8); // Last 4 bytes as hex
      const displayNum = parseInt(hashSuffix, 16) % 9000000 + 1000000; // 1M-10M range
      return displayNum;
    } catch (error) {
      throw new Error(`FINTECH-SAFETY: Invalid entityId format: ${entityId} - ${error}`);
    }
  }

  // Check if this is a numeric string before trying BigInt conversion
  if (/^[0-9]+$/.test(entityId)) {
    try {
      const num = BigInt(entityId);

      // Check if it's a numbered entity (small positive number)
      if (num > 0n && num < 1000000n) {
        return Number(num);
      }

      // Large numeric strings - use modulo for display
      const displayNum = Number(num % 9000000n + 1000000n);
      return displayNum;
    } catch (error) {
      throw new Error(`FINTECH-SAFETY: Invalid numeric entityId: ${entityId} - ${error}`);
    }
  }

  throw new Error(`FINTECH-SAFETY: EntityId must be hex or numeric, got: ${entityId}`);
};

// 1. LAZY ENTITIES (Free, instant)
export const createLazyEntity = (
  name: string,
  validators: readonly BoardMemberInput[],
  threshold: bigint,
  jurisdiction?: JurisdictionConfig,
  env?: BoardSignerContext,
): { config: ConsensusConfig; executionTimeMs: number } => {
  const members = normalizeBoardMembers(validators);
  const config = boardConfig(members, threshold, jurisdiction);
  const entityId = hashBoard(encodeBoard(config, env));

  if (DEBUG) {
    factoryLog.debug('lazy.create', {
      name,
      entity: shortId(entityId, 8),
      validators: members.map(member => shortId(member.name, 8)),
      threshold: threshold.toString(),
    });
  }

  const executionTimeMs = 0;
  if (DEBUG) factoryLog.debug('lazy.created', { name, entity: shortId(entityId, 8), executionTimeMs });

  return { config, executionTimeMs };
};

// 3. NAMED ENTITIES (Premium - admin assignment required)
export const requestNamedEntity = async (
  name: string,
  entityNumber: number,
  jurisdiction: JurisdictionConfig,
): Promise<string> => {
  if (!jurisdiction) {
    throw new Error('Jurisdiction required for named entity');
  }

  if (DEBUG) {
    factoryLog.debug('named.request', {
      name,
      entityNumber,
      jurisdiction: jurisdiction.name,
    });
  }

  // Simulate admin assignment request (deterministic)
  const requestId = `req_${namedRequestCounter++}`;

  if (DEBUG) factoryLog.debug('named.request_submitted', { name, entityNumber, requestId });

  return requestId;
};

// Entity resolution (client-side)
export const resolveEntityIdentifier = async (identifier: string): Promise<{ entityId: string; type: EntityType }> => {
  // Handle different input formats
  if (identifier.startsWith('#')) {
    // #42 -> numbered entity
    const number = parseInt(identifier.slice(1));
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered',
    };
  } else if (/^\d+$/.test(identifier)) {
    // 42 -> numbered entity
    const number = parseInt(identifier);
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered',
    };
  } else if (identifier.startsWith('0x')) {
    // 0x123... -> direct entity ID
    return {
      entityId: identifier,
      type: detectEntityType(identifier),
    };
  } else {
    // "coinbase" -> named entity (requires on-chain lookup)
    // For demo, simulate lookup
    if (DEBUG) factoryLog.debug('named.lookup', { identifier });

    // Simulate on-chain name resolution
    const simulatedNumber = identifier === 'coinbase' ? 42 : 0;
    if (simulatedNumber > 0) {
      return {
        entityId: generateNumberedEntityId(simulatedNumber),
        type: 'named',
      };
    } else {
      throw new Error(`Named entity "${identifier}" not found`);
    }
  }
};

export const isEntityRegistered = async (entityId: string): Promise<boolean> => {
  const type = detectEntityType(entityId);

  // Lazy entities are never "registered" - they exist by definition
  if (type === 'lazy') {
    return false;
  }

  // Numbered and named entities require on-chain verification
  // For demo, assume they exist if they're small numbers
  if (!/^[0-9]+$/.test(entityId)) {
    return false; // Non-numeric IDs are not registered
  }

  try {
    const num = BigInt(entityId);
    return num > 0n && num < 1000000n;
  } catch {
    return false;
  }
};
