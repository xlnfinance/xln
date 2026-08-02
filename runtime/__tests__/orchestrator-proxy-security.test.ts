import { describe, expect, test } from 'bun:test';
import { createOrchestratorProxyHandlers } from '../orchestrator/proxy';

describe('orchestrator proxy security', () => {
  test('marks every generic public child request as proxied', async () => {
    let forwarded = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      forwarded = new Headers(init?.headers).get('forwarded') || '';
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => ({ apiPort: 19001 }) as any,
      });
      const response = await handlers.proxyAnyHubRequest(
        new Request('http://xln.local/api/future-public-route'),
        '/api/future-public-route',
      );

      expect(response.status).toBe(200);
      expect(forwarded).toBe('for=_xln_public_proxy');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('public hub proxies reject oversized bodies before upstream allocation', async () => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => ({ apiPort: 19001 }) as any,
        getHealthyHub: () => ({ apiPort: 19001 }) as any,
      });
      const oversized = (path: string) => new Request(`http://xln.local${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(1024 * 1024 + 1),
        },
        body: '{}',
      });

      const explicit = await handlers.proxyHubApi(
        oversized('/api/faucet/offchain'),
        '/api/faucet/offchain',
      );
      const generic = await handlers.proxyAnyHubRequest(
        oversized('/api/faucet/gas'),
        '/api/faucet/gas',
      );

      expect(explicit.status).toBe(413);
      expect(generic.status).toBe(413);
      expect(await explicit.text()).toContain('HUB_FAUCET_PROXY_BODY_TOO_LARGE');
      expect(await generic.text()).toContain('HUB_API_PROXY_BODY_TOO_LARGE');
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('public rpc failures never expose credential-bearing upstream URLs', async () => {
    const apiKey = 'sentinel-rpc-api-key';
    const upstream = `https://rpc.invalid/${apiKey}?token=${apiKey}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error(`fetch failed for ${upstream}`);
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: upstream,
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => null,
      });
      const response = await handlers.proxyRpc(new Request('http://127.0.0.1/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
      }));
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(text).toContain('RPC upstream request failed');
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain('rpc.invalid');
      expect(text).not.toContain('"upstream"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('on-chain faucet allows mining without weakening the generic hub timeout', async () => {
    const previousHubTimeout = process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'];
    const previousFaucetTimeout = process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'];
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(60);
        return Response.json({ success: true });
      },
    });
    process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'] = '25';
    process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'] = '100';
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => ({ apiPort: server.port }) as any,
      });
      const request = (endpoint: string) => new Request(`http://xln.local${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const genericResponse = await handlers.proxyAnyHubRequest(request('/api/health/slow'), '/api/health/slow');
      expect(genericResponse.status).toBe(502);
      expect(((await genericResponse.json()) as { error?: string }).error).toContain('PROXY_UPSTREAM_TIMEOUT:25');

      const faucetResponse = await handlers.proxyAnyHubRequest(
        request('/api/faucet/erc20?chainId=31337'),
        '/api/faucet/erc20?chainId=31337',
      );
      expect(faucetResponse.status).toBe(200);
      expect(await faucetResponse.json()).toEqual({ success: true });
    } finally {
      if (previousHubTimeout === undefined) delete process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'];
      else process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'] = previousHubTimeout;
      if (previousFaucetTimeout === undefined) delete process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'];
      else process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'] = previousFaucetTimeout;
      await server.stop(true);
    }
  }, 2_000);

  test('generic hub API exposes typed no-healthy-hub failure', async () => {
    let pollCalls = 0;
    const handlers = createOrchestratorProxyHandlers({
      host: '127.0.0.1',
      defaultRpcUrl: '',
      pollAllHubHealth: async () => {
        pollCalls += 1;
      },
      getHubChildByEntityId: () => null,
      getHealthyHub: () => null,
    });

    const response = await handlers.proxyAnyHubRequest(
      new Request('http://xln.local/api/faucet/gas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId: `0x${'34'.repeat(32)}` }),
      }),
      '/api/faucet/gas',
    );
    const body = (await response.json()) as {
      category?: string;
      code?: string;
      error?: string;
      failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
      retryable?: boolean;
      fatal?: boolean;
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe('No healthy hub API available');
    expect(body.code).toBe('NO_HEALTHY_HUB_API_AVAILABLE');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'NO_HEALTHY_HUB_API_AVAILABLE',
      retryable: true,
      fatal: false,
    });
    expect(pollCalls).toBe(1);
  });
});
