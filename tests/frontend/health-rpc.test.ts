import { describe, expect, test } from 'bun:test';

import { probeRpcHealth } from '../../frontend/src/lib/health/rpcHealth';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });

describe('health rpc probe', () => {
  test('retries transient browser fetch failures before reporting rpc healthy', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let clock = 100;

    const result = await probeRpcHealth({
      attempts: 3,
      retryDelayMs: 25,
      now: () => {
        clock += 5;
        return clock;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error('Failed to fetch');
        return jsonResponse({ result: '0x7a69' });
      }) as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      error: null,
      latencyMs: 5,
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([25]);
  });

  test('keeps final rpc failure loud after bounded retries', async () => {
    let calls = 0;
    const result = await probeRpcHealth({
      attempts: 2,
      retryDelayMs: 0,
      now: () => 1,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ error: 'upstream down' }, { status: 503 });
      }) as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      error: 'HTTP 503',
      status: 503,
    });
    expect(calls).toBe(2);
  });

  test('treats malformed rpc response as unhealthy', async () => {
    const result = await probeRpcHealth({
      attempts: 1,
      fetchImpl: (async () => jsonResponse({ error: { message: 'missing chain id' } })) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(JSON.stringify({ message: 'missing chain id' }));
    expect(result.body).toEqual({ error: { message: 'missing chain id' } });
  });
});
