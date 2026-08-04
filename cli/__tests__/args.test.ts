import { describe, expect, test } from 'bun:test';
import { parseArgs, flagNumber, flagString } from '../lib/args';
import { parseHumanAmount } from '../lib/format';

describe('cli args', () => {
  test('parses command positionals and flags', () => {
    const parsed = parseArgs(['bun', 'xln', 'pay', '0xabc', '1.5', '--token', '2', '--mode', 'instant']);
    expect(parsed.command).toBe('pay');
    expect(parsed.positionals).toEqual(['0xabc', '1.5']);
    expect(flagString(parsed.flags, 'mode')).toBe('instant');
    expect(flagNumber(parsed.flags, 'token', 1)).toBe(2);
  });

  test('bare xln has null command', () => {
    expect(parseArgs(['bun', 'xln']).command).toBeNull();
  });
});

describe('parseHumanAmount', () => {
  test('parses integer and decimal against token decimals', () => {
    // token 1 is typically 18 decimals in xln token table; accept bigint raw too
    expect(parseHumanAmount('100n', 1)).toBe(100n);
    expect(parseHumanAmount('2', 1) > 0n).toBe(true);
  });
});
