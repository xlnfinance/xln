import { describe, expect, test } from 'bun:test';
import { nativeAmountText, nativeLimitAmounts } from './amount';

describe('native amount entry', () => {
  test('preserves exact fractional units in English and Russian', () => {
    expect(nativeAmountText('0.009997000200000001', '.')).toBe('0.009997000200000001');
    expect(nativeAmountText('0,009997000200000001', ',')).toBe('0.009997000200000001');
  });
  test('never silently interprets grouping or the other locale', () => {
    for (const value of ['1,000', '1 000', '1e3', '-1', '1.2.3', 'NaN', ''])
      expect(() => nativeAmountText(value, '.')).toThrow();
    expect(() => nativeAmountText('1.000', ',')).toThrow();
    expect(() => nativeAmountText('1', ':')).toThrow();
  });
});

const order = (side: string, amount: string, price: string, decimalSeparator = '.') =>
  nativeLimitAmounts({ side, amount, price, decimalSeparator }, 2, 1, 18, 6);

test('buy and sell use exact base size and the shared price conversion', () => {
  expect(order('buy', '0.005', '2500')).toEqual({
    giveToken: 1, wantToken: 2, give: 12_500_000n, want: 5_000_000_000_000_000n,
  });
  expect(order('sell', '0.005', '2500')).toEqual({
    giveToken: 2, wantToken: 1, give: 5_000_000_000_000_000n, want: 12_500_000n,
  });
});

test('Russian order inputs preserve price ticks and token decimals', () => {
  expect(order('buy', '0,005', '2500,1234', ',')).toEqual(order('buy', '0.005', '2500.1234'));
  expect(order('sell', '0.005', '2500.1234').want).toBe(12_500_617n);
});

test('order rejects invalid side, nonpositive values, sub-unit quote and excess price precision', () => {
  expect(() => order('other', '1', '2500')).toThrow('Choose buy or sell.');
  expect(() => order('buy', '0', '2500')).toThrow('greater than zero');
  expect(() => order('buy', '1', '0')).toThrow('greater than zero');
  expect(() => order('buy', '0.000000000000000001', '1')).toThrow('market minimum');
  expect(() => order('buy', '1', '2500.00001')).toThrow('decimal places');
  expect(() => order('buy', '1e3', '2500')).toThrow('valid amount');
});

test('order amounts do not pass through floating point', () => {
  const size = '9007199254.740993';
  expect(order('buy', size, '1').give).toBe(9_007_199_254_740_993n);
});
