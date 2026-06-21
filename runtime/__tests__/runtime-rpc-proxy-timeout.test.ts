import { describe, expect, test } from 'bun:test';
import { createRelayStore } from '../relay-store';
import { handleRuntimeRpcProxy } from '../server/rpc-proxy';

describe('runtime RPC proxy timeouts', () => {
  test('fails fast when configured upstream never responds', async () => {
    const previousTimeout = process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
    const previousUpstream = process.env['RPC_UPSTREAM_URL'];
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = '25';
    process.env['RPC_UPSTREAM_URL'] = `http://127.0.0.1:${server.port}`;
    try {
      const startedAt = performance.now();
      const response = await handleRuntimeRpcProxy({
        req: new Request('http://127.0.0.1/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
        }),
        pathname: '/rpc',
        env: null,
        relayStore: createRelayStore('test'),
        headers: { 'content-type': 'application/json' },
      });
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(502);
      expect(body.error).toContain('RPC_PROXY_TIMEOUT:25');
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
      } else {
        process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = previousTimeout;
      }
      if (previousUpstream === undefined) {
        delete process.env['RPC_UPSTREAM_URL'];
      } else {
        process.env['RPC_UPSTREAM_URL'] = previousUpstream;
      }
      await server.stop(true);
    }
  }, 2_000);
});
