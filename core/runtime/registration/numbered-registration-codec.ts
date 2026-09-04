import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../protocol/crypto/keccak-text';
import { ethers } from 'ethers';
import { EntityProvider__factory } from '../../../jurisdictions/typechain-types';

import { getCertifiedBoardStackKey } from '../../jurisdiction/machine/board-registry';

import type {
  NumberedRegistrationDefinition,
  NumberedRegistrationRequest,
  PendingNumberedRegistration,
  RuntimeReplica,
} from '../types';
import { createLazyEntity, encodeBoard, hashBoard } from '../../entity/factory';
import { canonicalEntitySeed } from './entity-creation';

export type { NumberedRegistrationDefinition } from '../types';

const entityProviderInterface = EntityProvider__factory.createInterface();
export const MAX_NUMBERED_REGISTRATION_ENTITIES = 128;

export const numberedRegistrationBytes32 = (value: string, label: string): string => {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`NUMBERED_REGISTRATION_${label}_INVALID`);
  return normalized;
};

const address = (value: string, label: string): string => {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    throw new Error(`NUMBERED_REGISTRATION_${label}_INVALID:${String(value)}`);
  }
};

export const computeNumberedRegistrationRequestHash = (request: NumberedRegistrationRequest): string =>
  keccakBytesHash(
        encodeCanonicalConsensusBytes({
          domain: 'xln.numbered-registration.intent.v1',
          request,
        }),
  );

const computeNumberedRegistrationIntentId = (
  request: Omit<NumberedRegistrationRequest, 'intentId'>,
): string => keccakBytesHash(
      encodeCanonicalConsensusBytes({
        domain: 'xln.numbered-registration.intent-id.v1',
        request,
      }),
);

export const encodeNumberedRegistrationCalldata = (request: NumberedRegistrationRequest): string =>
  entityProviderInterface
    .encodeFunctionData('registerNumberedEntitiesBatch', [request.entities.map(entity => entity.encodedBoard)])
    .toLowerCase();

export const assertNumberedRegistrationRequest = (env: RuntimeReplica, request: NumberedRegistrationRequest): void => {
  if (request.version !== 1) throw new Error('NUMBERED_REGISTRATION_INTENT_VERSION_INVALID');
  if (request.intentId !== numberedRegistrationBytes32(request.intentId, 'INTENT_ID')) {
    throw new Error('NUMBERED_REGISTRATION_INTENT_ID_NON_CANONICAL');
  }
  if (request.stackKey !== numberedRegistrationBytes32(request.stackKey, 'STACK_KEY')) {
    throw new Error('NUMBERED_REGISTRATION_STACK_KEY_NON_CANONICAL');
  }
  address(request.payerSignerId, 'PAYER');
  address(request.entityProviderAddress, 'ENTITY_PROVIDER');
  const committedStack = [...env.state.jReplicas.values()].some(replica => {
    const depositoryAddress = replica.contracts?.depository;
    const entityProviderAddress = replica.contracts?.entityProvider;
    if (!replica.chainId || !depositoryAddress || !entityProviderAddress) return false;
    return getCertifiedBoardStackKey({
      chainId: replica.chainId,
      depositoryAddress,
      entityProviderAddress,
    }) === request.stackKey;
  });
  if (!committedStack) throw new Error('NUMBERED_REGISTRATION_COMMITTED_STACK_MISSING');
  if (request.entities.length === 0) throw new Error('NUMBERED_REGISTRATION_INTENT_EMPTY');
  if (request.entities.length > MAX_NUMBERED_REGISTRATION_ENTITIES) {
    throw new Error(`NUMBERED_REGISTRATION_ENTITY_LIMIT_EXCEEDED:${request.entities.length}`);
  }
  for (const [index, entity] of request.entities.entries()) {
    if (!entity.name || entity.name.length > 256) throw new Error(`NUMBERED_REGISTRATION_NAME_INVALID:${index}`);
    if (!entity.config.jurisdiction) throw new Error(`NUMBERED_REGISTRATION_STACK_MISSING:${index}`);
    if (getCertifiedBoardStackKey(entity.config.jurisdiction) !== request.stackKey) {
      throw new Error(`NUMBERED_REGISTRATION_STACK_MISMATCH:${index}`);
    }
    if (
      address(entity.config.jurisdiction.entityProviderAddress, 'CONFIG_ENTITY_PROVIDER') !==
      request.entityProviderAddress
    ) {
      throw new Error(`NUMBERED_REGISTRATION_ENTITY_PROVIDER_MISMATCH:${index}`);
    }
    const expectedBoard = numberedRegistrationBytes32(entity.boardHash, 'BOARD_HASH');
    if (typeof entity.encodedBoard !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(entity.encodedBoard)) {
      throw new Error(`NUMBERED_REGISTRATION_ENCODED_BOARD_INVALID:${index}`);
    }
    if (encodeBoard(entity.config, env).toLowerCase() !== entity.encodedBoard) {
      throw new Error(`NUMBERED_REGISTRATION_ENCODED_BOARD_MISMATCH:${index}`);
    }
    if (hashBoard(entity.encodedBoard).toLowerCase() !== expectedBoard) {
      throw new Error(`NUMBERED_REGISTRATION_BOARD_HASH_MISMATCH:${index}`);
    }
    if (entity.localSignerId !== null) {
      const localSignerId = address(entity.localSignerId, 'LOCAL_SIGNER');
      if (!entity.config.validators.some(validator => validator.toLowerCase() === localSignerId)) {
        throw new Error(`NUMBERED_REGISTRATION_LOCAL_SIGNER_NOT_ON_BOARD:${index}`);
      }
      if (canonicalEntitySeed(entity.entitySeed) !== entity.entitySeed) {
        throw new Error(`NUMBERED_REGISTRATION_ENTITY_SEED_NON_CANONICAL:${index}`);
      }
    } else if (entity.entitySeed !== null) {
      throw new Error(`NUMBERED_REGISTRATION_PAYER_ONLY_SEED_FORBIDDEN:${index}`);
    }
    if (entity.position && ![entity.position.x, entity.position.y, entity.position.z].every(Number.isFinite)) {
      throw new Error(`NUMBERED_REGISTRATION_POSITION_INVALID:${index}`);
    }
  }
};

