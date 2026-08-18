import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isOperatorRequest,
  loadOrCreateOperatorToken,
  operatorPreflightResponse,
} from '../../../orchestrator/hub/operator-access';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('operator access', () => {
  test('does not expose authenticated Runtime presence as a public API', () => {
    const server = readFileSync(join(process.cwd(), 'core/api/server/index.ts'), 'utf8');
    const e2eReadiness = readFileSync(join(process.cwd(), 'tests/utils/e2e-connect.ts'), 'utf8');
    expect(server).not.toContain("pathname === '/api/clients'");
    expect(e2eReadiness).not.toContain("fetch('/api/clients'");
  });

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
    expect(isOperatorRequest(
      new Request('http://127.0.0.1:8080/api/runtime-import', {
        headers: { origin: 'http://localhost:8081' },
      }),
      '127.0.0.1',
      token,
    )).toBe(true);
    expect(isOperatorRequest(
      new Request('http://127.0.0.1:8080/api/runtime-import', {
        headers: { origin: 'https://attacker.example' },
      }),
      '127.0.0.1',
      token,
    )).toBe(false);
    expect(isOperatorRequest(
      new Request('http://127.0.0.1:8080/api/runtime-import', {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://operator-console.example',
        },
      }),
      '203.0.113.5',
      token,
    )).toBe(true);
  });

  test('allows CORS preflight but rejects every private node route before handling', async () => {
    const options = operatorPreflightResponse(
      new Request('https://xln.finance/api/debug/dumps', { method: 'OPTIONS' }),
      new URL('https://xln.finance/api/debug/dumps'),
      false,
    );
    expect(options?.status).toBe(200);
    expect(options?.headers.get('access-control-allow-origin')).toBe('*');

    for (const path of [
      '/api/debug/dumps',
      '/api/debug/entities',
      '/api/debug/reserve',
      '/api/debug/activity',
      '/api/debug/relay',
      '/api/debug/events',
      '/api/debug/incidents',
      '/api/credit/request',
      '/api/runtime-import',
      '/api/control/p2p/stop',
    ]) {
      const request = new Request(`https://xln.finance${path}`);
      const denied = operatorPreflightResponse(request, new URL(request.url), false);
      expect(denied?.status).toBe(403);
      expect(await denied?.json()).toEqual({ error: 'Operator access required' });
    }
    expect(operatorPreflightResponse(
      new Request('https://xln.finance/api/debug/dumps'),
      new URL('https://xln.finance/api/debug/dumps'),
      true,
    )).toBeNull();
    for (const path of ['/api/hubs', '/api/gossip/profile']) {
      const request = new Request(`https://xln.finance${path}`);
      expect(operatorPreflightResponse(request, new URL(request.url), false)).toBeNull();
    }
  });
});
