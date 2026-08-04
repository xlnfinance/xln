import { describe, expect, test } from 'bun:test';

import { deriveDelta } from '../../runtime/account/utils';
import { findViolations } from '../../runtime/scripts/check-no-manual-delta-math';
import type { Delta } from '../../runtime/types/account';

const makeDelta = (partial: Partial<Delta>): Delta => ({
  tokenId: partial.tokenId ?? 1,
  collateral: partial.collateral ?? 0n,
  ondelta: partial.ondelta ?? 0n,
  offdelta: partial.offdelta ?? 0n,
  leftCreditLimit: partial.leftCreditLimit ?? 0n,
  rightCreditLimit: partial.rightCreditLimit ?? 0n,
  leftAllowance: partial.leftAllowance ?? 0n,
  rightAllowance: partial.rightAllowance ?? 0n,
  leftHold: partial.leftHold ?? 0n,
  rightHold: partial.rightHold ?? 0n,
});

describe('frontend delta diagnostics', () => {
  test('preserves historical drawn exposure beyond the current credit limit', () => {
    const derived = deriveDelta(makeDelta({ ondelta: -100n, leftCreditLimit: 20n }), true);

    expect(derived.inOwnCredit).toBe(100n);
    expect(derived.ownCreditLimit).toBe(20n);
    expect(derived.totalCapacity).toBe(100n);
  });

  test('guard detects direct member and local total-delta arithmetic', () => {
    expect(findViolations('tool.ts', 'const total = delta.ondelta + delta.offdelta;')) // DELTA_MATH_ALLOWED: guard self-test fixture
      .toHaveLength(1);
    expect(findViolations('tool.ts', 'const total = ondelta + offdelta;')) // DELTA_MATH_ALLOWED: guard self-test fixture
      .toHaveLength(1);
    expect(findViolations('tool.ts', 'const total = delta.ondelta + delta.offdelta; // DELTA_MATH_ALLOWED'))
      .toEqual([]);
  });
});
