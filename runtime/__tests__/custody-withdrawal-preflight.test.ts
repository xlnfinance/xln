import { describe, expect, test } from 'bun:test';
import {
  assertWithdrawalWithinDisplayedBalance,
  parseDisplayAmountMinor,
} from '../../custody/static/withdrawal-preflight.js';

describe('custody withdrawal browser preflight', () => {
  test('parses human amounts using the exact token decimals', () => {
    expect(parseDisplayAmountMinor('1', 6)).toBe(1_000_000n);
    expect(parseDisplayAmountMinor('1.000001', 6)).toBe(1_000_001n);
    expect(parseDisplayAmountMinor('0.000000000000000001', 18)).toBe(1n);
  });

  test('rejects amounts above the displayed authoritative minor-unit balance', () => {
    expect(() => assertWithdrawalWithinDisplayedBalance('1', {
      decimals: 6,
      amountMinor: '0',
    })).toThrow('Insufficient custody balance');
    expect(() => assertWithdrawalWithinDisplayedBalance('1.000001', {
      decimals: 6,
      amountMinor: '1000000',
    })).toThrow('Insufficient custody balance');
  });

  test('accepts the exact displayed balance and rejects malformed projections', () => {
    expect(() => assertWithdrawalWithinDisplayedBalance('1', {
      decimals: 6,
      amountMinor: '1000000',
    })).not.toThrow();
    expect(() => assertWithdrawalWithinDisplayedBalance('0.0000001', {
      decimals: 6,
      amountMinor: '1000000',
    })).toThrow('Amount supports at most 6 decimal places');
    expect(() => assertWithdrawalWithinDisplayedBalance('1', {
      decimals: 6,
      amountMinor: '-1',
    })).toThrow('Invalid custody balance');
  });
});
