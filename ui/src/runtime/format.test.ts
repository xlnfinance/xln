import { expect, test } from 'bun:test';
import { parseAmount } from './format';

test('amount input never reinterprets a comma', () => {
  expect(parseAmount('1.5', 6)).toBe(1_500_000n);
  expect(() => parseAmount('1,5', 6)).toThrow('Enter a valid amount');
  expect(() => parseAmount('1,,2', 6)).toThrow('Enter a valid amount');
  expect(() => parseAmount('1,000', 6)).toThrow('Enter a valid amount');
});
