/**
 * XLN Entity Factory
 * Entity creation, ID generation, and entity utility functions
 */

import { ethers } from 'ethers';

import { getCachedSignerAddress } from './account-crypto';
import type { ConsensusConfig, EntityType, JurisdictionConfig } from './types';
import { DEBUG } from './utils';

// Extend globalThis to include our entity counter
declare global {
  // eslint-disable-next-line no-var
  var _entityCounter: number | undefined;
}

let namedRequestCounter = 0;

// Entity encoding utilities
const resolveValidatorAddress = (validator: string): string => {
  if (validator.startsWith('0x') && validator.length === 42) {
    return ethers.getAddress(validator);
  }
  if (validator.startsWith('0x') && validator.length === 66) {
    return ethers.getAddress(`0x${validator.slice(-40)}`);
  }
  const derived = getCachedSignerAddress(validator);
  if (!derived) {
    throw new Error(`Cannot derive address for validator ${validator}`);
  }
  return ethers.getAddress(derived);
};

const toBoardEntityId = (validator: string): string => {
  const address = resolveValidatorAddress(validator);
  return ethers.zeroPadValue(address, 32);
};

const toUint16 = (value: bigint, label: string): number => {
  if (value < 0n || value > 0xffffn) {
    throw new Error(`Board ${label} out of range: ${value.toString()}`);
  }
  return Number(value);
};

export const encodeBoard = (config: ConsensusConfig): string => {
  const entityIds = config.validators.map(toBoardEntityId);
  const votingPowers = config.validators.map((validator) => toUint16(config.shares[validator] || 1n, `weight(${validator})`));
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
  validators: { name: string; weight: number }[] | string[],
  threshold: bigint,
): string => {
  // Create deterministic entity ID from quorum composition
  let validatorData: { name: string; weight: bigint }[];

  // Handle both formats: array of objects or array of strings (assume weight=1)
  if (typeof validators[0] === 'string') {
    validatorData = (validators as string[]).map(name => ({ name, weight: 1n }));
  } else {
    validatorData = (validators as { name: string; weight: number }[]).map(v => ({
      name: v.name,
      weight: BigInt(v.weight),
    }));
  }

  // Sort by resolved address for canonical ordering
  const sortedValidators = validatorData.slice().sort((a, b) => {
    const aAddr = resolveValidatorAddress(a.name);
    const bAddr = resolveValidatorAddress(b.name);
    return aAddr.localeCompare(bAddr);
  });

  const shares: { [validatorId: string]: bigint } = {};
  const validatorIds = sortedValidators.map(v => v.name);
  for (const validator of sortedValidators) {
    shares[validator.name] = validator.weight;
  }

  const encodedBoard = encodeBoard({
    mode: 'proposer-based',
    threshold,
    validators: validatorIds,
    shares,
  });
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
  validators: string[],
  threshold: bigint,
  jurisdiction?: JurisdictionConfig,
): { config: ConsensusConfig; executionTimeMs: number } => {
  const entityId = generateLazyEntityId(validators, threshold);

  if (DEBUG) console.log(`🔒 Creating lazy entity: ${name}`);
  if (DEBUG) console.log(`   EntityID: ${entityId} (quorum hash)`);
  if (DEBUG) console.log(`   Validators: ${validators.join(', ')}`);
  if (DEBUG) console.log(`   Threshold: ${threshold}`);
  if (DEBUG) console.log(`   🆓 FREE - No gas required`);

  const shares: { [validatorId: string]: bigint } = {};
  validators.forEach(validator => {
    shares[validator] = 1n; // Equal voting power for simplicity
  });

  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold,
    validators,
    shares,
    ...(jurisdiction && { jurisdiction }),
  };

  const executionTimeMs = 0;
  console.log(`⚡ Lazy entity creation: ${executionTimeMs.toFixed(3)}ms (pure in-memory)`);

  return { config, executionTimeMs };
};

