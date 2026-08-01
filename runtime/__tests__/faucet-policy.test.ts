import { describe, expect, test } from 'bun:test';
import { enforceFaucetPolicy } from '../api/server/faucet-policy';

const request = (path: string, amount?: unknown): Request =>
  new Request(`https://node.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(amount === undefined ? {} : { amount }),
  });

describe('public faucet policy', () => {
  test('is deny-by-default for anonymous callers and permits local operators', async () => {
    expect((await enforceFaucetPolicy(request('/api/faucet/offchain'), false, {}))?.status).toBe(404);
    expect(await enforceFaucetPolicy(request('/api/faucet/offchain', '2000'), true, {})).toBeNull();
    expect(await enforceFaucetPolicy(request('/api/faucet/offchain'), false, {
      XLN_PUBLIC_FAUCET: '1',
    })).toBeNull();
  });

  test('enforces exact server-owned request caps on every faucet route', async () => {
    const env = { XLN_PUBLIC_FAUCET: '1' };
    for (const path of ['/api/faucet/erc20', '/api/faucet/reserve', '/api/faucet/offchain']) {
      expect(await enforceFaucetPolicy(request(path, '100.000'), false, env)).toBeNull();
      expect((await enforceFaucetPolicy(request(path, '100.000000000000000001'), false, env))?.status).toBe(413);
    }
    expect(await enforceFaucetPolicy(request('/api/faucet/gas', '0.1'), false, env)).toBeNull();
    expect((await enforceFaucetPolicy(request('/api/faucet/gas', '0.100000000000000001'), false, env))?.status).toBe(413);
  });

  test('rejects invalid and non-positive amounts before faucet execution', async () => {
    const env = { XLN_PUBLIC_FAUCET: '1' };
    for (const amount of ['0', '-1', '1e2', 'not-a-number', [100], [[100]], {
      toString: null,
      valueOf: null,
    }]) {
      expect((await enforceFaucetPolicy(request('/api/faucet/erc20', amount), false, env))?.status).toBe(400);
    }
  });
});
