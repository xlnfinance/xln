import { describe, expect, test } from 'bun:test';

import { planRpcBatchSubmission } from '../../../jurisdiction/adapter/rpc/write/rpc-batch-plan';
import {
  batchOpCount,
  computeBatchHankoHash,
  createEmptyBatch,
  encodeJBatch,
} from '../../../jurisdiction/machine/batch';
import { createEmptyEnv } from '../../../runtime';
import { entity } from '../../helpers/cross-j';

const entityId = entity('11');
const depositoryAddress = `0x${'33'.repeat(20)}`;
const canonicalTransformer = `0x${'44'.repeat(20)}`;
const foreignTransformer = `0x${'55'.repeat(20)}`;
const chainId = 31337;

const seal = (transformer: string) => {
  const batch = createEmptyBatch();
  batch.revealSecrets.push({ transformer, secret: `0x${'ab'.repeat(32)}` });
  const encodedBatch = encodeJBatch(batch);
  return {
    type: 'batch' as const,
    entityId,
    data: {
      batch,
      encodedBatch,
      batchHash: computeBatchHankoHash(BigInt(chainId), depositoryAddress, encodedBatch, 1n),
      entityNonce: 1,
      hankoSignature: '0x1234',
      batchSize: batchOpCount(batch),
    },
    timestamp: 1_000,
  };
};

// Mirror of Depository._processBatch: `reveal.transformer != deltaTransformer`
// reverts E2 on chain. The plan must reject the same batch before it is sent.
describe('rpc batch plan canonical transformer reveal', () => {
  test('rejects a secret reveal routed to a non-canonical transformer', () => {
    const result = planRpcBatchSubmission(
      seal(foreignTransformer),
      createEmptyEnv('rpc-batch-reveal-foreign'),
      undefined,
      chainId,
      depositoryAddress,
      canonicalTransformer,
    );
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.error.startsWith('REVEAL_TRANSFORMER_NOT_CANONICAL:')).toBe(true);
    }
  });

  test('accepts a secret reveal routed to the canonical transformer (case-insensitive)', () => {
    const result = planRpcBatchSubmission(
      seal(canonicalTransformer.toUpperCase().replace('0X', '0x')),
      createEmptyEnv('rpc-batch-reveal-canonical'),
      undefined,
      chainId,
      depositoryAddress,
      canonicalTransformer,
    );
    expect(result.kind).toBe('submit');
  });
});
