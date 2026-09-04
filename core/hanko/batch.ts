import { ethers } from 'ethers';

import { computeBatchHankoHash, encodeJBatch, type JBatch } from '../jurisdiction/machine/batch';
import { normalizeEntityId } from '../entity/id';
import { encodeSignedHanko } from './codec';
import { resolveHankoBoardDelays } from './claims';
import { compactHankoForChain } from './short';

/**
 * Chain-bound single-signer Hanko. A signer proving its own lazy entity gets
 * the 65-byte form; a numbered/registered entity keeps the full envelope.
 */
export function buildSingleSignerHanko(
  entityId: string,
  hash: string,
  privateKey: string | Uint8Array,
): string {
  const paddedEntityId = ethers.zeroPadValue(normalizeEntityId(entityId), 32).toLowerCase() as `0x${string}`;
  const envelope = encodeSignedHanko({
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
    memberSignatures: [],
  });
  return compactHankoForChain(envelope, hash);
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
