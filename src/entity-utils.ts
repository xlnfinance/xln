// === ENTITY UTILITIES ===

import { ethers } from 'ethers';
import { ConsensusConfig, EntityType } from './types.js';
import { hash, createHash } from './crypto-utils.js';

// Entity encoding utilities
export const encodeBoard = (config: ConsensusConfig): string => {
  const delegates = config.validators.map(validator => ({
    entityId: validator, // For EOA addresses (20 bytes)
    votingPower: Number(config.shares[validator] || 1n)
  }));

  const board = {
    votingThreshold: Number(config.threshold),
    delegates: delegates
  };

  // Return JSON representation that can be hashed consistently
  return JSON.stringify(board, Object.keys(board).sort());
};

export const hashBoard = (encodedBoard: string): string => {
  // Use real keccak256 hash like Ethereum
  return ethers.keccak256(ethers.toUtf8Bytes(encodedBoard));
};

export const generateLazyEntityId = (validators: {name: string, weight: number}[] | string[], threshold: bigint): string => {
  // Create deterministic entity ID from quorum composition
  let validatorData: {name: string, weight: number}[];
  
  // Handle both formats: array of objects or array of strings (assume weight=1)
  if (typeof validators[0] === 'string') {
    validatorData = (validators as string[]).map(name => ({name, weight: 1}));
  } else {
    validatorData = validators as {name: string, weight: number}[];
  }
  
  // Sort by name for canonical ordering
  const sortedValidators = validatorData.slice().sort((a, b) => a.name.localeCompare(b.name));
  
  const quorumData = {
    validators: sortedValidators,
    threshold: threshold.toString()
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

export const extractNumberFromEntityId = (entityId: string): number | null => {
  // Check if this is a hex string (0x followed by hex digits)
  if (entityId.startsWith('0x') && entityId.length === 66) {
    try {
      const num = BigInt(entityId);
      
      // Check if it's a numbered entity (small positive number)
      if (num > 0n && num < 1000000n) {
        return Number(num);
      }
      
      return null;
    } catch {
      return null;
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
      
      return null;
    } catch {
      return null;
    }
  }
  
  return null;
};

// Entity resolution (client-side)
export const resolveEntityIdentifier = async (identifier: string): Promise<{entityId: string, type: EntityType}> => {
  // Handle different input formats
  if (identifier.startsWith('#')) {
    // #42 -> numbered entity
    const number = parseInt(identifier.slice(1));
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered'
    };
  } else if (/^\d+$/.test(identifier)) {
    // 42 -> numbered entity
    const number = parseInt(identifier);
    return {
      entityId: generateNumberedEntityId(number),
      type: 'numbered'
    };
  } else if (identifier.startsWith('0x')) {
    // 0x123... -> direct entity ID
    return {
      entityId: identifier,
      type: detectEntityType(identifier)
    };
  } else {
    // "coinbase" -> named entity (requires on-chain lookup)
    // For demo, simulate lookup
    console.log(`🔍 Looking up named entity: ${identifier}`);
    
    // Simulate on-chain name resolution
    const simulatedNumber = identifier === 'coinbase' ? 42 : 0;
    if (simulatedNumber > 0) {
      return {
        entityId: generateNumberedEntityId(simulatedNumber),
        type: 'named'
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
