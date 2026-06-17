import { describe, expect, test } from 'bun:test';

import {
  J_BATCH_CONTRACT_LIMITS,
  assertJBatchWithinContractLimits,
  batchAddRevealSecret,
  createEmptyBatch,
  getJBatchContractLimitIssue,
  initJBatch,
} from '../j-batch';

const transformer = `0x${'11'.repeat(20)}`;
const secret = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

describe('j-batch contract limits', () => {
  test('mirrors Depository MAX_BATCH_SECRET_REVEALS before submission', () => {
    expect(J_BATCH_CONTRACT_LIMITS.maxSecretReveals).toBe(32);
    const batch = createEmptyBatch();
    for (let index = 0; index < J_BATCH_CONTRACT_LIMITS.maxSecretReveals; index += 1) {
      batch.revealSecrets.push({ transformer, secret: secret(index + 1) });
    }

    expect(getJBatchContractLimitIssue(batch)).toBeNull();
    assertJBatchWithinContractLimits(batch, 'revealSecrets max');

    batch.revealSecrets.push({ transformer, secret: secret(999) });

    expect(getJBatchContractLimitIssue(batch)).toBe('revealSecrets 33/32');
    expect(() => assertJBatchWithinContractLimits(batch, 'revealSecrets max')).toThrow(
      'J_BATCH_LIMIT_EXCEEDED: revealSecrets max: revealSecrets 33/32',
    );
  });

  test('batchAddRevealSecret rejects the 33rd unique reveal even though total ops allows it', () => {
    const state = initJBatch();
    for (let index = 0; index < J_BATCH_CONTRACT_LIMITS.maxSecretReveals; index += 1) {
      batchAddRevealSecret(state, transformer, secret(index + 1));
    }

    expect(state.batch.revealSecrets).toHaveLength(32);
    expect(() => batchAddRevealSecret(state, transformer, secret(33))).toThrow(
      'J_BATCH_LIMIT_EXCEEDED: revealSecrets 33/32',
    );
    expect(state.batch.revealSecrets).toHaveLength(32);
  });
});
