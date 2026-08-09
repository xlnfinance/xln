import { expect, test } from 'bun:test';

import { transferFeeAmount } from '../utils/e2e-cross-j-fee-observation';

test('cross-j E2E fee evidence uses one coherent observation', () => {
  expect(transferFeeAmount(7n, 7n)).toBe(7n);
  expect(transferFeeAmount(7n, 0n)).toBe(7n);
  expect(transferFeeAmount(0n, 7n)).toBe(7n);
  expect(() => transferFeeAmount(14n, 7n)).toThrow(
    'TRANSFER_FEE_OBSERVATION_MISMATCH:14:7',
  );
});
