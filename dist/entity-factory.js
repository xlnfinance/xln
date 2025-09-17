/**
 * XLN Entity Factory
 * Entity creation, ID generation, and entity utility functions
 */
import { ethers } from 'ethers';
import { DEBUG } from './utils';
// Entity encoding utilities
export const encodeBoard = (config) => {
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
export const hashBoard = (encodedBoard) => {
    // Use real keccak256 hash like Ethereum
    return ethers.keccak256(ethers.toUtf8Bytes(encodedBoard));
};
export const generateLazyEntityId = (validators, threshold) => {
    // Create deterministic entity ID from quorum composition
    let validatorData;
    // Handle both formats: array of objects or array of strings (assume weight=1)
    if (typeof validators[0] === 'string') {
        validatorData = validators.map(name => ({ name, weight: 1 }));
    }
    else {
        validatorData = validators;
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
export const generateNumberedEntityId = (entityNumber) => {
    // Convert number to bytes32 (left-padded with zeros)
    return `0x${entityNumber.toString(16).padStart(64, '0')}`;
};
export const generateNamedEntityId = (name) => {
    // For named entities: entityId resolved via name lookup on-chain
    // This is just for client-side preview
    return hashBoard(name);
};
export const detectEntityType = (entityId) => {
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
        }
        catch {
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
        }
        catch {
            return 'lazy';
        }
    }
    // Non-numeric, non-hex strings are lazy entities
    return 'lazy';
};
export const extractNumberFromEntityId = (entityId) => {
    // Check if this is a hex string (0x followed by hex digits)
    if (entityId.startsWith('0x') && entityId.length === 66) {
        try {
            const num = BigInt(entityId);
            // Check if it's a numbered entity (small positive number)
            if (num > 0n && num < 1000000n) {
                return Number(num);
            }
            return null;
        }
        catch {
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
        }
        catch {
            return null;
        }
    }
    return null;
};
// 1. LAZY ENTITIES (Free, instant)
export const createLazyEntity = (name, validators, threshold, jurisdiction) => {
    const entityId = generateLazyEntityId(validators, threshold);
    if (DEBUG)
        console.log(`🔒 Creating lazy entity: ${name}`);
    if (DEBUG)
        console.log(`   EntityID: ${entityId} (quorum hash)`);
    if (DEBUG)
        console.log(`   Validators: ${validators.join(', ')}`);
    if (DEBUG)
        console.log(`   Threshold: ${threshold}`);
    if (DEBUG)
        console.log(`   🆓 FREE - No gas required`);
    const shares = {};
    validators.forEach(validator => {
        shares[validator] = 1n; // Equal voting power for simplicity
    });
    return {
        mode: 'proposer-based',
        threshold,
        validators,
        shares,
        jurisdiction,
    };
};
// 2. NUMBERED ENTITIES (Small gas cost)
export const createNumberedEntity = async (name, validators, threshold, jurisdiction) => {
    if (!jurisdiction) {
        throw new Error('Jurisdiction required for numbered entity registration');
    }
    const boardHash = hashBoard(encodeBoard({
        mode: 'proposer-based',
        threshold,
        validators,
        shares: validators.reduce((acc, v) => ({ ...acc, [v]: 1n }), {}),
        jurisdiction,
    }));
    if (DEBUG)
        console.log(`🔢 Creating numbered entity: ${name}`);
    if (DEBUG)
        console.log(`   Board Hash: ${boardHash}`);
    if (DEBUG)
        console.log(`   Jurisdiction: ${jurisdiction.name}`);
    if (DEBUG)
        console.log(`   💸 Gas required for registration`);
    // Simulate blockchain call - use sequential numbers for demo
    // Use a simple global counter for demo purposes
    if (!globalThis._entityCounter)
        globalThis._entityCounter = 0;
    const entityNumber = ++globalThis._entityCounter;
    const entityId = generateNumberedEntityId(entityNumber);
    if (DEBUG)
        console.log(`   ✅ Assigned Entity Number: ${entityNumber}`);
    if (DEBUG)
        console.log(`   EntityID: ${entityId}`);
    const shares = {};
    validators.forEach(validator => {
        shares[validator] = 1n;
    });
    const config = {
        mode: 'proposer-based',
        threshold,
        validators,
        shares,
        jurisdiction,
    };
    return { config, entityNumber };
};
// 3. NAMED ENTITIES (Premium - admin assignment required)
export const requestNamedEntity = async (name, entityNumber, jurisdiction) => {
    if (!jurisdiction) {
        throw new Error('Jurisdiction required for named entity');
    }
    if (DEBUG)
        console.log(`🏷️ Requesting named entity assignment`);
    if (DEBUG)
        console.log(`   Name: ${name}`);
    if (DEBUG)
        console.log(`   Target Entity Number: ${entityNumber}`);
    if (DEBUG)
        console.log(`   Jurisdiction: ${jurisdiction.name}`);
    if (DEBUG)
        console.log(`   👑 Requires admin approval`);
    // Simulate admin assignment request
    const requestId = `req_${Math.random().toString(16).substring(2, 10)}`;
    if (DEBUG)
        console.log(`   📝 Name assignment request submitted: ${requestId}`);
    if (DEBUG)
        console.log(`   ⏳ Waiting for admin approval...`);
    return requestId;
};
// Entity resolution (client-side)
export const resolveEntityIdentifier = async (identifier) => {
    // Handle different input formats
    if (identifier.startsWith('#')) {
        // #42 -> numbered entity
        const number = parseInt(identifier.slice(1));
        return {
            entityId: generateNumberedEntityId(number),
            type: 'numbered',
        };
    }
    else if (/^\d+$/.test(identifier)) {
        // 42 -> numbered entity
        const number = parseInt(identifier);
        return {
            entityId: generateNumberedEntityId(number),
            type: 'numbered',
        };
    }
    else if (identifier.startsWith('0x')) {
        // 0x123... -> direct entity ID
        return {
            entityId: identifier,
            type: detectEntityType(identifier),
        };
    }
    else {
        // "coinbase" -> named entity (requires on-chain lookup)
        // For demo, simulate lookup
        if (DEBUG)
            console.log(`🔍 Looking up named entity: ${identifier}`);
        // Simulate on-chain name resolution
        const simulatedNumber = identifier === 'coinbase' ? 42 : 0;
        if (simulatedNumber > 0) {
            return {
                entityId: generateNumberedEntityId(simulatedNumber),
                type: 'named',
            };
        }
        else {
            throw new Error(`Named entity "${identifier}" not found`);
        }
    }
};
export const isEntityRegistered = async (entityId) => {
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
    }
    catch {
        return false;
    }
};
