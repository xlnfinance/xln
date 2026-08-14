import { ethers } from 'ethers';

import { createEmptyBatch, type JBatch } from '../../machine/batch';

/** Compute the bilateral Account key used by Depository storage. */
export const computeAccountKey = (entity1: string, entity2: string): string => {
  const [left, right] =
    entity1.toLowerCase() < entity2.toLowerCase()
      ? [entity1, entity2]
      : [entity2, entity1];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
};

export const buildExternalTokenToReserveBatch = (params: {
  entityId: string;
  tokenAddress: string;
  amount: bigint;
  tokenType?: number;
  externalTokenId?: bigint;
  internalTokenId?: number;
}): JBatch => {
  const batch = createEmptyBatch();
  batch.externalTokenToReserve.push({
    entity: params.entityId,
    contractAddress: params.tokenAddress,
    externalTokenId: params.externalTokenId ?? 0n,
    tokenType: params.tokenType ?? 0,
    internalTokenId: params.internalTokenId ?? 0,
    amount: params.amount,
  });
  return batch;
};
