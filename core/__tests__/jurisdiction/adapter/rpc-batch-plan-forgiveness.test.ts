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
const counterparty = entity('22');
const depositoryAddress = `0x${'33'.repeat(20)}`;
const chainId = 31337;

const seal = (forgiveDebtsInTokenIds: number[], sig: string) => {
  const batch = createEmptyBatch();
  batch.settlements.push({
    leftEntity: entityId,
    rightEntity: counterparty,
    diffs: [],
    forgiveDebtsInTokenIds,
    sig,
    nonce: 1,
  });
  const encodedBatch = encodeJBatch(batch);
  return {
    type: 'batch' as const,
    entityId,
    data: {
      batch,
      encodedBatch,
      batchHash: computeBatchHankoHash(
        BigInt(chainId),
        depositoryAddress,
        encodedBatch,
        1n,
      ),
      entityNonce: 1,
      hankoSignature: '0x1234',
      batchSize: batchOpCount(batch),
    },
    timestamp: 1_000,
  };
};

describe('rpc batch plan settlement authority', () => {
  test('rejects unsigned pure-forgiveness because Account.sol requires a settlement sig', () => {
    const result = planRpcBatchSubmission(
      seal([1], '0x'),
      createEmptyEnv('rpc-batch-forgiveness'),
      undefined,
      chainId,
      depositoryAddress,
    );
    expect(result).toEqual({ kind: 'reject', error: 'Settlement missing hanko sig' });
  });

  test('accepts signed pure-forgiveness for submission planning', () => {
    const result = planRpcBatchSubmission(
      seal([1], '0xabcd'),
      createEmptyEnv('rpc-batch-forgiveness-signed'),
      undefined,
      chainId,
      depositoryAddress,
    );
    expect(result.kind).toBe('submit');
  });
});
