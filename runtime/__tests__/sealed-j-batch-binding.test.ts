import { describe, expect, test } from 'bun:test';

import {
  computeBatchHankoHash,
  createEmptyBatch,
  encodeJBatch,
  getBatchSize,
} from '../jurisdiction/batch';
import { assertSealedJBatchBinding } from '../jurisdiction/sealed-batch';
import type { JTx } from '../types';

const entityId = `0x${'11'.repeat(32)}`;
const receivingEntity = `0x${'22'.repeat(32)}`;
const depositoryAddress = `0x${'33'.repeat(20)}`;
const chainId = 31337;
const entityNonce = 1;

const makeSealedBatch = (): Extract<JTx, { type: 'batch' }> => {
  const batch = createEmptyBatch();
  batch.reserveToReserve.push({ receivingEntity, tokenId: 1, amount: 10n });
  const encodedBatch = encodeJBatch(batch);
  return {
    type: 'batch',
    entityId,
    data: {
      batch,
      encodedBatch,
      batchHash: computeBatchHankoHash(
        BigInt(chainId),
        depositoryAddress,
        encodedBatch,
        BigInt(entityNonce),
      ),
      entityNonce,
      hankoSignature: '0x1234',
      batchSize: getBatchSize(batch),
    },
    timestamp: 1_000,
  };
};

const assertBinding = (jTx: Extract<JTx, { type: 'batch' }>): void => {
  assertSealedJBatchBinding(jTx, { chainId, depositoryAddress });
};

describe('sealed J-batch binding', () => {
  test('accepts the exact batch, encoding, size, nonce, and domain hash', () => {
    expect(() => assertBinding(makeSealedBatch())).not.toThrow();
  });

  test('rejects a batch object that differs from the authorized encoding', () => {
    const jTx = makeSealedBatch();
    jTx.data.batch.reserveToReserve[0]!.amount = 11n;
    expect(() => assertBinding(jTx)).toThrow('J_BATCH_ENCODING_MISMATCH');
  });

  test('rejects a stale batch size', () => {
    const jTx = makeSealedBatch();
    jTx.data.batchSize = 0;
    expect(() => assertBinding(jTx)).toThrow('J_BATCH_SIZE_MISMATCH:0:1');
  });

  test('rejects a hash from another domain or nonce', () => {
    const jTx = makeSealedBatch();
    jTx.data.batchHash = computeBatchHankoHash(
      BigInt(chainId + 1),
      depositoryAddress,
      jTx.data.encodedBatch!,
      BigInt(entityNonce),
    );
    expect(() => assertBinding(jTx)).toThrow('J_BATCH_HASH_MISMATCH');
  });

  test('does not let an encoded non-empty payload hide behind an empty batch object', () => {
    const sealed = makeSealedBatch();
    sealed.data.batch = createEmptyBatch();
    sealed.data.batchSize = 0;
    expect(() => assertBinding(sealed)).toThrow('J_BATCH_ENCODING_MISMATCH');
  });
});
