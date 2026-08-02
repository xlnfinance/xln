import { describe, expect, test } from 'bun:test';

import { handleWatchtowerProxy } from '../api/server/watchtower-proxy';

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

  test('normalizes receipt paths before applying the public allowlist', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('unexpected');
    }) as typeof fetch;

    try {
      const response = await handleWatchtowerProxy(new Request(
        'https://localhost:8080/api/watchtower-proxy?' +
          'target=http%3A%2F%2F127.0.0.1%3A9100&' +
          'path=%2Fapi%2Ftower%2Freceipt%2F..%2F..%2F..%2Fapi%2Fcontrol%2Fp2p%2Fstop',
        { method: 'POST' },
      ));
      const payload = await response.json() as { details?: string };

      expect(response.status).toBe(503);
      expect(payload.details).toContain('WATCHTOWER_PROXY_PATH_NOT_ALLOWED');
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects caller-selected loopback ports outside the operator allowlist', async () => {
    const response = await handleWatchtowerProxy(new Request(
      'https://localhost:8080/api/watchtower-proxy?' +
        'target=http%3A%2F%2F127.0.0.1%3A8080&path=%2Fapi%2Ftower%2Fhealthz',
    ));
    const payload = await response.json() as { details?: string };

    expect(response.status).toBe(503);
    expect(payload.details).toContain('WATCHTOWER_PROXY_PORT_NOT_ALLOWED');
  });

  test('allows signed public push registration paths', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ ok: true, updatedAt: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const request = new Request(
        'https://localhost:8080/api/watchtower-proxy?target=http%3A%2F%2F127.0.0.1%3A9100&path=%2Fapi%2Fpush%2Fregister',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'push_registration' }),
        },
      );
      const response = await handleWatchtowerProxy(request);
      const payload = await response.json() as { ok?: boolean; updatedAt?: number };

      expect(response.status).toBe(200);
      expect(payload).toEqual({ ok: true, updatedAt: 123 });
      expect(calls).toEqual([{
        url: 'http://127.0.0.1:9100/api/push/register',
        method: 'PUT',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects oversized upstream responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('oversized', {
      headers: { 'content-length': String(9 * 1024 * 1024) },
    })) as typeof fetch;

    try {
      const response = await handleWatchtowerProxy(new Request(
        'https://localhost:8080/api/watchtower-proxy?' +
          'target=http%3A%2F%2F127.0.0.1%3A9100&path=%2Fapi%2Ftower%2Fhealthz',
      ));
      const payload = await response.json() as { details?: string };

      expect(response.status).toBe(503);
      expect(payload.details).toContain('RPC_PROXY_RESPONSE_TOO_LARGE');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
