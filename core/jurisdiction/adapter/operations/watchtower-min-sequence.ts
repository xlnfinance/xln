import type { ethers } from 'ethers';

import type { EntityProvider } from '../../../../jurisdictions/typechain-types/index.ts';
import { buildSingleSignerHanko } from '../../../hanko/batch';
import {
  ENTITY_PROVIDER_ACTION_KIND,
  hashWatchtowerMinSequenceHankoPayload,
} from '../../../hanko/onchain-domain';

/**
 * Adapter-level helper for EntityProvider.setWatchtowerMinSequence.
 *
 * Raising the minimum revokes every tower appointment whose
 * appointmentSequence is below it (Depository.watchtowerCounterDispute reverts
 * E2). The action consumes the entity action nonce lane like
 * entityTransferTokens. Nothing here enters Entity consensus: the resulting
 * EntityProviderActionExecuted(kind=2) event is not yet ingested by the entity
 * action-state handler (TS + Rust accept kinds 0/1 only), so use this for
 * entities whose action lane is not consensus-tracked, or wire the ingest
 * first.
 */
export type WatchtowerMinSequenceRequest = Readonly<{
  entityNumber: bigint;
  newMinimum: bigint;
}>;

type EntityProviderReads = Pick<
  EntityProvider,
  'entityActionNonces' | 'boardEpochs' | 'computeWatchtowerMinSequenceHankoHash' | 'watchtowerMinSequence'
>;

const entityIdOf = (entityNumber: bigint): string => `0x${entityNumber.toString(16).padStart(64, '0')}`;

/** Build (hankoData, actionNonce, actionHash) for setWatchtowerMinSequence from one signer key. */
export const buildWatchtowerMinSequenceAuthorization = async (
  entityProvider: EntityProviderReads,
  domain: Readonly<{ chainId: number | bigint; entityProviderAddress: string }>,
  request: WatchtowerMinSequenceRequest,
  signerPrivateKey: string | Uint8Array,
): Promise<{ hankoData: string; actionNonce: bigint; actionHash: string; actionKind: 2 }> => {
  if (request.entityNumber <= 0n) throw new Error(`WATCHTOWER_MIN_SEQUENCE_ENTITY_NUMBER_INVALID:${request.entityNumber}`);
  const entityId = entityIdOf(request.entityNumber);
  const current = await entityProvider.watchtowerMinSequence(entityId);
  if (request.newMinimum <= current) {
    throw new Error(`WATCHTOWER_MIN_SEQUENCE_NOT_MONOTONIC:${request.newMinimum.toString()}<=${current.toString()}`);
  }
  const actionNonce = (await entityProvider.entityActionNonces(entityId)) + 1n;
  const boardEpoch = await entityProvider.boardEpochs(entityId);
  const actionHash = hashWatchtowerMinSequenceHankoPayload(
    { chainId: domain.chainId, entityProviderAddress: domain.entityProviderAddress, boardEpoch },
    { entityNumber: request.entityNumber, newMinimum: request.newMinimum, actionNonce },
  ).toLowerCase();
  // The contract derives chainId/address/boardEpoch itself; a local/on-chain
  // hash mismatch means a wrong domain, never a signable difference.
  const onchainHash = (await entityProvider.computeWatchtowerMinSequenceHankoHash(
    request.entityNumber,
    request.newMinimum,
    actionNonce,
  )).toLowerCase();
  if (onchainHash !== actionHash) {
    throw new Error(`WATCHTOWER_MIN_SEQUENCE_HASH_MISMATCH:local=${actionHash}:chain=${onchainHash}`);
  }
  return {
    hankoData: buildSingleSignerHanko(entityId, actionHash, signerPrivateKey),
    actionNonce,
    actionHash,
    actionKind: ENTITY_PROVIDER_ACTION_KIND.watchtowerMinSequence,
  };
};

/** Submit setWatchtowerMinSequence and wait for its receipt. */
export const submitWatchtowerMinSequence = async (
  entityProvider: EntityProvider,
  domain: Readonly<{ chainId: number | bigint; entityProviderAddress: string }>,
  request: WatchtowerMinSequenceRequest,
  signerPrivateKey: string | Uint8Array,
): Promise<ethers.TransactionReceipt> => {
  const authorization = await buildWatchtowerMinSequenceAuthorization(
    entityProvider,
    domain,
    request,
    signerPrivateKey,
  );
  const tx = await entityProvider.setWatchtowerMinSequence(
    request.entityNumber,
    request.newMinimum,
    authorization.hankoData,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error('WATCHTOWER_MIN_SEQUENCE_RECEIPT_MISSING');
  return receipt;
};
