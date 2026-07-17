import { describe, expect, test } from 'bun:test';

import {
  parseTokenAmountInput,
  tokenAmountInputErrorMessage,
} from '../../frontend/src/lib/components/Entity/token-amount-input';

describe('token amount input', () => {
  test('encodes exact six-decimal amounts without changing precision', () => {
    expect(parseTokenAmountInput('1', 6)).toBe(1_000_000n);
    expect(parseTokenAmountInput('1.000001', 6)).toBe(1_000_001n);
  });

  test('rejects precision loss instead of truncating user money', () => {
    expect(() => parseTokenAmountInput('1.0000001', 6))
      .toThrow('TOKEN_AMOUNT_PRECISION_EXCEEDED:7:6');
  });

  test('rejects malformed, zero, invalid-decimal and overflowing values', () => {
    for (const value of ['', '0', '-1', '+1', '.1', '1.', '01', '1e6']) {
      expect(() => parseTokenAmountInput(value, 6)).toThrow();
    }
    expect(() => parseTokenAmountInput('1', -1)).toThrow('TOKEN_AMOUNT_DECIMALS_INVALID');
    expect(() => parseTokenAmountInput('1', 256)).toThrow('TOKEN_AMOUNT_DECIMALS_INVALID');
    expect(() => parseTokenAmountInput((1n << 256n).toString(), 0))
      .toThrow('TOKEN_AMOUNT_UINT256_OVERFLOW');
  });

  test('shows actionable payment errors instead of protocol codes', () => {
    expect(tokenAmountInputErrorMessage(new Error('TOKEN_AMOUNT_PRECISION_EXCEEDED:7:6')))
      .toBe('Amount supports at most 6 decimal places');
    expect(tokenAmountInputErrorMessage(new Error('TOKEN_AMOUNT_DECIMALS_INVALID:NaN')))
      .toBe('Token precision is unavailable');
  });
});
