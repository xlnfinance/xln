/**
 * XLN Entity Factory
 * Entity creation, ID generation, and entity utility functions
 */

import { ethers } from 'ethers';

import { ConsensusConfig, EntityType, JurisdictionConfig } from './types';
import { DEBUG } from './utils';

// Extend globalThis to include our entity counter
declare global {
  // eslint-disable-next-line no-var
  var _entityCounter: number | undefined;
}

// Entity encoding utilities
export const encodeBoard = (config: ConsensusConfig): string => {
  const delegates = config.validators.map(validator => ({
    entityId: validator, // For EOA addresses (20 bytes)
    votingPower: Number(config.shares[validator] || 1n),
  }));

  const board = {
    votingThreshold: Number(config.threshold),
    delegates: delegates,
  };

  // Return JSON representation that can be hashed consistently
  return JSON.stringify(board, Object.keys(board).sort());
};

export const hashBoard = (encodedBoard: string): string => {
  // Use real keccak256 hash like Ethereum
  return ethers.keccak256(ethers.toUtf8Bytes(encodedBoard));
};

export const generateLazyEntityId = (
  validators: { name: string; weight: number }[] | string[],
  threshold: bigint,
): string => {
  // Create deterministic entity ID from quorum composition
  let validatorData: { name: string; weight: number }[];

  // Handle both formats: array of objects or array of strings (assume weight=1)
  if (typeof validators[0] === 'string') {
    validatorData = (validators as string[]).map(name => ({ name, weight: 1 }));
  } else {
    validatorData = validators as { name: string; weight: number }[];
  }

  // Sort by name for canonical ordering
  const sortedValidators = validatorData.slice().sort((a, b) => a.name.localeCompare(b.name));

  const quorumData = {
    validators: sortedValidators,
    threshold: threshold.toString(),
  };

  const serialized = JSON.stringify(quorumData);
  return hashBoard(serialized);
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
): ConsensusConfig => {
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
  return config;
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

  // Simulate admin assignment request
  const requestId = `req_${Math.random().toString(16).substring(2, 10)}`;

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
