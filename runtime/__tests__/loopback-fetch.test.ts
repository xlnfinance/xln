import { afterEach, expect, test } from 'bun:test';

import { fetchLoopback } from '../orchestrator/loopback-fetch';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('loopback TLS override is scoped to the individual request', async () => {
  const calls: Array<{ input: string; init: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: input instanceof Request ? input.url : String(input), init: (init ?? {}) as Record<string, unknown> });
    return new Response('{}');
  }) as typeof fetch;

  const originalGlobalTls = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  await fetchLoopback('https://127.0.0.1:8087/api/health');
  await fetchLoopback('https://xln.finance/api/health');

  expect(calls[0]?.init['tls']).toEqual({ rejectUnauthorized: false });
  expect(calls[1]?.init['tls']).toBeUndefined();
  expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(originalGlobalTls);
});
