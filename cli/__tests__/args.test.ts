import { describe, expect, test } from 'bun:test';
import { parseArgs, flagNumber, flagString } from '../lib/args';
import { parseHumanAmount } from '../lib/format';
import { assertNoSecretArgv } from '../commands/index';

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

  test('rejects every retired secret argv form before parsing', () => {
    for (const arg of ['--passphrase', '--passphrase=secret', '-p', '-p=secret', '--mnemonic', '--mnemonic=words', '--bv-pass=secret']) {
      expect(() => assertNoSecretArgv(['bun', 'xln', 'onboard', arg])).toThrow('CLI_SECRET_ARG_FORBIDDEN');
    }
    expect(() => assertNoSecretArgv(['bun', 'xln', 'onboard', '--name', 'alice'])).not.toThrow();
  });
});

describe('parseHumanAmount', () => {
  test('parses integer and decimal against token decimals', () => {
    expect(parseHumanAmount('100n', 1)).toBe(100n);
    expect(parseHumanAmount('1', 1)).toBe(parseHumanAmount('1.0', 1));
    expect(parseHumanAmount('1', 1)).toBeGreaterThan(1n);
  });

  test('rejects fractional precision that cannot be represented exactly', () => {
    expect(() => parseHumanAmount('1.0000001', 1)).toThrow();
    expect(() => parseHumanAmount('1.2n', 1)).toThrow('Invalid amount');
  });
});
