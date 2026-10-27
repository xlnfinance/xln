import { expect, test } from 'bun:test';
import { formatLimit, formatMoney, parseAmount } from './format';

test('amount input never reinterprets a comma', () => {
  expect(parseAmount('1.5', 6)).toBe(1_500_000n);
  expect(() => parseAmount('1,5', 6)).toThrow('Enter a valid amount');
  expect(() => parseAmount('1,,2', 6)).toThrow('Enter a valid amount');
  expect(() => parseAmount('1,000', 6)).toThrow('Enter a valid amount');
});

test('limits round toward zero and keep precision below one whole token', () => {
  expect(formatLimit(94_999_995n, 6)).toBe('94.99');
  expect(formatLimit(15_990_401_119_712_116n, 18)).toBe('0.01599');
  expect(formatLimit(500_000n, 6)).toBe('0.50');
  expect(formatLimit(0n, 6)).toBe('0.00');
});

test('money below one whole token keeps its significant places', () => {
  expect(formatMoney(5_000_000_000_000_000n, 18)).toBe('0.005');
  expect(formatMoney(4_000n, 6)).toBe('0.004');
  expect(formatMoney(500_000n, 6)).toBe('0.50');
  expect(formatMoney(12_345_678n, 6)).toBe('12.35');
  expect(formatMoney(0n, 6)).toBe('0.00');
  expect(formatMoney(-5_000_000_000_000_000n, 18)).toBe('−0.005');
});
