import { ethers, type TransactionReceipt } from 'ethers';

import { getSignerPrivateKey } from '../../account/crypto';
import {
  createLazyEntity,
  encodeBoard,
  generateNumberedEntityId,
  hashBoard,
  type BoardMemberInput,
} from '../../entity/factory';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { canonicalJStackAddress } from '../../jadapter/stack-binding';
import type { JAdapter } from '../../jadapter/types';
import type { ConsensusConfig, JurisdictionConfig } from '../../entity/types';
import type { RuntimeReplica } from '../types';
import { DEBUG } from '../../infra/debug-flags';

const registrationLog = createStructuredLogger('runtime.numbered-registration');

export const getTrustedRegistrationAdapter = (
  env: RuntimeReplica,
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
  for (const replica of env.state.jReplicas.values()) {
    if (replica.jadapter) candidates.add(replica.jadapter);
  }
  const matches = [...candidates].filter((adapter) =>
    adapter.chainId === expectedChainId &&
    canonicalJStackAddress(
      'numbered_registration:adapter_depository',
      adapter.addresses.depository,
    ) === expectedDepository &&
    canonicalJStackAddress(
      'numbered_registration:adapter_entity_provider',
      adapter.addresses.entityProvider,
    ) === expectedEntityProvider
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
  env: RuntimeReplica,
  jadapter: JAdapter,
  registrationSignerId: string,
): ethers.Wallet => {
  const normalizedSignerId = String(registrationSignerId || '').trim();
  if (!normalizedSignerId) throw new Error('NUMBERED_REGISTRATION_SIGNER_REQUIRED');
  const wallet = new ethers.Wallet(
    ethers.hexlify(getSignerPrivateKey(env, normalizedSignerId)),
    jadapter.provider,
  );
  if (
    ethers.isAddress(normalizedSignerId) &&
    wallet.address.toLowerCase() !== normalizedSignerId.toLowerCase()
  ) {
    throw new Error(
      `NUMBERED_REGISTRATION_SIGNER_KEY_MISMATCH:${normalizedSignerId}:${wallet.address}`,
    );
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
    if (
      !Number.isSafeInteger(entityNumber) ||
      entityNumber <= 0 ||
      BigInt(entityNumber) !== BigInt(rawEntityNumber)
    ) {
      throw new Error(`NUMBERED_REGISTRATION_ENTITY_NUMBER_INVALID:${String(rawEntityNumber)}`);
    }
    if (
      index > 0 &&
      entityNumber !== Number(events[index - 1]!.event!.args['entityNumber']) + 1
    ) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ORDER_INVALID:index=${index}`);
    }
    const entityId = generateNumberedEntityId(entityNumber);
    if (String(event!.args['entityId']).toLowerCase() !== entityId) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ENTITY_ID_MISMATCH:index=${index}`);
    }
    return { entityNumber, entityId, logIndex: log.index };
  });
};

export const createNumberedEntity = async (
  name: string,
  validators: readonly BoardMemberInput[],
  threshold: bigint,
  jurisdiction: JurisdictionConfig,
  env: RuntimeReplica,
  registrationSignerId: string,
): Promise<{ config: ConsensusConfig; entityNumber: number; entityId: string }> => {
  const requestedConfig = createLazyEntity(
    name,
    validators,
    threshold,
    jurisdiction,
    env,
  ).config;
  const boardHash = hashBoard(encodeBoard(requestedConfig, env));
  if (DEBUG) {
    registrationLog.debug('create', {
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
    const registration = parseNumberedEntityRegistrationReceipt(
      jadapter,
      receipt,
      [boardHash],
    )[0]!;
    const config: ConsensusConfig = {
      ...requestedConfig,
      jurisdiction: {
        ...jurisdiction,
        entityProviderDeploymentBlock: jadapter.entityProviderDeploymentBlock,
        registrationBlock: receipt.blockNumber,
      },
    };
    if (DEBUG) {
      registrationLog.debug('registered', {
        name,
        entityNumber: registration.entityNumber,
        entity: shortId(registration.entityId, 8),
      });
    }
    return { config, entityNumber: registration.entityNumber, entityId: registration.entityId };
  } catch (error) {
    registrationLog.error('register_failed', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const createNumberedEntitiesBatch = async (
  entities: readonly Readonly<{
    name: string;
    validators: readonly BoardMemberInput[];
    threshold: bigint;
  }>[],
  jurisdiction: JurisdictionConfig,
  env: RuntimeReplica,
  registrationSignerId: string,
): Promise<Array<{ config: ConsensusConfig; entityNumber: number; entityId: string }>> => {
  if (entities.length === 0) throw new Error('NUMBERED_REGISTRATION_BATCH_EMPTY');
  if (DEBUG) registrationLog.debug('batch_create', { count: entities.length });

  const configs = entities.map((entity) => createLazyEntity(
    entity.name,
    entity.validators,
    entity.threshold,
    jurisdiction,
    env,
  ).config);
  const boardHashes = configs.map((config) => hashBoard(encodeBoard(config, env)));
  const jadapter = getTrustedRegistrationAdapter(env, jurisdiction);
  const entityProvider = jadapter.entityProvider.connect(
    getNumberedRegistrationWallet(env, jadapter, registrationSignerId),
  );
  const tx = await entityProvider.registerNumberedEntitiesBatch(boardHashes);
  const receipt = await tx.wait();
  if (!receipt) throw new Error('registerNumberedEntitiesBatch failed');
  const registrations = parseNumberedEntityRegistrationReceipt(jadapter, receipt, boardHashes);

  return registrations.map(({ entityNumber, entityId }, index) => {
    const preparedConfig = configs[index];
    if (!preparedConfig) throw new Error(`Missing config for entity ${index}`);
    const config: ConsensusConfig = {
      ...preparedConfig,
      jurisdiction: {
        ...jurisdiction,
        entityProviderDeploymentBlock: jadapter.entityProviderDeploymentBlock,
        registrationBlock: receipt.blockNumber,
      },
    };
    if (DEBUG) {
      registrationLog.debug('batch_registered', {
        index: index + 1,
        count: entities.length,
        entityNumber,
        entity: shortId(entityId, 8),
      });
    }
    return { config, entityNumber, entityId };
  });
};
