/**
 * XLN Entity Factory
 * Entity creation, ID generation, and entity utility functions
 */

import { ethers, type TransactionReceipt } from 'ethers';

import { getSignerAddress, getSignerPrivateKey } from '../account/crypto';
import { canonicalJStackAddress } from '../jadapter/stack-binding';
import type { JAdapter } from '../jadapter/types';
import { createStructuredLogger, shortHash, shortId } from '../infra/logger';
import type { ConsensusConfig, EntityType, Env, JurisdictionConfig } from '../types';
import { DEBUG } from '../utils';

// Extend globalThis to include our entity counter
declare global {
  // eslint-disable-next-line no-var
  var _entityCounter: number | undefined;
}

let namedRequestCounter = 0;
const factoryLog = createStructuredLogger('entity.factory');

// Entity encoding utilities
type BoardSignerContext = Pick<Env, 'runtimeSeed'>;

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
        (env ? '' : ':numeric aliases require explicit Env'),
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

export const getTrustedRegistrationAdapter = (
  env: Env,
  jurisdiction: JurisdictionConfig,
): JAdapter => {
  const expectedChainId = Number(jurisdiction.chainId);
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
    throw new Error(`NUMBERED_REGISTRATION_CHAIN_ID_INVALID:${String(jurisdiction.chainId)}`);
  }
  const expectedDepository = canonicalJStackAddress(
    'numbered_registration:depository',
    jurisdiction.depositoryAddress,
  );
  const expectedEntityProvider = canonicalJStackAddress(
    'numbered_registration:entity_provider',
    jurisdiction.entityProviderAddress,
  );
  const candidates = new Set<JAdapter>();
  if (env.jAdapter) candidates.add(env.jAdapter);
  for (const replica of env.jReplicas.values()) {
    if (replica.jadapter) candidates.add(replica.jadapter);
  }
  const matches = [...candidates].filter((adapter) =>
    adapter.chainId === expectedChainId &&
    canonicalJStackAddress('numbered_registration:adapter_depository', adapter.addresses.depository) === expectedDepository &&
    canonicalJStackAddress('numbered_registration:adapter_entity_provider', adapter.addresses.entityProvider) === expectedEntityProvider
  );
  if (matches.length !== 1) {
    throw new Error(
      `NUMBERED_REGISTRATION_TRUSTED_ADAPTER_${matches.length === 0 ? 'MISSING' : 'AMBIGUOUS'}` +
      `:chainId=${expectedChainId}:depository=${expectedDepository}:entityProvider=${expectedEntityProvider}`,
    );
  }
  return matches[0]!;
};

export const getNumberedRegistrationWallet = (
  env: Env,
  jadapter: JAdapter,
  registrationSignerId: string,
): ethers.Wallet => {
  const normalizedSignerId = String(registrationSignerId || '').trim();
  if (!normalizedSignerId) throw new Error('NUMBERED_REGISTRATION_SIGNER_REQUIRED');
  const wallet = new ethers.Wallet(
    ethers.hexlify(getSignerPrivateKey(env, normalizedSignerId)),
    jadapter.provider,
  );
  if (ethers.isAddress(normalizedSignerId) && wallet.address.toLowerCase() !== normalizedSignerId.toLowerCase()) {
    throw new Error(`NUMBERED_REGISTRATION_SIGNER_KEY_MISMATCH:${normalizedSignerId}:${wallet.address}`);
  }
  return wallet;
};

export type NumberedEntityRegistration = Readonly<{
  entityNumber: number;
  entityId: string;
  logIndex: number;
}>;

