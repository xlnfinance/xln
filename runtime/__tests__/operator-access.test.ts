import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOperatorRequest, loadOrCreateOperatorToken } from '../orchestrator/operator-access';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('operator access', () => {
  test('persists generated capabilities with owner-only permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xln-operator-token-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'operator-token');

    const first = loadOrCreateOperatorToken(path);
    const second = loadOrCreateOperatorToken(path);

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('rejects spoofed local headers and accepts only socket-local or bearer authority', () => {
    const token = 'a'.repeat(64);
    const spoofed = new Request('http://127.0.0.1:8080/api/runtime-import', {
      headers: { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    });
    expect(isOperatorRequest(spoofed, '203.0.113.5', token)).toBe(false);
    expect(isOperatorRequest(spoofed, '127.0.0.1', token)).toBe(false);
    expect(isOperatorRequest(
      new Request('https://xln.finance/api/runtime-import', {
        headers: { authorization: `Bearer ${token}` },
      }),
      '203.0.113.5',
      token,
    )).toBe(true);
    expect(isOperatorRequest(
      new Request('http://127.0.0.1:8080/api/runtime-import'),
      '127.0.0.1',
      token,
    )).toBe(true);
  });
});
