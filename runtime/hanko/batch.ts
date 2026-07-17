import { ethers } from 'ethers';

import { computeBatchHankoHash, encodeJBatch, type JBatch } from '../jurisdiction/batch';
import { normalizeEntityId } from '../entity/id';
import { encodeSignedHanko } from './codec';
import { resolveHankoBoardDelays } from './claims';

export function buildSingleSignerHanko(
  entityId: string,
  hash: string,
  privateKey: string | Uint8Array,
): string {
  const paddedEntityId = ethers.zeroPadValue(normalizeEntityId(entityId), 32).toLowerCase() as `0x${string}`;
  return encodeSignedHanko({
    digest: hash,
    privateKeys: [typeof privateKey === 'string' ? ethers.getBytes(privateKey) : privateKey],
    placeholders: [],
    claims: [{
      entityId: paddedEntityId,
      entityIndexes: [0n],
      weights: [1n],
      threshold: 1n,
      ...resolveHankoBoardDelays(),
    }],
  });
}

export function prepareSignedBatch(
  batch: JBatch,
  entityId: string,
  privateKey: string | Uint8Array,
  chainId: bigint,
  depositoryAddress: string,
  currentNonce: bigint,
): {
  encodedBatch: string;
  hankoData: string;
  nextNonce: bigint;
  batchHash: string;
} {
  const encodedBatch = encodeJBatch(batch);
  const nextNonce = currentNonce + 1n;
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);
  const hankoData = buildSingleSignerHanko(entityId, batchHash, privateKey);
  return { encodedBatch, hankoData, nextNonce, batchHash };
}
