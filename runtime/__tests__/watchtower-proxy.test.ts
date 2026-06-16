import { describe, expect, test } from 'bun:test';

import { handleWatchtowerProxy } from '../server/watchtower-proxy';

describe('watchtower same-origin proxy', () => {
  test('allows public recovery discovery and forwards the request', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({
        ok: true,
        lookupKey: `0x${'11'.repeat(32)}`,
        available: false,
        latestReceipt: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const request = new Request(
        'https://localhost:8080/api/watchtower-proxy?target=http%3A%2F%2F127.0.0.1%3A9100&path=%2Fapi%2Frecovery%2Fdiscover',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lookupKey: `0x${'11'.repeat(32)}` }),
        },
      );
      const response = await handleWatchtowerProxy(request);
      const payload = await response.json() as { ok?: boolean; available?: boolean };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({ ok: true, available: false });
      expect(calls).toEqual([{
        url: 'http://127.0.0.1:9100/api/recovery/discover',
        method: 'POST',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps operator watchtower endpoints blocked', async () => {
    const response = await handleWatchtowerProxy(new Request(
      'https://localhost:8080/api/watchtower-proxy?target=http%3A%2F%2F127.0.0.1%3A9100&path=%2Fapi%2Fwatchtower%2Fsweep',
      { method: 'POST' },
    ));
    const payload = await response.json() as { error?: string; details?: string };

    expect(response.status).toBe(503);
    expect(payload.error).toBe('WATCHTOWER_PROXY_FAILED');
    expect(payload.details).toContain('WATCHTOWER_PROXY_PATH_NOT_ALLOWED');
  });
});