// 2. NUMBERED ENTITIES (Small gas cost)
export const createNumberedEntity = async (
  name: string,
  validators: string[],
  threshold: bigint,
  jurisdiction: JurisdictionConfig,
): Promise<{ config: ConsensusConfig; entityNumber: number; entityId: string }> => {
  if (!jurisdiction) {
    throw new Error('Jurisdiction required for numbered entity registration');
  }

  const boardHash = hashBoard(
    encodeBoard({
      mode: 'proposer-based',
      threshold,
      validators,
      shares: validators.reduce((acc, v) => ({ ...acc, [v]: 1n }), {}),
      jurisdiction,
    }),
  );

  if (DEBUG) console.log(`🔢 Creating numbered entity: ${name}`);
  if (DEBUG) console.log(`   Board Hash: ${boardHash}`);
  if (DEBUG) console.log(`   Jurisdiction: ${jurisdiction.name}`);
  if (DEBUG) console.log(`   💸 Gas required for registration`);

  // Get the next entity number from the blockchain
  const { getNextEntityNumber, registerNumberedEntityOnChain } = await import('./evm');

  try {
    // First, get the next available entity number from the blockchain
    await getNextEntityNumber(jurisdiction);

    // Register the entity on-chain with its board configuration
    const { entityNumber } = await registerNumberedEntityOnChain(
      { mode: 'proposer-based', threshold, validators, shares: validators.reduce((acc, v) => ({ ...acc, [v]: 1n }), {}), jurisdiction },
      name
    );

    const entityId = generateNumberedEntityId(entityNumber);

    if (DEBUG) console.log(`   ✅ Registered Entity Number: ${entityNumber}`);
    if (DEBUG) console.log(`   EntityID: ${entityId}`);

    const shares: { [validatorId: string]: bigint } = {};
    validators.forEach(validator => {
      shares[validator] = 1n;
    });

    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold,
      validators,
      shares,
      jurisdiction,
    };

    return { config, entityNumber, entityId };
  } catch (error) {
    console.error('❌ Failed to register numbered entity on blockchain:', error);
    throw error;
  }
};

/**
 * Batch create multiple numbered entities in ONE transaction
 * Optimized for scenarios importing many entities (e.g., PhantomGrid 1000 nodes)
 */
export const createNumberedEntitiesBatch = async (
  entities: Array<{ name: string; validators: string[]; threshold: bigint }>,
  jurisdiction: JurisdictionConfig,
): Promise<Array<{ config: ConsensusConfig; entityNumber: number; entityId: string }>> => {
  if (!jurisdiction) {
    throw new Error('Jurisdiction required for numbered entity registration');
  }

  console.log(`🔢 Batch creating ${entities.length} numbered entities in ONE transaction`);

  // Build configs for all entities
  const configs: ConsensusConfig[] = entities.map(e => ({
    mode: 'proposer-based' as const,
    threshold: e.threshold,
    validators: e.validators,
    shares: e.validators.reduce((acc, v) => ({ ...acc, [v]: 1n }), {}),
    jurisdiction,
  }));

  // Call batch registration on-chain
  const { registerNumberedEntitiesBatchOnChain } = await import('./evm');
  const { entityNumbers } = await registerNumberedEntitiesBatchOnChain(configs, jurisdiction);

  // Build results
  return entityNumbers.map((entityNumber, i) => {
    const entityId = generateNumberedEntityId(entityNumber);
    const config = configs[i];
    if (!config) throw new Error(`Missing config for entity ${i}`);

    console.log(`  ✅ Entity ${i + 1}/${entities.length}: #${entityNumber} (${entityId.slice(0, 10)}...)`);

    return { config, entityNumber, entityId };
  });
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

  if (DEBUG) console.log(`🏷️ Requesting named entity assignment`);
  if (DEBUG) console.log(`   Name: ${name}`);
  if (DEBUG) console.log(`   Target Entity Number: ${entityNumber}`);
  if (DEBUG) console.log(`   Jurisdiction: ${jurisdiction.name}`);
  if (DEBUG) console.log(`   👑 Requires admin approval`);

  // Simulate admin assignment request (deterministic)
  const requestId = `req_${namedRequestCounter++}`;

  if (DEBUG) console.log(`   📝 Name assignment request submitted: ${requestId}`);
  if (DEBUG) console.log(`   ⏳ Waiting for admin approval...`);

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
    if (DEBUG) console.log(`🔍 Looking up named entity: ${identifier}`);

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