export const parseNumberedRegistrationIntentTransaction = (pending: PendingNumberedRegistration) => {
  if (!/^0x[0-9a-f]+$/i.test(pending.rawTransaction) || pending.rawTransaction.length > 524_290) {
    throw new Error('NUMBERED_REGISTRATION_RAW_TX_INVALID');
  }
  const tx = ethers.Transaction.from(pending.rawTransaction);
  if (!tx.hash || tx.hash.toLowerCase() !== numberedRegistrationBytes32(pending.transactionHash, 'TX_HASH')) {
    throw new Error('NUMBERED_REGISTRATION_TX_HASH_MISMATCH');
  }
  if (!tx.from || address(tx.from, 'TX_FROM') !== pending.request.payerSignerId) {
    throw new Error('NUMBERED_REGISTRATION_TX_SIGNER_MISMATCH');
  }
  const chainId = Number(pending.request.entities[0]!.config.jurisdiction!.chainId);
  if (tx.chainId !== BigInt(chainId) || tx.to?.toLowerCase() !== pending.request.entityProviderAddress) {
    throw new Error('NUMBERED_REGISTRATION_TX_DOMAIN_MISMATCH');
  }
  if (tx.value !== 0n || tx.data.toLowerCase() !== encodeNumberedRegistrationCalldata(pending.request)) {
    throw new Error('NUMBERED_REGISTRATION_TX_CALLDATA_MISMATCH');
  }
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || tx.nonce !== pending.transactionNonce) {
    throw new Error('NUMBERED_REGISTRATION_TX_NONCE_MISMATCH');
  }
  return tx;
};

export const buildNumberedRegistrationRequest = (
  env: RuntimeReplica,
  input: {
    /** Tests/scenarios may name an intent; production derives it from the exact command. */
    intentId?: string;
    jurisdiction: NonNullable<NumberedRegistrationRequest['entities'][number]['config']['jurisdiction']>;
    payerSignerId: string;
    entities: readonly NumberedRegistrationDefinition[];
  },
): NumberedRegistrationRequest => {
  const requestWithoutIntent: Omit<NumberedRegistrationRequest, 'intentId'> = {
    version: 1,
    stackKey: getCertifiedBoardStackKey(input.jurisdiction),
    payerSignerId: address(input.payerSignerId, 'PAYER'),
    entityProviderAddress: address(input.jurisdiction.entityProviderAddress, 'ENTITY_PROVIDER'),
    entities: input.entities.map(entity => {
      const config = createLazyEntity(entity.name, entity.validators, entity.threshold, input.jurisdiction, env).config;
      const ownership = entity.localSignerId === null
        ? { localSignerId: null, entitySeed: null }
        : {
            localSignerId: address(entity.localSignerId, 'LOCAL_SIGNER'),
            entitySeed: canonicalEntitySeed(entity.entitySeed),
          };
      const encodedBoard = encodeBoard(config, env).toLowerCase();
      return {
        name: entity.name,
        boardHash: hashBoard(encodedBoard).toLowerCase(),
        encodedBoard,
        config,
        ...ownership,
        ...(entity.profileName ? { profileName: entity.profileName } : {}),
        ...(entity.position ? { position: structuredClone(entity.position) } : {}),
      };
    }),
  };
  const request: NumberedRegistrationRequest = {
    ...requestWithoutIntent,
    intentId: input.intentId === undefined
      ? computeNumberedRegistrationIntentId(requestWithoutIntent)
      : numberedRegistrationBytes32(input.intentId, 'INTENT_ID'),
  };
  assertNumberedRegistrationRequest(env, request);
  return request;
};
