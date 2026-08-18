import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const runProbe = (source: string) => spawnSync(
  'bun',
  ['core/scripts/checks/fints/check-decoder-authority.ts', '--stdin'],
  { cwd: process.cwd(), encoding: 'utf8', input: source },
);

describe('FinTS decoder authority gate', () => {
  test('rejects exported generic byte decoders without validators', () => {
    const result = runProbe('export const decodeUnsafe = <T>(bytes: Uint8Array): T => bytes as T;');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXPORTED_GENERIC_DECODER_WITHOUT_VALIDATOR');
  });

  test('rejects type arguments and assertions on raw decoders', () => {
    const result = runProbe([
      'declare const bytes: Uint8Array;',
      'decodeBuffer<AccountState>(bytes);',
      'decodeBinaryPayload(bytes) as AccountState;',
      'safeParse<RuntimeInput>("{}");',
      'JSON.parse("{}") as RuntimeInput;',
    ].join('\n'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RAW_DECODER_TYPE_ARGUMENT');
    expect(result.stderr).toContain('UNTRUSTED_DECODE_ASSERTION');
  });

  test('accepts unknown decoding followed by a required validator', () => {
    const result = runProbe([
      'export const decodeChecked = <T>(',
      '  bytes: Uint8Array, validator: (value: unknown) => T,',
      '): T => validator(decodeBinaryPayload(bytes));',
    ].join('\n'));
    expect(result.status).toBe(0);
  });

  test('rejects aliased raw decoders and assignment-then-cast laundering', () => {
    const result = runProbe([
      'import { decodeBuffer as db } from "./codec";',
      'declare const bytes: Uint8Array;',
      'db<AccountState>(bytes);',
      'const parsed = JSON.parse("{}");',
      'const state = parsed as AccountState;',
    ].join('\n'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RAW_DECODER_TYPE_ARGUMENT');
    expect(result.stderr).toContain('UNTRUSTED_DECODE_ASSERTION');
  });
});
