import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

describe('ESLint fintech ratchet', () => {
  test('rejects raw JSON.stringify in new runtime code', () => {
    const result = spawnSync(
      'bunx',
      ['eslint', '--stdin', '--stdin-filename', 'core/__lint-probe__.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: 'export const encoded = JSON.stringify({ amount: 1n });\n',
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('no-restricted-properties');
    expect(`${result.stdout}${result.stderr}`).toContain('safeStringify');
  });

  test('accepts the canonical serializer boundary', () => {
    const result = spawnSync(
      'bunx',
      ['eslint', '--stdin', '--stdin-filename', 'core/__lint-probe__.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        input: "import { safeStringify } from './utils/serialization-utils';\nexport const encoded = safeStringify({ amount: 1n });\n",
      },
    );

    expect(result.status).toBe(0);
  });
});
