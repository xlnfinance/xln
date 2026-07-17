import { ethers } from 'ethers';

import type { JAdapter } from '../jadapter/types';
import { getCertifiedBoardStackKey } from '../jurisdiction/board-registry';
import { encodeCanonicalEntityConsensusValue } from './consensus/state-root';
import type {
  Env,
  NumberedRegistrationRequest,
  PendingNumberedRegistration,
} from '../types';
import {
  createLazyEntity,
  encodeBoard,
  hashBoard,
  type BoardMemberInput,
} from './factory';

export type NumberedRegistrationDefinition = Readonly<{
  name: string;
  validators: readonly BoardMemberInput[];
  threshold: bigint;
  profileName?: string;
  position?: { x: number; y: number; z: number; jurisdiction?: string; xlnomy?: string };
}>;

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
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: 'xln.numbered-registration.intent.v1',
    request,
  }))).toLowerCase();

export const encodeNumberedRegistrationCalldata = (
  adapter: JAdapter,
  request: NumberedRegistrationRequest,
): string => adapter.entityProvider.interface.encodeFunctionData(
  'registerNumberedEntitiesBatch',
  [request.entities.map(entity => entity.boardHash)],
).toLowerCase();

export const assertNumberedRegistrationRequest = (env: Env, request: NumberedRegistrationRequest): void => {
  if (request.version !== 1) throw new Error('NUMBERED_REGISTRATION_INTENT_VERSION_INVALID');
  numberedRegistrationBytes32(request.intentId, 'INTENT_ID');
  numberedRegistrationBytes32(request.stackKey, 'STACK_KEY');
  address(request.payerSignerId, 'PAYER');
  address(request.entityProviderAddress, 'ENTITY_PROVIDER');
  if (request.entities.length === 0) throw new Error('NUMBERED_REGISTRATION_INTENT_EMPTY');
  for (const [index, entity] of request.entities.entries()) {
    if (!entity.name || entity.name.length > 256) throw new Error(`NUMBERED_REGISTRATION_NAME_INVALID:${index}`);
    if (!entity.config.jurisdiction) throw new Error(`NUMBERED_REGISTRATION_STACK_MISSING:${index}`);
    if (getCertifiedBoardStackKey(entity.config.jurisdiction) !== request.stackKey) {
      throw new Error(`NUMBERED_REGISTRATION_STACK_MISMATCH:${index}`);
    }
    if (address(entity.config.jurisdiction.entityProviderAddress, 'CONFIG_ENTITY_PROVIDER') !== request.entityProviderAddress) {
      throw new Error(`NUMBERED_REGISTRATION_ENTITY_PROVIDER_MISMATCH:${index}`);
    }
    const expectedBoard = numberedRegistrationBytes32(entity.boardHash, 'BOARD_HASH');
    if (hashBoard(encodeBoard(entity.config, env)).toLowerCase() !== expectedBoard) {
      throw new Error(`NUMBERED_REGISTRATION_BOARD_HASH_MISMATCH:${index}`);
    }
    if (entity.position && ![entity.position.x, entity.position.y, entity.position.z].every(Number.isFinite)) {
      throw new Error(`NUMBERED_REGISTRATION_POSITION_INVALID:${index}`);
    }
  }
};

export const parseNumberedRegistrationIntentTransaction = (
  adapter: JAdapter,
  pending: PendingNumberedRegistration,
) => {
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
  if (tx.value !== 0n || tx.data.toLowerCase() !== encodeNumberedRegistrationCalldata(adapter, pending.request)) {
    throw new Error('NUMBERED_REGISTRATION_TX_CALLDATA_MISMATCH');
  }
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || tx.nonce !== pending.transactionNonce) {
    throw new Error('NUMBERED_REGISTRATION_TX_NONCE_MISMATCH');
  }
  return tx;
};

export const buildNumberedRegistrationRequest = (
  env: Env,
  input: {
    intentId: string;
    jurisdiction: NonNullable<NumberedRegistrationRequest['entities'][number]['config']['jurisdiction']>;
    payerSignerId: string;
    entities: readonly NumberedRegistrationDefinition[];
  },
): NumberedRegistrationRequest => {
  const request: NumberedRegistrationRequest = {
    version: 1,
    intentId: numberedRegistrationBytes32(input.intentId, 'INTENT_ID'),
    stackKey: getCertifiedBoardStackKey(input.jurisdiction),
    payerSignerId: address(input.payerSignerId, 'PAYER'),
    entityProviderAddress: address(input.jurisdiction.entityProviderAddress, 'ENTITY_PROVIDER'),
    entities: input.entities.map(entity => {
      const config = createLazyEntity(
        entity.name,
        entity.validators,
        entity.threshold,
        input.jurisdiction,
        env,
      ).config;
      return {
        name: entity.name,
        boardHash: hashBoard(encodeBoard(config, env)).toLowerCase(),
        config,
        ...(entity.profileName ? { profileName: entity.profileName } : {}),
        ...(entity.position ? { position: structuredClone(entity.position) } : {}),
      };
    }),
  };
  assertNumberedRegistrationRequest(env, request);
  return request;
};
