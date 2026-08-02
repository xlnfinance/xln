import { expect, test } from 'bun:test';

import { reconcileProcessedBatchFailure } from '../jurisdiction/adapter/rpc-submission';
import type { JSubmitResult } from '../jurisdiction/adapter/types';

const failure: JSubmitResult = {
  success: false,
  error: 'staticCall revert: E2()',
  failure: { category: 'terminal', code: 'CALL_EXCEPTION', message: 'staticCall revert: E2()' },
};

const input = (hasProcessedBatch: () => Promise<boolean>) => ({
  receipts: { hasProcessedBatch },
  entityId: `0x${'11'.repeat(32)}`,
  batchHash: `0x${'22'.repeat(32)}`,
  entityNonce: 7n,
  failure,
});

test('exact mined batch receipt reconciles a lost submission result', async () => {
  expect(await reconcileProcessedBatchFailure(input(async () => true))).toEqual({ success: true });
});

test('different consumed batch preserves the original terminal failure', async () => {
  expect(await reconcileProcessedBatchFailure(input(async () => false))).toBe(failure);
});

test('unavailable receipt authority remains unknown instead of terminal', async () => {
  const result = await reconcileProcessedBatchFailure(input(async () => {
    const error = new Error('request timeout');
    Object.assign(error, { code: 'TIMEOUT' });
    throw error;
  }));
  expect(result).toMatchObject({
    success: false,
    failure: { category: 'transient', code: 'TIMEOUT' },
  });
});
