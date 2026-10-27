import { expect, test } from 'bun:test';
import { formatLimit, parseAmount } from './format';

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
