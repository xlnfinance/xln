import { describe, expect, test } from 'bun:test';

import { getDisputeSealRequirementError } from '../../../account/consensus/dispute/seal';

const body = `0x${'11'.repeat(32)}`;
const otherBody = `0x${'22'.repeat(32)}`;
const seal = (nonce: number, proofBodyHash = body) => ({
  hanko: '0x01',
  nonce,
  hash: `0x${'33'.repeat(32)}`,
  proofBodyHash,
  proposerIsLeft: true,
});

describe('counterparty dispute seal monotonicity', () => {
  test('accepts a fresh seal and an exact unconsumed retry', () => {
    expect(getDisputeSealRequirementError(body, undefined, undefined, 4, seal(5))).toBeUndefined();
    expect(getDisputeSealRequirementError(body, body, 5, 4, seal(5))).toBeUndefined();
  });

  test('rejects finalized, regressing, and same-nonce retargeted seals', () => {
    expect(getDisputeSealRequirementError(body, body, 5, 5, seal(5)))
      .toContain('DISPUTE_SEAL_NONCE_ALREADY_FINALIZED');
    expect(getDisputeSealRequirementError(body, body, 7, 4, seal(6)))
      .toContain('DISPUTE_SEAL_NONCE_REGRESSION');
    expect(getDisputeSealRequirementError(otherBody, body, 5, 4, seal(5, otherBody)))
      .toContain('DISPUTE_SEAL_NONCE_REUSE');
  });
});
