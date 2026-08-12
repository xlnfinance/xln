import { describe, expect, test } from 'bun:test';

import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import {
  PROCESS_BATCH_TRANSFORMER_GAS_LIMIT,
  resolveProcessBatchGasLimit,
} from '../../../jurisdiction/adapter/rpc-public';

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const finalization = (withTransformer = true) => ({
  counterentity: ZERO_BYTES32,
  initialNonce: 1,
  finalNonce: 1,
  initialProofbodyHash: ZERO_BYTES32,
  finalProofbody: {
    watchSeed: ZERO_BYTES32,
    offdeltas: [],
    tokenIds: [],
    transformers: withTransformer
      ? [{
        transformerAddress: '0x0000000000000000000000000000000000000001',
        encodedBatch: '0x',
        allowances: [],
      }]
      : [],
  },
  starterArguments: '0x',
  otherArguments: '0x',
  sig: '0x',
  startedByLeft: true,
  cooperative: false,
});

describe('processBatch transformer gas limit', () => {
  test('rejects the estimator cheap-success no-op path for dispute finalization', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization());
    expect(resolveProcessBatchGasLimit(267_000n, batch, 'rpc'))
      .toBe(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT);
    expect(resolveProcessBatchGasLimit(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT - 1n, batch, 'rpc'))
      .toBe(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT);
  });

  test('uses the portable limit exactly and rejects an estimate above it', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization());
    expect(resolveProcessBatchGasLimit(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT, batch, 'rpc'))
      .toBe(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT);
    expect(() => resolveProcessBatchGasLimit(
      PROCESS_BATCH_TRANSFORMER_GAS_LIMIT + 1n,
      batch,
      'rpc',
    )).toThrow('J_TRANSFORMER_FINALIZATION_GAS_LIMIT');
  });

  test('does not over-reserve gas when no finalization executes transformers', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization(false));
    expect(resolveProcessBatchGasLimit(267_000n, batch, 'rpc')).toBe(267_000n);
  });

  test('rejects multiple transformer finalizations that cannot fit the tx gas cap', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization(), finalization());
    expect(() => resolveProcessBatchGasLimit(1n, batch, 'rpc')).toThrow(
      'J_TRANSFORMER_FINALIZATION_BATCH_LIMIT',
    );
  });

  test('one production finalization remains below the EIP-7825 transaction cap', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization());
    expect(resolveProcessBatchGasLimit(1n, batch, 'rpc')).toBeLessThan(1n << 24n);
  });

  test('the public resolver counts transformer clauses and excludes Tron', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push(finalization());
    expect(resolveProcessBatchGasLimit(267_000n, batch, 'rpc'))
      .toBe(PROCESS_BATCH_TRANSFORMER_GAS_LIMIT);
    expect(resolveProcessBatchGasLimit(267_000n, batch, 'tron')).toBe(267_000n);
    batch.disputeFinalizations.push(finalization());
    expect(() => resolveProcessBatchGasLimit(267_000n, batch, 'rpc')).toThrow(
      'J_TRANSFORMER_FINALIZATION_BATCH_LIMIT',
    );
  });

  test('every reachable RPC processBatch path uses the canonical resolver', async () => {
    const writeMethods = await Bun.file(
      new URL('../../../jurisdiction/adapter/rpc/write/rpc-write-methods.ts', import.meta.url),
    ).text();
    const submission = await Bun.file(
      new URL('../../../jurisdiction/adapter/rpc/write/rpc-submission.ts', import.meta.url),
    ).text();
    expect(writeMethods.match(/resolveProcessBatchGasLimit/g)).toHaveLength(3);
    expect(submission.match(/resolveProcessBatchGasLimit/g)).toHaveLength(2);
  });
});
