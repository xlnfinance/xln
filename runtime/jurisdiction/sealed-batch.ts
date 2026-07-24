import type { JTx } from '../types';
import {
  assertJBatchWithinContractLimits,
  batchOpCount,
  computeBatchHankoHash,
  encodeJBatch,
  getBatchSize,
} from './batch';
import { keccak256 } from 'ethers';

type BatchJTx = Extract<JTx, { type: 'batch' }>;

export type SealedJBatchDomain = Readonly<{
  chainId: number | bigint;
  depositoryAddress: string;
}>;

const normalizedHex = (value: string): string => value.trim().toLowerCase();

/**
 * A sealed JTx carries one payload in several redundant forms for consensus,
 * durable retry, and adapter routing. Rebind them before external submission
 * so restored or mutated state cannot make the adapter inspect different bytes
 * from the bytes authorized by Hanko.
 */
export const assertSealedJBatchBinding = (
  jTx: BatchJTx,
  domain: SealedJBatchDomain,
): void => {
  const { data } = jTx;
  const missing: string[] = [];
  if (!data.hankoSignature) missing.push('hankoSignature');
  if (!data.batchHash) missing.push('batchHash');
  if (!data.encodedBatch) missing.push('encodedBatch');
  if (!Number.isSafeInteger(data.entityNonce) || Number(data.entityNonce) < 1) {
    missing.push('entityNonce');
  }
  if (missing.length > 0) {
    throw new Error(`J_BATCH_SEALED_FIELD_MISSING:${jTx.entityId}:${missing.join(',')}`);
  }

  assertJBatchWithinContractLimits(data.batch, 'sealed_j_batch');

  const expectedSize = getBatchSize(data.batch);
  if (data.batchSize !== expectedSize) {
    throw new Error(`J_BATCH_SIZE_MISMATCH:${data.batchSize}:${expectedSize}`);
  }

  const expectedEncodedBatch = encodeJBatch(data.batch);
  if (normalizedHex(data.encodedBatch!) !== normalizedHex(expectedEncodedBatch)) {
    throw new Error(
      `J_BATCH_ENCODING_MISMATCH:` +
      `storedHash=${keccak256(data.encodedBatch!)}:` +
      `encodedHash=${keccak256(expectedEncodedBatch)}:` +
      `storedBytes=${(data.encodedBatch!.length - 2) / 2}:` +
      `encodedBytes=${(expectedEncodedBatch.length - 2) / 2}:` +
      `ops=${batchOpCount(data.batch)}`,
    );
  }

  const expectedBatchHash = computeBatchHankoHash(
    BigInt(domain.chainId),
    domain.depositoryAddress,
    expectedEncodedBatch,
    BigInt(data.entityNonce!),
  );
  if (normalizedHex(data.batchHash!) !== normalizedHex(expectedBatchHash)) {
    throw new Error(`J_BATCH_HASH_MISMATCH:${data.batchHash}:${expectedBatchHash}`);
  }
};