export const parseNumberedEntityRegistrationReceipt = (
  jadapter: JAdapter,
  receipt: TransactionReceipt,
  expectedBoardHashes: readonly string[],
): NumberedEntityRegistration[] => {
  if (receipt.status !== 1) throw new Error('NUMBERED_REGISTRATION_RECEIPT_FAILED');
  const entityProviderAddress = canonicalJStackAddress(
    'numbered_registration:receipt_entity_provider',
    jadapter.addresses.entityProvider,
  );
  const events = receipt.logs
    .filter((log) => ethers.getAddress(log.address) === entityProviderAddress)
    .map((log) => ({ log, event: jadapter.entityProvider.interface.parseLog(log) }))
    .filter(({ event }) => event?.name === 'EntityRegistered');
  if (events.length !== expectedBoardHashes.length) {
    throw new Error(
      `NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=${expectedBoardHashes.length}:actual=${events.length}`,
    );
  }
  return events.map(({ event, log }, index) => {
    const expectedBoardHash = expectedBoardHashes[index]!;
    if (String(event!.args['boardHash']).toLowerCase() !== expectedBoardHash.toLowerCase()) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=${index}`);
    }
    const rawEntityNumber = event!.args['entityNumber'];
    const entityNumber = Number(rawEntityNumber);
    if (!Number.isSafeInteger(entityNumber) || entityNumber <= 0 || BigInt(entityNumber) !== BigInt(rawEntityNumber)) {
      throw new Error(`NUMBERED_REGISTRATION_ENTITY_NUMBER_INVALID:${String(rawEntityNumber)}`);
    }
    if (index > 0 && entityNumber !== Number(events[index - 1]!.event!.args['entityNumber']) + 1) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ORDER_INVALID:index=${index}`);
    }
    const entityId = generateNumberedEntityId(entityNumber);
    if (String(event!.args['entityId']).toLowerCase() !== entityId) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ENTITY_ID_MISMATCH:index=${index}`);
    }
    return { entityNumber, entityId, logIndex: log.index };
  });
};

// 2. NUMBERED ENTITIES (Small gas cost)
export const createNumberedEntity = async (
  name: string,
  validators: readonly BoardMemberInput[],
  threshold: bigint,
  jurisdiction: JurisdictionConfig,
  env: Env,
  registrationSignerId: string,
): Promise<{ config: ConsensusConfig; entityNumber: number; entityId: string }> => {
  if (!jurisdiction) {
    throw new Error('Jurisdiction required for numbered entity registration');
  }

  const members = normalizeBoardMembers(validators);
  const requestedConfig = boardConfig(members, threshold, jurisdiction);
  const boardHash = hashBoard(encodeBoard(requestedConfig, env));

  if (DEBUG) {
    factoryLog.debug('numbered.create', {
      name,
      board: shortHash(boardHash),
      jurisdiction: jurisdiction.name,
    });
  }

  try {
    const jadapter = getTrustedRegistrationAdapter(env, jurisdiction);
    const entityProvider = jadapter.entityProvider.connect(
      getNumberedRegistrationWallet(env, jadapter, registrationSignerId),
    );
    const tx = await entityProvider.registerNumberedEntity(boardHash);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('registerNumberedEntity failed');
    const registration = parseNumberedEntityRegistrationReceipt(jadapter, receipt, [boardHash])[0]!;
    const { entityNumber, entityId } = registration;

    if (DEBUG) factoryLog.debug('numbered.registered', { name, entityNumber, entity: shortId(entityId, 8) });

    const config: ConsensusConfig = {
      ...requestedConfig,
      jurisdiction: {
        ...jurisdiction,
        entityProviderDeploymentBlock: jadapter.entityProviderDeploymentBlock,
        registrationBlock: receipt.blockNumber,
      },
    };

    return { config, entityNumber, entityId };
  } catch (error) {
    factoryLog.error('numbered.register_failed', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

/**
 * Batch create multiple numbered entities in ONE transaction
 * Optimized for scenarios importing many entities (e.g., PhantomGrid 1000 nodes)
 */
export const createNumberedEntitiesBatch = async (
  entities: readonly Readonly<{
    name: string;
    validators: readonly BoardMemberInput[];
    threshold: bigint;
  }>[],
  jurisdiction: JurisdictionConfig,
  env: Env,
  registrationSignerId: string,
): Promise<Array<{ config: ConsensusConfig; entityNumber: number; entityId: string }>> => {
  if (!jurisdiction) {
    throw new Error('Jurisdiction required for numbered entity registration');
  }
  if (entities.length === 0) throw new Error('NUMBERED_REGISTRATION_BATCH_EMPTY');

  if (DEBUG) factoryLog.debug('numbered.batch_create', { count: entities.length });

  const configs = entities.map((entity) =>
    boardConfig(normalizeBoardMembers(entity.validators), entity.threshold, jurisdiction));

  const boardHashes = configs.map((config) => hashBoard(encodeBoard(config, env)));
  const jadapter = getTrustedRegistrationAdapter(env, jurisdiction);
  const entityProvider = jadapter.entityProvider.connect(
    getNumberedRegistrationWallet(env, jadapter, registrationSignerId),
  );
  const tx = await entityProvider.registerNumberedEntitiesBatch(boardHashes);
  const receipt = await tx.wait();
  if (!receipt) throw new Error('registerNumberedEntitiesBatch failed');
  const registrations = parseNumberedEntityRegistrationReceipt(jadapter, receipt, boardHashes);

  return registrations.map(({ entityNumber, entityId }, i) => {
    const preparedConfig = configs[i];
    if (!preparedConfig) throw new Error(`Missing config for entity ${i}`);
    const config: ConsensusConfig = {
      ...preparedConfig,
      jurisdiction: {
        ...jurisdiction,
        entityProviderDeploymentBlock: jadapter.entityProviderDeploymentBlock,
        registrationBlock: receipt.blockNumber,
      },
    };

    if (DEBUG) {
      factoryLog.debug('numbered.batch_registered', {
        index: i + 1,
        count: entities.length,
        entityNumber,
        entity: shortId(entityId, 8),
      });
    }

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
